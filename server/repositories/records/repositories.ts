import { COLLECTIONS } from '../../../src/schemas.ts'
import type {
  ActivityLogEntry,
  Analysis,
  AnalysisContradiction,
  AnalysisFinding,
  AnalysisReference,
  AnalysisUsage,
  Evidence,
  Investigation,
  InvestigationStatus,
  RelevanceBreakdown,
  UsageRecord,
  UserRecord,
  Validation,
} from '../../types.ts'
import type {
  ActivityRepository,
  AnalysisRepository,
  EvidenceRepository,
  InvestigationQuery,
  InvestigationRepository,
  QuotaReservationRepository,
  Repositories,
  ResearchQueryRepository,
  SettingsRepository,
  UsageRepository,
  UserRepository,
  ValidationRepository,
} from '../ports.ts'
import { normalizeUrl } from '../../lib/util.ts'
import { RecordsError, type RecordRow, type RecordStore } from './transport.ts'

/**
 * DeepSpace Records repositories.
 *
 * This adapter implements the same `ports.ts` interfaces as the SQLite one, so
 * every service — research, analysis, validation, export, quota — runs against
 * Durable Object storage without a single change. That equivalence is enforced
 * by the parity test suite, which runs the same scenarios against both.
 *
 * Mapping rules
 * -------------
 * - The domain uses `id`; Records calls it `recordId`. The adapter maps at the
 *   boundary and nowhere else.
 * - `keywords`, `findings`, JSON metadata etc. use `{ kind: 'json' }` columns,
 *   so the SDK round-trips arrays/objects. The adapter still defends against a
 *   string arriving (for example from an older row) and parses it.
 * - Booleans are stored as numbers (`{ kind: 'boolean' }`), matching SQLite's
 *   0/1 representation.
 * - Sorting is done by the query layer, not in memory, so pagination stays
 *   correct as the collection grows.
 */

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1
  return value === 'true'
}

/** JSON columns arrive decoded; older or hand-written rows may arrive as text. */
function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed = JSON.parse(value) as unknown
      return Array.isArray(parsed) ? (parsed as T[]) : []
    } catch {
      return []
    }
  }
  return []
}

function asObject<T>(value: unknown, fallback: T): T {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as T
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed = JSON.parse(value) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as T
    } catch {
      return fallback
    }
  }
  return fallback
}

function mapInvestigation(row: RecordRow): Investigation {
  return {
    id: row.recordId,
    ownerId: asString(row.data['ownerId']),
    title: asString(row.data['title']),
    description: asString(row.data['description']),
    objective: asString(row.data['objective']),
    topic: asString(row.data['topic']),
    keywords: asArray<string>(row.data['keywords']),
    status: (asString(row.data['status'], 'draft') as InvestigationStatus) ?? 'draft',
    createdAt: asString(row.data['createdAt'], row.createdAt),
    updatedAt: asString(row.data['updatedAt'], row.updatedAt),
  }
}

function mapEvidence(row: RecordRow): Evidence {
  const breakdown = row.data['relevanceBreakdown']
  return {
    id: row.recordId,
    investigationId: asString(row.data['investigationId']),
    ownerId: asString(row.data['ownerId']),
    title: asString(row.data['title']),
    url: asString(row.data['url']),
    domain: asString(row.data['domain']),
    snippet: asString(row.data['snippet']),
    retrievedContent: asNullableString(row.data['retrievedContent']),
    publishedAt: asNullableString(row.data['publishedAt']),
    author: asNullableString(row.data['author']),
    collectedAt: asString(row.data['collectedAt'], row.createdAt),
    source: asString(row.data['source'], 'exa'),
    sourceMetadata: asObject<Record<string, unknown>>(row.data['sourceMetadata'], {}),
    contentAvailability: asArray<string>(row.data['contentAvailability']),
    relevanceScore: asNumber(row.data['relevanceScore']),
    relevanceBreakdown: breakdown ? asObject<RelevanceBreakdown | null>(breakdown, null) : null,
    validationStatus: (asString(row.data['validationStatus'], 'pending') as Evidence['validationStatus']) ?? 'pending',
    note: asString(row.data['note']),
    createdAt: asString(row.data['createdAt'], row.createdAt),
    updatedAt: asString(row.data['updatedAt'], row.updatedAt),
  }
}

