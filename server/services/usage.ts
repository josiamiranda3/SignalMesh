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
  /** userId → operation → promise of the in-flight operation token */
  private readonly inFlight = new Map<string, string>()

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
   * Reserve capacity for an operation. Throws `quota_exceeded`,
   * `external_disabled` or `rate_limited` when the request must not proceed.
   * The returned token must be settled with `settle()`.
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
    if (this.config.paidOperationsEnabled) {
      // Paid mode is a deliberate owner decision; the free-tier path is the
      // default. Nothing extra is required beyond the daily limits below.
    }

    const inFlightKey = `${input.ownerId}:${input.operation}`
    if (this.inFlight.has(inFlightKey)) {
      throw errors.rateLimited(
        'Já existe uma operação deste tipo em andamento para este usuário. Aguarde a conclusão antes de iniciar outra.',
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

    const token = createId('op')
    this.inFlight.set(inFlightKey, token)
    return { token }
  }

  /** Release the in-flight slot without recording consumption (validation failure). */
  release(input: { ownerId: string; operation: UsageOperation; token: string }): void {
    const key = `${input.ownerId}:${input.operation}`
    if (this.inFlight.get(key) === input.token) this.inFlight.delete(key)
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
    this.release(input)
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
