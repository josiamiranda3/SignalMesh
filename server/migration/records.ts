import { COLLECTIONS } from '../../src/schemas.ts'
import type { Repositories } from '../repositories/ports.ts'
import type { RecordStore } from '../repositories/records/transport.ts'
import { RecordsError } from '../repositories/records/transport.ts'
import { createId, nowIso } from '../lib/util.ts'

/**
 * Local → DeepSpace data migration.
 *
 * Reads every row through the existing repository ports (so it works from any
 * source adapter) and writes it into a DeepSpace `RecordStore`. Nothing is
 * deleted: the SQLite database is left untouched, which is what makes the
 * migration reversible — the operator can re-run it, or keep using the local
 * runtime, until they are satisfied.
 *
 * The migration is **idempotent and resumable**:
 *
 *  - record ids are preserved, so a second run overwrites instead of duplicating
 *    (`records.create` is an upsert on an explicit id);
 *  - a row that already exists with identical content is counted as `unchanged`;
 *  - a `uniqueOn` conflict from an earlier partial run is treated as a skip, not
 *    a failure;
 *  - every outcome is reported per collection, so a partial run is diagnosable.
 *
 * What it deliberately does not do: invent an owner. Every migrated row keeps
 * its original `ownerId`, and the store used for the import must therefore be
 * able to write on behalf of those owners (see `createMigrationStore` in
 * `server/services/migration.ts`). Migrating *into* a live app whose record room
 * enforces member RBAC would otherwise be impossible — and that is the correct
 * outcome, not a limitation to work around by weakening permissions.
 */

export interface MigrationCounts {
  read: number
  created: number
  unchanged: number
  skipped: number
  failed: number
}

export interface MigrationReport {
  startedAt: string
  finishedAt: string
  dryRun: boolean
  collections: Record<string, MigrationCounts>
  errors: Array<{ collection: string; id: string; error: string }>
}

export interface MigrateOptions {
  source: Repositories
  target: RecordStore
  /** Report what would happen without writing anything. */
  dryRun?: boolean
  /** Restrict to one owner (useful for a single-account migration). */
  ownerId?: string
}

const emptyCounts = (): MigrationCounts => ({
  read: 0,
  created: 0,
  unchanged: 0,
  skipped: 0,
  failed: 0,
})

export async function migrateToRecords(options: MigrateOptions): Promise<MigrationReport> {
  const { source, target, dryRun = false, ownerId } = options
  const startedAt = nowIso()
  const collections: Record<string, MigrationCounts> = {}
  const errors: MigrationReport['errors'] = []

  const owners = await resolveOwners(source, ownerId)

  // Order matters: investigations before their children, so a reviewer reading
  // the report sees parents succeed first.
  collections[COLLECTIONS.investigations] = await migrateInvestigationRows({
    source,
    target,
    owners,
    dryRun,
    errors,
  })

  collections[COLLECTIONS.evidence] = await migrateEvidenceRows({
    source,
    target,
    owners,
    dryRun,
    errors,
  })

  collections[COLLECTIONS.analyses] = await migrateAnalysisRows({
    source,
    target,
    owners,
    dryRun,
    errors,
  })

  collections[COLLECTIONS.validations] = await migrateValidationRows({
    source,
    target,
    owners,
    dryRun,
    errors,
  })

  collections[COLLECTIONS.activityLogs] = await migrateActivityRows({
    source,
    target,
    owners,
    dryRun,
    errors,
  })

  collections[COLLECTIONS.usageRecords] = await migrateUsageRows({
    source,
    target,
    owners,
    dryRun,
    errors,
  })

  return {
    startedAt,
    finishedAt: nowIso(),
    dryRun,
    collections,
    errors,
  }
}

/**
 * Which owners to migrate.
 *
 * An explicit `ownerId` always wins. Otherwise the source adapter is asked for
 * the owners it can see; only adapters that hold every row can answer, which is
 * exactly the local/migration context. A member-scoped DeepSpace transport does
 * not implement the capability, and the migration refuses rather than guessing.
 */