function mapAnalysis(row: RecordRow, evidenceIndex: Map<string, Evidence>): Analysis {
  const referenceIds = asArray<string>(row.data['referenceIds'])
  const references: AnalysisReference[] = referenceIds.map((id) => {
    const evidence = evidenceIndex.get(id)
    return {
      evidenceId: id,
      title: evidence?.title ?? 'Fonte não encontrada',
      url: evidence?.url ?? '',
      domain: evidence?.domain ?? '',
    }
  })

  return {
    id: row.recordId,
    investigationId: asString(row.data['investigationId']),
    ownerId: asString(row.data['ownerId']),
    evidenceIds: asArray<string>(row.data['evidenceIds']),
    model: asString(row.data['model']),
    status: (asString(row.data['status'], 'completed') as Analysis['status']) ?? 'completed',
    executiveSummary: asString(row.data['executiveSummary']),
    findings: asArray<AnalysisFinding>(row.data['findings']),
    keyPoints: asArray<string>(row.data['keyPoints']),
    supportedClaims: asArray<string>(row.data['supportedClaims']),
    contradictions: asArray<AnalysisContradiction>(row.data['contradictions']),
    limitations: asArray<string>(row.data['limitations']),
    informationGaps: asArray<string>(row.data['informationGaps']),
    objectiveAlignment: asString(row.data['objectiveAlignment']),
    references,
    insufficientEvidence: asBoolean(row.data['insufficientEvidence']),
    rawStructuredOutput: row.data['rawStructuredOutput']
      ? asObject<Record<string, unknown> | null>(row.data['rawStructuredOutput'], null)
      : null,
    usage: row.data['usage'] ? asObject<AnalysisUsage | null>(row.data['usage'], null) : null,
    errorMessage: asNullableString(row.data['errorMessage']),
    createdAt: asString(row.data['createdAt'], row.createdAt),
  }
}

function mapValidation(row: RecordRow): Validation {
  return {
    id: row.recordId,
    investigationId: asString(row.data['investigationId']),
    evidenceId: asString(row.data['evidenceId']),
    ownerId: asString(row.data['ownerId']),
    status: (asString(row.data['status'], 'pending') as Validation['status']) ?? 'pending',
    previousStatus: asNullableString(row.data['previousStatus']) as Validation['status'] | null,
    justification: asString(row.data['justification']),
    createdAt: asString(row.data['createdAt'], row.createdAt),
  }
}

function mapActivity(row: RecordRow): ActivityLogEntry {
  return {
    id: row.recordId,
    investigationId: asNullableString(row.data['investigationId']),
    ownerId: asString(row.data['ownerId']),
    eventType: asString(row.data['eventType'], 'investigation.updated') as ActivityLogEntry['eventType'],
    description: asString(row.data['description']),
    metadata: asObject<Record<string, unknown>>(row.data['metadata'], {}),
    createdAt: asString(row.data['createdAt'], row.createdAt),
  }
}

