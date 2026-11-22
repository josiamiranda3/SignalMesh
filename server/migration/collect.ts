import { COLLECTIONS } from '../../src/schemas.ts'
import type { Repositories } from '../repositories/ports.ts'

/**
 * Collect the rows to migrate, in dependency order.
 *
 * Reads through the repository ports only, so it works against any source
 * adapter and cannot accidentally bypass the source's own access rules. It
 * never writes, never deletes, and never mutates the source database.
 *
 * Two invariants matter here:
 *
 *  1. **Only the requested owner's rows are read.** Every query is owner-scoped.
 *     A row belonging to someone else is never even loaded, so it cannot be
 *     reattributed downstream by `userBound`.
 *  2. **URLs are normalised on the way out.** The target collection has a
 *     `uniqueOn (investigationId, urlNormalized)` constraint; importing the raw
 *     URL would let a tracked variant slip past duplicate detection.
 */

export interface MigrationRow {
  collection: string
  id: string
  data: Record<string, unknown>
}

export interface MigrationRows {
  ownerId: string
  rows: MigrationRow[]
  warnings: string[]
}

export interface CollectOptions {
  source: Repositories
  ownerId: string
}

export async function collectMigrationRows(options: CollectOptions): Promise<MigrationRows> {
  const { source, ownerId } = options
  const rows: MigrationRow[] = []
  const warnings: string[] = []

  const investigations = await source.investigations.listByOwner(ownerId)

  for (const investigation of investigations) {
    if (investigation.ownerId !== ownerId) {
      // Defence in depth against a source adapter that ignores the owner filter.
      warnings.push(`investigations/${investigation.id}: pertence a ${investigation.ownerId} — ignorada`)
      continue
    }

    rows.push({
      collection: COLLECTIONS.investigations,
      id: investigation.id,
      data: {
        ownerId: investigation.ownerId,
        title: investigation.title,
        description: investigation.description,
        objective: investigation.objective,
        topic: investigation.topic,
        keywords: investigation.keywords,
        status: investigation.status,
        createdAt: investigation.createdAt,
        updatedAt: investigation.updatedAt,
      },
    })

    for (const evidence of await source.evidence.listByInvestigation(investigation.id)) {
      if (evidence.ownerId !== ownerId) {
        warnings.push(`evidence/${evidence.id}: pertence a ${evidence.ownerId} — ignorada`)
        continue
      }
      rows.push({
        collection: COLLECTIONS.evidence,
        id: evidence.id,
        data: {
          investigationId: evidence.investigationId,
          ownerId: evidence.ownerId,
          title: evidence.title,
          url: evidence.url,
          urlNormalized: normalizeUrlForMigration(evidence.url),
          domain: evidence.domain,
          snippet: evidence.snippet,
          retrievedContent: evidence.retrievedContent,
          publishedAt: evidence.publishedAt,
          author: evidence.author,
          collectedAt: evidence.collectedAt,
          source: evidence.source,
          sourceMetadata: evidence.sourceMetadata,
          contentAvailability: evidence.contentAvailability,
          relevanceScore: evidence.relevanceScore,
          relevanceBreakdown: evidence.relevanceBreakdown,
          validationStatus: evidence.validationStatus,
          note: evidence.note,
          createdAt: evidence.createdAt,
          updatedAt: evidence.updatedAt,
        },
      })
    }

    for (const analysis of await source.analyses.listByInvestigation(investigation.id)) {
      if (analysis.ownerId !== ownerId) {
        warnings.push(`analyses/${analysis.id}: pertence a ${analysis.ownerId} — ignorada`)
        continue
      }
      rows.push({
        collection: COLLECTIONS.analyses,
        id: analysis.id,
        data: {
          investigationId: analysis.investigationId,
          ownerId: analysis.ownerId,
          evidenceIds: analysis.evidenceIds,
          model: analysis.model,
          status: analysis.status,
          executiveSummary: analysis.executiveSummary,
          findings: analysis.findings,
          keyPoints: analysis.keyPoints,
          supportedClaims: analysis.supportedClaims,
          contradictions: analysis.contradictions,
          limitations: analysis.limitations,
          informationGaps: analysis.informationGaps,
          objectiveAlignment: analysis.objectiveAlignment,
          referenceIds: analysis.references.map((reference) => reference.evidenceId),
          insufficientEvidence: analysis.insufficientEvidence,
          rawStructuredOutput: analysis.rawStructuredOutput,
          usage: analysis.usage,
          errorMessage: analysis.errorMessage,
          createdAt: analysis.createdAt,
        },
      })
    }

    for (const validation of await source.validations.listByInvestigation(investigation.id)) {
      if (validation.ownerId !== ownerId) {
        warnings.push(`validations/${validation.id}: pertence a ${validation.ownerId} — ignorada`)
        continue
      }
      rows.push({
        collection: COLLECTIONS.validations,
        id: validation.id,
        data: {
          investigationId: validation.investigationId,
          evidenceId: validation.evidenceId,
          ownerId: validation.ownerId,
          status: validation.status,
          previousStatus: validation.previousStatus,
          justification: validation.justification,
          createdAt: validation.createdAt,
        },
      })
    }
  }

  for (const entry of await source.activity.listByOwner(ownerId, 10_000)) {
    if (entry.ownerId !== ownerId) continue
    rows.push({
      collection: COLLECTIONS.activityLogs,
      id: entry.id,
      data: {
        investigationId: entry.investigationId,
        ownerId: entry.ownerId,
        eventType: entry.eventType,
        description: entry.description,
        metadata: entry.metadata,
        createdAt: entry.createdAt,
      },
    })
  }

  for (const usage of await source.usage.listByOwner(ownerId, 10_000)) {
    if (usage.ownerId !== ownerId) continue
    rows.push({
      collection: COLLECTIONS.usageRecords,
      id: usage.id,
      data: {
        ownerId: usage.ownerId,
        provider: usage.provider,
        operation: usage.operation,
        status: usage.status,
        quantity: usage.quantity,
        investigationId: usage.investigationId,
        errorCode: usage.errorCode,
        metadata: usage.metadata,
        createdAt: usage.createdAt,
      },
    })
  }

  return { ownerId, rows, warnings }
}

/** Strip tracking parameters so the target's `uniqueOn` matches the adapter. */
export function normalizeUrlForMigration(raw: string): string {
  try {
    const url = new URL(raw)
    url.hash = ''
    for (const param of [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'gclid',
      'fbclid',
      'ref',
    ]) {
      url.searchParams.delete(param)
    }
    const path = url.pathname.replace(/\/+$/, '') || '/'
    return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`
  } catch {
    return raw.trim().toLowerCase()
  }
}