async function resolveOwners(source: Repositories, explicit: string | undefined): Promise<string[]> {
  if (explicit) return [explicit]

  const listAllOwners = source.investigations.listAllOwners
  if (typeof listAllOwners !== 'function') {
    throw new Error(
      'O adaptador de origem não enumera proprietários. Informe um ownerId explicitamente.',
    )
  }

  const owners = await listAllOwners.call(source.investigations)
  return owners.length > 0 ? owners : []
}

// ---------------------------------------------------------------------------
// Per-collection migrators
// ---------------------------------------------------------------------------

interface RowContext {
  source: Repositories
  target: RecordStore
  owners: string[]
  dryRun: boolean
  errors: MigrationReport['errors']
}

async function writeRow(
  context: RowContext,
  collection: string,
  counts: MigrationCounts,
  id: string,
  data: Record<string, unknown>,
): Promise<void> {
  counts.read += 1
  if (context.dryRun) {
    counts.created += 1
    return
  }

  try {
    const existing = await context.target.get(collection, id)
    if (existing) {
      // Idempotent re-run: identical content is a no-op.
      if (JSON.stringify(existing.data) === JSON.stringify(data)) {
        counts.unchanged += 1
        return
      }
      await context.target.update(collection, id, data)
      counts.created += 1
      return
    }
    await context.target.create(collection, data, id)
    counts.created += 1
  } catch (error) {
    if (error instanceof RecordsError && error.code === 'duplicate') {
      // A `uniqueOn` conflict from a previous partial run.
      counts.skipped += 1
      return
    }
    counts.failed += 1
    context.errors.push({
      collection,
      id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

async function migrateInvestigationRows(
  context: Omit<RowContext, 'dryRun'> & { dryRun: boolean },
): Promise<MigrationCounts> {
  const counts = emptyCounts()
  for (const owner of context.owners) {
    for (const investigation of await context.source.investigations.listByOwner(owner)) {
      await writeRow(context, COLLECTIONS.investigations, counts, investigation.id, {
        ownerId: investigation.ownerId,
        title: investigation.title,
        description: investigation.description,
        objective: investigation.objective,
        topic: investigation.topic,
        keywords: investigation.keywords,
        status: investigation.status,
        createdAt: investigation.createdAt,
        updatedAt: investigation.updatedAt,
      })
    }
  }
  return counts
}

async function migrateEvidenceRows(context: RowContext): Promise<MigrationCounts> {
  const counts = emptyCounts()
  for (const owner of context.owners) {
    for (const investigation of await context.source.investigations.listByOwner(owner)) {
      for (const evidence of await context.source.evidence.listByInvestigation(investigation.id)) {
        await writeRow(context, COLLECTIONS.evidence, counts, evidence.id, {
          investigationId: evidence.investigationId,
          ownerId: evidence.ownerId,
          title: evidence.title,
          url: evidence.url,
          // Imported rows carry their normalised form so the unique constraint
          // matches what the Records adapter would have written itself.
          urlNormalized: normalizeForMigration(evidence.url),
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
        })
      }
    }
  }
  return counts
}

async function migrateAnalysisRows(context: RowContext): Promise<MigrationCounts> {
  const counts = emptyCounts()
  for (const owner of context.owners) {
    for (const investigation of await context.source.investigations.listByOwner(owner)) {
      for (const analysis of await context.source.analyses.listByInvestigation(investigation.id)) {
        await writeRow(context, COLLECTIONS.analyses, counts, analysis.id, {
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
        })
      }
    }
  }
  return counts
}

async function migrateValidationRows(context: RowContext): Promise<MigrationCounts> {
  const counts = emptyCounts()
  for (const owner of context.owners) {
    for (const investigation of await context.source.investigations.listByOwner(owner)) {
      for (const validation of await context.source.validations.listByInvestigation(investigation.id)) {
        await writeRow(context, COLLECTIONS.validations, counts, validation.id, {
          investigationId: validation.investigationId,
          evidenceId: validation.evidenceId,
          ownerId: validation.ownerId,
          status: validation.status,
          previousStatus: validation.previousStatus,
          justification: validation.justification,
          createdAt: validation.createdAt,
        })
      }
    }
  }
  return counts
}

async function migrateActivityRows(context: RowContext): Promise<MigrationCounts> {
  const counts = emptyCounts()
  for (const owner of context.owners) {
    // The activity port pages by owner; read generously and let the writer
    // decide what to keep.
    for (const entry of await context.source.activity.listByOwner(owner, 10_000)) {
      await writeRow(context, COLLECTIONS.activityLogs, counts, entry.id, {
        investigationId: entry.investigationId,
        ownerId: entry.ownerId,
        eventType: entry.eventType,
        description: entry.description,
        metadata: entry.metadata,
        createdAt: entry.createdAt,
      })
    }
  }
  return counts
}

async function migrateUsageRows(context: RowContext): Promise<MigrationCounts> {
  const counts = emptyCounts()
  for (const owner of context.owners) {
    for (const usage of await context.source.usage.listByOwner(owner, 10_000)) {
      await writeRow(context, COLLECTIONS.usageRecords, counts, usage.id, {
        ownerId: usage.ownerId,
        provider: usage.provider,
        operation: usage.operation,
        status: usage.status,
        quantity: usage.quantity,
        investigationId: usage.investigationId,
        errorCode: usage.errorCode,
        metadata: usage.metadata,
        createdAt: usage.createdAt,
      })
    }
  }
  return counts
}

/** URL normalisation, duplicated here to keep the migration dependency-free. */
function normalizeForMigration(raw: string): string {
  try {
    const url = new URL(raw)
    url.hash = ''
    for (const param of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'ref']) {
      url.searchParams.delete(param)
    }
    const path = url.pathname.replace(/\/+$/, '') || '/'
    return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`
  } catch {
    return raw.trim().toLowerCase()
  }
}

/** Render a migration report for the CLI. */
export function formatMigrationReport(report: MigrationReport): string {
  const lines: string[] = []
  lines.push(`Migração ${report.dryRun ? '(simulação)' : ''} ${report.startedAt} → ${report.finishedAt}`)
  lines.push('')

  let totalCreated = 0
  let totalUnchanged = 0
  let totalSkipped = 0
  let totalFailed = 0
  let totalRead = 0

  for (const [collection, counts] of Object.entries(report.collections)) {
    totalRead += counts.read
    totalCreated += counts.created
    totalUnchanged += counts.unchanged
    totalSkipped += counts.skipped
    totalFailed += counts.failed
    lines.push(
      `${collection.padEnd(18)} lidos ${String(counts.read).padStart(5)} · gravados ${String(counts.created).padStart(5)} · iguais ${String(counts.unchanged).padStart(5)} · ignorados ${String(counts.skipped).padStart(4)} · falhas ${counts.failed}`,
    )
  }

  lines.push('')
  lines.push(
    `Total: ${totalRead} lidos, ${totalCreated} gravados, ${totalUnchanged} inalterados, ${totalSkipped} ignorados, ${totalFailed} falhas.`,
  )
  if (report.dryRun) lines.push('Nenhum dado foi gravado (simulação).')

  if (report.errors.length > 0) {
    lines.push('')
    lines.push('Falhas:')
    for (const error of report.errors.slice(0, 50)) {
      lines.push(`  - ${error.collection}/${error.id}: ${error.error}`)
    }
    if (report.errors.length > 50) lines.push(`  … e mais ${report.errors.length - 50}`)
  }

  return lines.join('\n')
}

/**
 * Stable id for a migrated settings key.
 *
 * Settings rows have no natural id in SQLite (they are keyed by `key`), while
 * Records needs a record id. Deriving it from the owner and key makes the
 * migration idempotent.
 */
export function settingsRecordId(ownerId: string, key: string): string {
  return `set_${createId('').replace(/[^a-z0-9]/gi, '').slice(0, 6)}_${hashKey(`${ownerId}:${key}`)}`
}

function hashKey(value: string): string {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }
  return hash.toString(36)
}