function mapUsage(row: RecordRow): UsageRecord {
  return {
    id: row.recordId,
    ownerId: asString(row.data['ownerId']),
    provider: (asString(row.data['provider'], 'exa') as UsageRecord['provider']) ?? 'exa',
    operation: (asString(row.data['operation'], 'research') as UsageRecord['operation']) ?? 'research',
    status: (asString(row.data['status'], 'success') as UsageRecord['status']) ?? 'success',
    quantity: asNumber(row.data['quantity']) ?? 0,
    investigationId: asNullableString(row.data['investigationId']),
    errorCode: asNullableString(row.data['errorCode']),
    metadata: asObject<Record<string, unknown>>(row.data['metadata'], {}),
    createdAt: asString(row.data['createdAt'], row.createdAt),
  }
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

class RecordsInvestigationRepository implements InvestigationRepository {
  constructor(private readonly store: RecordStore) {}

  async create(input: Investigation): Promise<Investigation> {
    await this.store.create(
      COLLECTIONS.investigations,
      {
        ownerId: input.ownerId,
        title: input.title,
        description: input.description,
        objective: input.objective,
        topic: input.topic,
        keywords: input.keywords,
        status: input.status,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      },
      input.id,
    )
    return input
  }

  async findById(id: string): Promise<Investigation | null> {
    const row = await this.store.get(COLLECTIONS.investigations, id)
    return row ? mapInvestigation(row) : null
  }

  async list(query: InvestigationQuery): Promise<{ items: Investigation[]; total: number }> {
    // Status is a database filter; search and direction are applied here so the
    // same semantics hold as the SQLite `LIKE '%needle%'` implementation.
    const where: Record<string, unknown> = { ownerId: query.ownerId }
    if (query.status) where['status'] = query.status

    const orderColumn =
      query.sort === 'title' ? 'title' : query.sort === 'createdAt' ? 'createdAt' : 'updatedAt'

    const all: Investigation[] = []
    let offset = 0
    for (;;) {
      const page = await this.store.query(COLLECTIONS.investigations, {
        where,
        orderBy: orderColumn,
        orderDir: query.direction,
        limit: 200,
        offset,
      })
      all.push(...page.records.map(mapInvestigation))
      if (page.nextOffset === undefined || page.records.length === 0) break
      offset = page.nextOffset
    }

    const needle = query.search?.trim().toLowerCase()
    const filtered = needle
      ? all.filter(
          (item) =>
            item.title.toLowerCase().includes(needle) ||
            item.topic.toLowerCase().includes(needle) ||
            item.objective.toLowerCase().includes(needle),
        )
      : all

    return {
      items: filtered.slice(query.offset, query.offset + query.limit),
      total: filtered.length,
    }
  }

  async listByOwner(ownerId: string): Promise<Investigation[]> {
    const page = await this.store.query(COLLECTIONS.investigations, {
      where: { ownerId },
      orderBy: 'updatedAt',
      orderDir: 'desc',
      limit: 200,
    })
    return page.records.map(mapInvestigation)
  }

  async update(id: string, patch: Partial<Investigation>): Promise<Investigation | null> {
    const current = await this.findById(id)
    if (!current) return null

    const next: Investigation = {
      ...current,
      ...patch,
      id: current.id,
      ownerId: current.ownerId,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    }

    await this.store.update(COLLECTIONS.investigations, id, {
      title: next.title,
      description: next.description,
      objective: next.objective,
      topic: next.topic,
      keywords: next.keywords,
      status: next.status,
      updatedAt: next.updatedAt,
    })
    return next
  }

  async remove(id: string): Promise<boolean> {
    const existing = await this.findById(id)
    if (!existing) return false
    await this.store.remove(COLLECTIONS.investigations, id)
    return true
  }

  async countByStatus(ownerId: string): Promise<Record<string, number>> {
    const page = await this.store.query(COLLECTIONS.investigations, {
      where: { ownerId },
      limit: 200,
    })
    const counts: Record<string, number> = {}
    for (const row of page.records) {
      const status = asString(row.data['status'], 'draft')
      counts[status] = (counts[status] ?? 0) + 1
    }
    return counts
  }
}

class RecordsEvidenceRepository implements EvidenceRepository {
  constructor(private readonly store: RecordStore) {}

  async create(input: Evidence): Promise<Evidence> {
    await this.store.create(
      COLLECTIONS.evidence,
      {
        investigationId: input.investigationId,
        ownerId: input.ownerId,
        title: input.title,
        url: input.url,
        // The uniqueness constraint needs a stored, normalised value.
        urlNormalized: normalizeUrl(input.url),
        domain: input.domain,
        snippet: input.snippet,
        retrievedContent: input.retrievedContent,
        publishedAt: input.publishedAt,
        author: input.author,
        collectedAt: input.collectedAt,
        source: input.source,
        sourceMetadata: input.sourceMetadata,
        contentAvailability: input.contentAvailability,
        relevanceScore: input.relevanceScore,
        relevanceBreakdown: input.relevanceBreakdown,
        validationStatus: input.validationStatus,
        note: input.note,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      },
      input.id,
    )
    return input
  }

  async findById(id: string): Promise<Evidence | null> {
    const row = await this.store.get(COLLECTIONS.evidence, id)
    return row ? mapEvidence(row) : null
  }

  async listByInvestigation(investigationId: string): Promise<Evidence[]> {
    const out: Evidence[] = []
    let offset = 0
    for (;;) {
      const page = await this.store.query(COLLECTIONS.evidence, {
        where: { investigationId },
        orderBy: 'createdAt',
        orderDir: 'desc',
        limit: 200,
        offset,
      })
      out.push(...page.records.map(mapEvidence))
      if (page.nextOffset === undefined || page.records.length === 0) break
      offset = page.nextOffset
    }
    return out
  }

  async findDuplicate(investigationId: string, urlNormalized: string): Promise<Evidence | null> {
    // Exact match on the stored normalised URL — the same predicate the SQLite
    // unique constraint uses, so both adapters agree on what "duplicate" means.
    const page = await this.store.query(COLLECTIONS.evidence, {
      where: { investigationId, urlNormalized },
      limit: 1,
    })
    const row = page.records[0]
    return row ? mapEvidence(row) : null
  }

  async update(id: string, patch: Partial<Evidence>): Promise<Evidence | null> {
    const current = await this.findById(id)
    if (!current) return null

    const next: Evidence = {
      ...current,
      ...patch,
      id: current.id,
      investigationId: current.investigationId,
      ownerId: current.ownerId,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    }

    await this.store.update(COLLECTIONS.evidence, id, {
      title: next.title,
      snippet: next.snippet,
      retrievedContent: next.retrievedContent,
      publishedAt: next.publishedAt,
      author: next.author,
      sourceMetadata: next.sourceMetadata,
      contentAvailability: next.contentAvailability,
      relevanceScore: next.relevanceScore,
      relevanceBreakdown: next.relevanceBreakdown,
      validationStatus: next.validationStatus,
      note: next.note,
      updatedAt: next.updatedAt,
    })
    return next
  }

  async remove(id: string): Promise<boolean> {
    const existing = await this.findById(id)
    if (!existing) return false
    await this.store.remove(COLLECTIONS.evidence, id)
    return true
  }

  async countByOwner(ownerId: string): Promise<{ total: number; byStatus: Record<string, number> }> {
    const out: Evidence[] = []
    let offset = 0
    for (;;) {
      const page = await this.store.query(COLLECTIONS.evidence, {
        where: { ownerId },
        limit: 200,
        offset,
      })
      out.push(...page.records.map(mapEvidence))
      if (page.nextOffset === undefined || page.records.length === 0) break
      offset = page.nextOffset
    }
    const byStatus: Record<string, number> = {}
    for (const item of out) byStatus[item.validationStatus] = (byStatus[item.validationStatus] ?? 0) + 1
    return { total: out.length, byStatus }
  }

  async countsByInvestigation(investigationId: string): Promise<Record<string, number>> {
    const items = await this.listByInvestigation(investigationId)
    const result: Record<string, number> = {}
    for (const item of items) result[item.validationStatus] = (result[item.validationStatus] ?? 0) + 1
    return result
  }

  async createdAtBuckets(ownerId: string, days: number): Promise<Array<{ date: string; count: number }>> {
    const since = new Date(Date.now() - days * 86_400_000).toISOString()
    const items: Evidence[] = []
    let offset = 0
    for (;;) {
      const page = await this.store.query(COLLECTIONS.evidence, {
        where: { ownerId },
        orderBy: 'createdAt',
        orderDir: 'asc',
        limit: 200,
        offset,
      })
      items.push(...page.records.map(mapEvidence))
      if (page.nextOffset === undefined || page.records.length === 0) break
      offset = page.nextOffset
    }

    const buckets = new Map<string, number>()
    for (const item of items) {
      if (item.createdAt < since) continue
      const date = item.createdAt.slice(0, 10)
      buckets.set(date, (buckets.get(date) ?? 0) + 1)
    }
    return [...buckets.entries()]
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date))
  }
}

