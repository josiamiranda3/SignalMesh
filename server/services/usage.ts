import type { AppConfig } from '../config.ts'
import type { Provider, QuotaState, UsageOperation, UsageQuotaSnapshot, UsageRecord } from '../../shared/domain.ts'
import type { Repositories } from '../repositories/ports.ts'
import { AppError, errors } from '../lib/errors.ts'
import { createId, nextUtcMidnight, nowIso, startOfUtcDay } from '../lib/util.ts'

/**
 * Cost protection.
 *
 * This service is the ONLY gate in front of a metered provider call. It is
 * evaluated in the backend on every request; the frontend's counters are
 * advisory only. It enforces four independent limits plus a duplicate guard:
 *
 *   1. per-user daily limit for the operation
 *   2. global (all users) daily limit for the operation
 *   3. a single in-flight operation per user, so a double click cannot spend
 *      twice
 *   4. a duplicate-query guard for identical research requests
 *
 * Every attempt — allowed, blocked or failed — is written to `usage_records`,
 * so the operator can audit consumption after the fact.
 */
export class UsageService {
  constructor(
    private readonly repos: Repositories,
    private readonly config: AppConfig,
  ) {}

  limits(operation: UsageOperation): { perUser: number; global: number } {
    return operation === 'research'
      ? { perUser: this.config.researchDailyLimit, global: this.config.researchGlobalDailyLimit }
      : { perUser: this.config.analysisDailyLimit, global: this.config.analysisGlobalDailyLimit }
  }

  providerFor(operation: UsageOperation): Provider {
    return operation === 'research' ? 'exa' : 'gemini'
  }

  async snapshot(ownerId: string): Promise<UsageQuotaSnapshot> {
    const since = startOfUtcDay().toISOString()
    const resetsAt = nextUtcMidnight().toISOString()

    const [researchUsed, analysisUsed] = await Promise.all([
      this.repos.usage.countInWindow(ownerId, 'research', since),
      this.repos.usage.countInWindow(ownerId, 'analysis', since),
    ])

    const researchLimit = this.config.researchDailyLimit
    const analysisLimit = this.config.analysisDailyLimit

    return {
      research: buildQuotaState(researchUsed, researchLimit, resetsAt),
      analysis: buildQuotaState(analysisUsed, analysisLimit, resetsAt),
      externalApisEnabled: this.config.externalApisEnabled,
      paidOperationsEnabled: this.config.paidOperationsEnabled,
    }
  }

  /**
   * Reserve capacity for an operation. Throws `external_disabled`,
   * `quota_exceeded` or `rate_limited` when the request must not proceed.
   * The returned token must be settled with `settle()`.
   *
   * ## The two gates, and why both run first
   *
   * `reserve()` is the only path through which Exa or Gemini can be reached:
   * `research.ts` and `analysis.ts` both call it before their single outbound
   * request. Putting the cost gates here — rather than in the providers or the
   * routes — means a new caller cannot reach a paid provider by forgetting a
   * check, and a blocked request consumes no quota because nothing has been
   * counted or reserved yet.
   *
   *  - `ENABLE_EXTERNAL_APIS` — is any outbound call allowed at all?
   *  - `ENABLE_PAID_OPERATIONS` — is a call that *may cost money* allowed?
   *
   * The second gate is not redundant. Until v0.2.4.3 it was an empty `if`, so
   * `ENABLE_EXTERNAL_APIS=true` with `ENABLE_PAID_OPERATIONS=false` still issued
   * billed requests — the opposite of what the switch name promises. Now that
   * pair means "external reads allowed, spending not authorised", and every
   * operation this app performs is billable at the provider.
   */
  async reserve(input: {
    ownerId: string
    operation: UsageOperation
    investigationId: string | null
  }): Promise<{ token: string }> {
    if (!this.config.externalApisEnabled) {
      throw errors.externalDisabled(
        'As chamadas externas estão desativadas globalmente (ENABLE_EXTERNAL_APIS=false).',
      )
    }

    if (!this.config.paidOperationsEnabled) {
      // Singular: `labelFor` returns the plural used by the quota messages
      // ("limite de pesquisas"), which reads wrong in "A pesquisas não foi…".
      const operation = input.operation === 'research' ? 'pesquisa' : 'análise'
      throw errors.externalDisabled(
        `Operações que podem gerar cobrança estão desabilitadas (ENABLE_PAID_OPERATIONS=false). ` +
          `A ${operation} não foi executada e nenhuma cota foi consumida.`,
      )
    }

    const since = startOfUtcDay().toISOString()
    const limits = this.limits(input.operation)

    const [userUsed, globalUsed] = await Promise.all([
      this.repos.usage.countInWindow(input.ownerId, input.operation, since),
      this.repos.usage.countInWindow(null, input.operation, since),
    ])

    if (limits.perUser <= 0) {
      await this.recordBlocked(input, 'per_user_limit_zero', 'Limite diário desativado para esta operação')
      throw errors.quotaExceeded(
        `O limite diário de ${labelFor(input.operation)} está desativado por configuração.`,
      )
    }
    if (userUsed >= limits.perUser) {
      await this.recordBlocked(input, 'per_user_limit', `Limite diário por usuário atingido (${limits.perUser})`)
      throw errors.quotaExceeded(
        `Limite diário de ${labelFor(input.operation)} atingido (${limits.perUser}). O contador reinicia à meia-noite UTC (${nextUtcMidnight().toISOString()}).`,
      )
    }
    if (globalUsed >= limits.global) {
      await this.recordBlocked(input, 'global_limit', `Limite global diário atingido (${limits.global})`)
      throw errors.quotaExceeded(
        `Limite global diário de ${labelFor(input.operation)} atingido (${limits.global}). Nenhuma nova chamada ao provedor será feita hoje.`,
      )
    }

    // Last step: take the exclusive slot.
    //
    // This runs after the counting checks so a refusal never leaves a
    // reservation behind, and it is a single INSERT whose uniqueness is enforced
    // by the storage (unique index / `uniqueOn`), not by a read-then-write check
    // — the previous in-memory `Map` could not survive a per-request service
    // instance and could not see another isolate's reservation.
    const token = createId('op')
    const reservation = await this.repos.reservations.acquire({
      ownerId: input.ownerId,
      operation: input.operation,
      token,
      expiresAt: Date.now() + this.reservationTtlMs(),
      createdAt: nowIso(),
    })
    if (!reservation) {
      throw errors.rateLimited(
        'Já existe uma operação deste tipo em andamento para este usuário. Aguarde a conclusão antes de iniciar outra.',
      )
    }

    return { token }
  }

