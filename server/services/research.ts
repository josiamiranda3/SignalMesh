import { createHash } from 'node:crypto'
import type { ResearchResponse, ResearchResultItem } from '../../shared/api.ts'
import type { ResearchRequestInput } from '../../shared/schemas.ts'
import { previewScore } from '../../shared/relevance.ts'
import type { Repositories } from '../repositories/ports.ts'
import { normalizeUrl } from '../lib/util.ts'
import { AppError, errors } from '../lib/errors.ts'
import type { ExaClient } from '../integrations/exa.ts'
import type { ActivityService } from './activity.ts'
import type { InvestigationService } from './investigations.ts'
import { UsageService } from './usage.ts'

/**
 * External research orchestration.
 *
 * Flow for one search:
 *   1. ownership check on the investigation
 *   2. quota reservation (per-user + global + single-flight)
 *   3. duplicate-query guard (unless the user explicitly repeats)
 *   4. provider call
 *   5. usage settlement (success or classified failure)
 *   6. activity entry
 *
 * A failed call is recorded and surfaced; it is never replaced by fabricated
 * results, and it is never retried automatically.
 */
export class ResearchService {
  constructor(
    private readonly repos: Repositories,
    private readonly investigations: InvestigationService,
    private readonly usage: UsageService,
    private readonly activity: ActivityService,
    private readonly exa: ExaClient,
  ) {}

  /** Build the effective query from the investigation content. */
  buildQuery(investigation: { topic: string; objective: string; keywords: string[] }, custom?: string): string {
    if (custom?.trim()) return custom.trim().slice(0, 400)
    const keywords = investigation.keywords.slice(0, 6).join(', ')
    const base = investigation.topic.trim()
    const objective = investigation.objective.trim().replace(/\s+/g, ' ').slice(0, 220)
    return [base, keywords ? `foco: ${keywords}` : '', objective].filter(Boolean).join(' — ').slice(0, 400)
  }

  async search(
    investigationId: string,
    ownerId: string,
    input: ResearchRequestInput,
  ): Promise<ResearchResponse> {
    const investigation = await this.investigations.requireOwned(investigationId, ownerId)
    const query = this.buildQuery(investigation, input.query)
    if (query.length < 3) {
      throw errors.invalid('A consulta de pesquisa precisa de ao menos 3 caracteres')
    }
    this.exa.assertUsable()

    const queryHash = createHash('sha256')
      .update(`${investigationId}|${query.toLowerCase()}|${input.numResults}|${input.includeContent}`)
      .digest('hex')

    if (!input.repeat) {
      const duplicate = await this.usage.isDuplicateQuery(ownerId, queryHash)
      if (duplicate.duplicate) {
        throw errors.rateLimited(
          `Esta mesma pesquisa foi executada há menos de ${Math.round(duplicate.lastRunAt ? (Date.now() - new Date(duplicate.lastRunAt).getTime()) / 1000 : 0)}s. Repita conscientemente marcando "repetir pesquisa".`,
        )
      }
    }

    // Reserve AFTER the duplicate guard so a rejected duplicate does not
    // consume the daily allowance.
    const reservation = await this.usage.reserve({ ownerId, operation: 'research', investigationId })

    try {
      const outcome = await this.exa.search({
        query,
        numResults: input.numResults,
        includeContent: input.includeContent,
      })

      // Mark results that already exist in this investigation so the UI can
      // disable selection instead of letting the user create duplicates.
      const existing = await this.repos.evidence.listByInvestigation(investigationId)
      const existingByUrl = new Map(existing.map((item) => [normalizeUrl(item.url), item]))

      const results: ResearchResultItem[] = outcome.results.map((result) => {
        const normalized = normalizeUrl(result.url)
        const match = existingByUrl.get(normalized)
        return {
          id: result.id,
          title: result.title,
          url: result.url,
          domain: result.domain,
          snippet: result.snippet,
          retrievedContent: result.retrievedContent,
          contentAvailability: result.contentAvailability,
          publishedAt: result.publishedAt,
          author: result.author,
          previewScore: previewScore(
            {
              title: result.title,
              snippet: result.snippet,
              content: result.retrievedContent,
              domain: result.domain,
              publishedAt: result.publishedAt,
            },
            investigation,
          ),
          alreadyAdded: Boolean(match),
          existingEvidenceId: match?.id ?? null,
        }
      })

      await this.usage.settle({
        ownerId,
        operation: 'research',
        token: reservation.token,
        status: 'success',
        investigationId,
        metadata: {
          query,
          resultCount: results.length,
          providerRequestId: outcome.providerRequestId,
          costUsd: outcome.costUsd,
          warnings: outcome.warnings,
        },
      })

      await this.usage.recordQuery({
        investigationId,
        ownerId,
        queryHash,
        query,
        resultCount: results.length,
        providerRequest: outcome.providerRequestId,
      })

      await this.activity.record({
        investigationId,
        ownerId,
        eventType: 'research.executed',
        description: `Pesquisa executada na Exa: ${results.length} resultado(s)`,
        metadata: {
          query,
          resultCount: results.length,
          providerRequestId: outcome.providerRequestId,
          costUsd: outcome.costUsd,
          warnings: outcome.warnings,
        },
      })

      return {
        query,
        provider: 'exa',
        results,
        contentNotice: outcome.contentNotice,
        providerRequestId: outcome.providerRequestId,
        costUsd: outcome.costUsd,
        executedAt: outcome.executedAt,
        quota: await this.usage.snapshot(ownerId),
      }
    } catch (error) {
      const code = UsageService.errorCodeFor(error)
      await this.usage.settle({
        ownerId,
        operation: 'research',
        token: reservation.token,
        status: 'error',
        investigationId,
        errorCode: code,
      })
      if (error instanceof AppError && code !== 'external_disabled') {
        await this.activity.record({
          investigationId,
          ownerId,
          eventType: 'quota.blocked',
          description: `Pesquisa não concluída: ${error.message}`,
          metadata: { code, query },
        })
      }
      throw error
    }
  }

  /** Utility for the settings screen: is the provider ready to be called? */
  providerState(): { configured: boolean; enabled: boolean } {
    return { configured: this.exa.configured, enabled: this.exa.configured }
  }
}