class RecordsAnalysisRepository implements AnalysisRepository {
  constructor(
    private readonly store: RecordStore,
    private readonly evidence: EvidenceRepository,
  ) {}

  private async evidenceIndex(investigationId: string): Promise<Map<string, Evidence>> {
    const rows = await this.evidence.listByInvestigation(investigationId)
    return new Map(rows.map((row) => [row.id, row]))
  }

  async create(input: Analysis): Promise<Analysis> {
    await this.store.create(
      COLLECTIONS.analyses,
      {
        investigationId: input.investigationId,
        ownerId: input.ownerId,
        evidenceIds: input.evidenceIds,
        model: input.model,
        status: input.status,
        executiveSummary: input.executiveSummary,
        findings: input.findings,
        keyPoints: input.keyPoints,
        supportedClaims: input.supportedClaims,
        contradictions: input.contradictions,
        limitations: input.limitations,
        informationGaps: input.informationGaps,
        objectiveAlignment: input.objectiveAlignment,
        // Store ids only; titles and URLs are resolved from live evidence so a
        // renamed source cannot leave a stale label in an old analysis.
        referenceIds: input.references.map((reference) => reference.evidenceId),
        insufficientEvidence: input.insufficientEvidence,
        rawStructuredOutput: input.rawStructuredOutput,
        usage: input.usage,
        errorMessage: input.errorMessage,
        createdAt: input.createdAt,
      },
      input.id,
    )
    return input
  }