  /**
   * How long a reservation may live before another request may reclaim it.
   *
   * Derived from the provider timeout with a margin, so a request that dies
   * without releasing (isolate eviction, crash) does not lock the user out
   * beyond the window in which it could plausibly still be running.
   */
  private reservationTtlMs(): number {
    const providerTimeout =
      Math.max(this.config.exaTimeoutMs, this.config.geminiTimeoutMs) || 60_000
    return providerTimeout + 30_000
  }

  /**
   * Release the reservation without recording consumption.
   *
   * Async because the slot now lives in storage. Called by `settle()` and by
   * callers that abandon a reservation before contacting a provider.
   */
  async release(input: { ownerId: string; operation: UsageOperation; token: string }): Promise<void> {
    try {
      await this.repos.reservations.release({
        ownerId: input.ownerId,
        operation: input.operation,
        token: input.token,
      })
    } catch {
      // Releasing must never mask the error that caused it. An unreleased
      // reservation expires on its own via `expiresAt`.
    }
  }

  /** Release the slot and persist the outcome of the attempt. */
  async settle(input: {
    ownerId: string
    operation: UsageOperation
    token: string
    status: 'success' | 'error'
    investigationId: string | null
    quantity?: number
    errorCode?: string | null
    metadata?: Record<string, unknown>
  }): Promise<UsageRecord> {
    await this.release(input)
    const record: UsageRecord = {
      id: createId('use'),
      ownerId: input.ownerId,
      provider: this.providerFor(input.operation),
      operation: input.operation,
      status: input.status,
      quantity: input.quantity ?? 1,
      investigationId: input.investigationId,
      errorCode: input.errorCode ?? null,
      metadata: input.metadata ?? {},
      createdAt: nowIso(),
    }
    return this.repos.usage.create(record)
  }

  async listForOwner(ownerId: string, limit = 50): Promise<UsageRecord[]> {
    return this.repos.usage.listByOwner(ownerId, limit)
  }

  /** True when the same query ran inside the duplicate-guard window. */
  async isDuplicateQuery(ownerId: string, queryHash: string): Promise<{ duplicate: boolean; lastRunAt: string | null }> {
    const latest = await this.repos.researchQueries.latestByHash(ownerId, queryHash)
    if (!latest) return { duplicate: false, lastRunAt: null }
    const ageSeconds = (Date.now() - new Date(latest.createdAt).getTime()) / 1000
    return { duplicate: ageSeconds < this.config.duplicateGuardSeconds, lastRunAt: latest.createdAt }
  }

  /** Record a query so the duplicate guard can see it. */
  async recordQuery(input: {
    investigationId: string
    ownerId: string
    queryHash: string
    query: string
    resultCount: number
    providerRequest: string | null
  }): Promise<void> {
    await this.repos.researchQueries.record({ id: createId('rq'), createdAt: nowIso(), ...input })
  }

  /** Write a blocked attempt so the operator can see refusals too. */
  async recordBlocked(
    input: { ownerId: string; operation: UsageOperation; investigationId: string | null },
    code: string,
    message: string,
  ): Promise<void> {
    try {
      await this.repos.usage.create({
        id: createId('use'),
        ownerId: input.ownerId,
        provider: this.providerFor(input.operation),
        operation: input.operation,
        status: 'blocked',
        quantity: 0,
        investigationId: input.investigationId,
        errorCode: code,
        metadata: { message },
        createdAt: nowIso(),
      })
    } catch {
      // Recording a refusal must never turn a clean 429 into a 500.
    }
  }

  /** Translate a provider/AppError into the recorded outcome. */
  static errorCodeFor(error: unknown): string {
    return error instanceof AppError ? error.code : 'internal_error'
  }
}

function buildQuotaState(used: number, limit: number, resetsAt: string): QuotaState {
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    resetsAt,
  }
}

function labelFor(operation: UsageOperation): string {
  return operation === 'research' ? 'pesquisas' : 'análises'
}