  async findById(id: string): Promise<Analysis | null> {
    const row = await this.store.get(COLLECTIONS.analyses, id)
    if (!row) return null
    const index = await this.evidenceIndex(asString(row.data['investigationId']))
    return mapAnalysis(row, index)
  }

  async listByInvestigation(investigationId: string): Promise<Analysis[]> {
    const rows: RecordRow[] = []
    let offset = 0
    for (;;) {
      const page = await this.store.query(COLLECTIONS.analyses, {
        where: { investigationId },
        orderBy: 'createdAt',
        orderDir: 'desc',
        limit: 200,
        offset,
      })
      rows.push(...page.records)
      if (page.nextOffset === undefined || page.records.length === 0) break
      offset = page.nextOffset
    }
    const index = await this.evidenceIndex(investigationId)
    return rows.map((row) => mapAnalysis(row, index))
  }

  async latestForInvestigation(investigationId: string): Promise<Analysis | null> {
    const page = await this.store.query(COLLECTIONS.analyses, {
      where: { investigationId, status: 'completed' },
      orderBy: 'createdAt',
      orderDir: 'desc',
      limit: 1,
    })
    const row = page.records[0]
    if (!row) return null
    const index = await this.evidenceIndex(investigationId)
    return mapAnalysis(row, index)
  }

  async countByOwner(ownerId: string): Promise<number> {
    return this.store.count(COLLECTIONS.analyses, { ownerId, status: 'completed' })
  }

  async removeByInvestigation(investigationId: string): Promise<void> {
    // Bounded pages until the cascade drains, mirroring ON DELETE CASCADE.
    for (;;) {
      const deleted = await this.store.deleteWhere(
        COLLECTIONS.analyses,
        { investigationId },
        100,
      )
      if (deleted < 100) return
    }
  }
}

class RecordsValidationRepository implements ValidationRepository {
  constructor(private readonly store: RecordStore) {}

  async create(input: Validation): Promise<Validation> {
    await this.store.create(
      COLLECTIONS.validations,
      {
        investigationId: input.investigationId,
        evidenceId: input.evidenceId,
        ownerId: input.ownerId,
        status: input.status,
        previousStatus: input.previousStatus,
        justification: input.justification,
        createdAt: input.createdAt,
      },
      input.id,
    )
    return input
  }

  async listByEvidence(evidenceId: string): Promise<Validation[]> {
    const page = await this.store.query(COLLECTIONS.validations, {
      where: { evidenceId },
      orderBy: 'createdAt',
      orderDir: 'desc',
      limit: 200,
    })
    return page.records.map(mapValidation)
  }

  async listByInvestigation(investigationId: string): Promise<Validation[]> {
    const out: Validation[] = []
    let offset = 0
    for (;;) {
      const page = await this.store.query(COLLECTIONS.validations, {
        where: { investigationId },
        orderBy: 'createdAt',
        orderDir: 'desc',
        limit: 200,
        offset,
      })
      out.push(...page.records.map(mapValidation))
      if (page.nextOffset === undefined || page.records.length === 0) break
      offset = page.nextOffset
    }
    return out
  }

  async countByOwner(ownerId: string): Promise<number> {
    return this.store.count(COLLECTIONS.validations, { ownerId })
  }
}

class RecordsActivityRepository implements ActivityRepository {
  constructor(private readonly store: RecordStore) {}

  async create(input: ActivityLogEntry): Promise<ActivityLogEntry> {
    await this.store.create(
      COLLECTIONS.activityLogs,
      {
        investigationId: input.investigationId,
        ownerId: input.ownerId,
        eventType: input.eventType,
        description: input.description,
        metadata: input.metadata,
        createdAt: input.createdAt,
      },
      input.id,
    )
    return input
  }

  async listByOwner(ownerId: string, limit: number, offset = 0): Promise<ActivityLogEntry[]> {
    const page = await this.store.query(COLLECTIONS.activityLogs, {
      where: { ownerId },
      orderBy: 'createdAt',
      orderDir: 'desc',
      limit,
      offset,
    })
    return page.records.map(mapActivity)
  }

  async listByInvestigation(investigationId: string, limit = 200): Promise<ActivityLogEntry[]> {
    const page = await this.store.query(COLLECTIONS.activityLogs, {
      where: { investigationId },
      orderBy: 'createdAt',
      orderDir: 'desc',
      limit,
    })
    return page.records.map(mapActivity)
  }

  async countByOwner(ownerId: string): Promise<number> {
    return this.store.count(COLLECTIONS.activityLogs, { ownerId })
  }

  async removeByInvestigation(investigationId: string): Promise<void> {
    for (;;) {
      const deleted = await this.store.deleteWhere(
        COLLECTIONS.activityLogs,
        { investigationId },
        100,
      )
      if (deleted < 100) return
    }
  }
}

class RecordsUsageRepository implements UsageRepository {
  constructor(private readonly store: RecordStore) {}

  async create(input: UsageRecord): Promise<UsageRecord> {
    await this.store.create(
      COLLECTIONS.usageRecords,
      {
        ownerId: input.ownerId,
        provider: input.provider,
        operation: input.operation,
        status: input.status,
        quantity: input.quantity,
        investigationId: input.investigationId,
        errorCode: input.errorCode,
        metadata: input.metadata,
        createdAt: input.createdAt,
      },
      input.id,
    )
    return input
  }

  /**
   * `ownerId: null` means "every user", used only by the global daily ceiling.
   *
   * In the Worker this call is issued through the admin transport, because a
   * member-scoped read cannot see other accounts' rows by design. The adapter
   * never returns those rows to a caller — only this sum leaves the method.
   */
  async countInWindow(ownerId: string | null, operation: string, since: string): Promise<number> {
    const where: Record<string, unknown> = { operation, status: 'success' }
    if (ownerId) where['ownerId'] = ownerId

    const rows: UsageRecord[] = []
    let offset = 0
    for (;;) {
      const page = await this.store.query(COLLECTIONS.usageRecords, {
        where,
        limit: 200,
        offset,
      })
      rows.push(...page.records.map(mapUsage))
      if (page.nextOffset === undefined || page.records.length === 0) break
      offset = page.nextOffset
    }

    let total = 0
    for (const row of rows) if (row.createdAt >= since) total += row.quantity
    return total
  }

  async listByOwner(ownerId: string, limit: number): Promise<UsageRecord[]> {
    const page = await this.store.query(COLLECTIONS.usageRecords, {
      where: { ownerId },
      orderBy: 'createdAt',
      orderDir: 'desc',
      limit,
    })
    return page.records.map(mapUsage)
  }
}

class RecordsResearchQueryRepository implements ResearchQueryRepository {
  constructor(private readonly store: RecordStore) {}

  async record(input: {
    id: string
    investigationId: string
    ownerId: string
    queryHash: string
    query: string
    resultCount: number
    providerRequest: string | null
    createdAt: string
  }): Promise<void> {
    await this.store.create(
      COLLECTIONS.researchQueries,
      {
        investigationId: input.investigationId,
        ownerId: input.ownerId,
        queryHash: input.queryHash,
        query: input.query,
        resultCount: input.resultCount,
        providerRequest: input.providerRequest,
        createdAt: input.createdAt,
      },
      input.id,
    )
  }

  async latestByHash(ownerId: string, queryHash: string): Promise<{ createdAt: string; query: string } | null> {
    const page = await this.store.query(COLLECTIONS.researchQueries, {
      where: { ownerId, queryHash },
      orderBy: 'createdAt',
      orderDir: 'desc',
      limit: 1,
    })
    const row = page.records[0]
    return row
      ? { createdAt: asString(row.data['createdAt'], row.createdAt), query: asString(row.data['query']) }
      : null
  }
}

class RecordsSettingsRepository implements SettingsRepository {
  constructor(private readonly store: RecordStore) {}

  async get(key: string, ownerId?: string): Promise<string | null> {
    const where: Record<string, unknown> = { key }
    if (ownerId) where['ownerId'] = ownerId
    const page = await this.store.query(COLLECTIONS.appSettings, { where, limit: 1 })
    const row = page.records[0]
    return row ? asString(row.data['value']) : null
  }

  async set(key: string, value: string, ownerId = ''): Promise<void> {
    const where: Record<string, unknown> = { key }
    if (ownerId) where['ownerId'] = ownerId
    const page = await this.store.query(COLLECTIONS.appSettings, { where, limit: 1 })
    const existing = page.records[0]

    if (existing) {
      await this.store.update(COLLECTIONS.appSettings, existing.recordId, { value })
      return
    }

    await this.store.create(COLLECTIONS.appSettings, { ownerId, key, value })
  }

  async all(): Promise<Record<string, string>> {
    const page = await this.store.query(COLLECTIONS.appSettings, { limit: 200 })
    const result: Record<string, string> = {}
    for (const row of page.records) {
      const key = asString(row.data['key'])
      if (key) result[key] = asString(row.data['value'])
    }
    return result
  }
}

class RecordsUserRepository implements UserRepository {
  constructor(private readonly store: RecordStore) {}

  async upsert(input: UserRecord): Promise<UserRecord> {
    // The `users` row is written by the SDK's `users.register` path (which is
    // the only writer allowed to touch system-managed columns). Here we only
    // read; a caller asking to upsert gets the existing row or a clear error.
    const existing = await this.findById(input.id)
    if (existing) return existing
    throw new RecordsError({
      message:
        'User rows are provisioned by DeepSpace Auth. Call users.register on the platform instead of writing them directly.',
      tool: 'users.upsert',
      collection: COLLECTIONS.users,
      code: 'denied',
    })
  }

  async findById(id: string): Promise<UserRecord | null> {
    const row = await this.store.get(COLLECTIONS.users, id)
    if (!row) return null
    return {
      id: row.recordId,
      email: asString(row.data['email']),
      name: asString(row.data['name']),
      avatarUrl: asNullableString(row.data['imageUrl'] ?? row.data['avatarUrl']),
      createdAt: row.createdAt,
    }
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const page = await this.store.query(COLLECTIONS.users, { where: { email }, limit: 1 })
    const row = page.records[0]
    return row ? this.findById(row.recordId) : null
  }
}

/** Assemble the DeepSpace-backed repository set. */
/**
 * Reservation repository over DeepSpace Records.
 *
 * Atomicity comes from the collection's `uniqueOn: ['ownerId', 'operation']`,
 * which the RecordRoom materialises as a `CREATE UNIQUE INDEX` in its SQLite
 * database (see `quotaReservationsSchema`). The insert either succeeds or the
 * DO answers with a duplicate error — there is no read-then-write window, and
 * no transaction API is required.
 *
 * Expiry is handled by deleting a stale row and retrying the insert, so a
 * crashed request cannot hold the slot forever.
 */
class RecordsQuotaReservationRepository implements QuotaReservationRepository {
  constructor(private readonly store: RecordStore) {}

  async acquire(input: {
    ownerId: string
    operation: string
    token: string
    expiresAt: number
    createdAt: string
  }): Promise<{ token: string; recordId: string } | null> {
    const data = {
      ownerId: input.ownerId,
      operation: input.operation,
      token: input.token,
      expiresAt: input.expiresAt,
      createdAt: input.createdAt,
    }

    try {
      const recordId = await this.store.create(COLLECTIONS.quotaReservations, data)
      return { token: input.token, recordId }
    } catch (error) {
      if (!(error instanceof RecordsError) || error.code !== 'duplicate') throw error
    }

    // Someone holds a live reservation. Reclaim it only if it has expired; the
    // conditional delete keeps the decision at the storage layer.
    const stale = await this.store.query(COLLECTIONS.quotaReservations, {
      where: { ownerId: input.ownerId, operation: input.operation },
      limit: 1,
    })
    const existing = stale.records[0]
    if (!existing) {
      // The holder released between the insert and the query; retry once.
      return this.acquireOnce(data, input.token)
    }

    const expiresAt = Number(existing.data['expiresAt'] ?? 0)
    if (Number.isFinite(expiresAt) && expiresAt > Date.now()) return null

    await this.store.remove(COLLECTIONS.quotaReservations, existing.recordId).catch(() => undefined)
    return this.acquireOnce(data, input.token)
  }

  private async acquireOnce(
    data: Record<string, unknown>,
    token: string,
  ): Promise<{ token: string; recordId: string } | null> {
    try {
      const recordId = await this.store.create(COLLECTIONS.quotaReservations, data)
      return { token, recordId }
    } catch (error) {
      if (error instanceof RecordsError && error.code === 'duplicate') return null
      throw error
    }
  }

  async release(input: { ownerId: string; operation: string; token: string }): Promise<boolean> {
    const found = await this.store.query(COLLECTIONS.quotaReservations, {
      where: { ownerId: input.ownerId, operation: input.operation, token: input.token },
      limit: 1,
    })
    const row = found.records[0]
    if (!row) return false
    await this.store.remove(COLLECTIONS.quotaReservations, row.recordId)
    return true
  }

  async purgeExpired(now: number): Promise<number> {
    return this.store.deleteWhere(COLLECTIONS.quotaReservations, { expiresAt: now })
  }
}

export function createRecordsRepositories(store: RecordStore): Repositories {
  const evidence = new RecordsEvidenceRepository(store)
  return {
    investigations: new RecordsInvestigationRepository(store),
    evidence,
    analyses: new RecordsAnalysisRepository(store, evidence),
    validations: new RecordsValidationRepository(store),
    activity: new RecordsActivityRepository(store),
    usage: new RecordsUsageRepository(store),
    researchQueries: new RecordsResearchQueryRepository(store),
    settings: new RecordsSettingsRepository(store),
    users: new RecordsUserRepository(store),
    reservations: new RecordsQuotaReservationRepository(store),
  }
}
