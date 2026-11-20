import { all, get, run, type Database } from '../db.ts'
import type {
  ActivityLogEntry,
  Analysis,
  AnalysisContradiction,
  AnalysisFinding,
  AnalysisUsage,
  Evidence,
  Investigation,
  InvestigationStatus,
  RelevanceBreakdown,
  UsageRecord,
  UserRecord,
  Validation,
} from '../types.ts'
import type {
  ActivityRepository,
  AnalysisRepository,
  EvidenceRepository,
  InvestigationQuery,
  InvestigationRepository,
  Repositories,
  ResearchQueryRepository,
  SettingsRepository,
  UsageRepository,
  UserRepository,
  ValidationRepository,
} from './ports.ts'

/** JSON helpers that tolerate legacy rows. */
function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function toBool(value: number | null): boolean {
  return value === 1
}

interface InvestigationRow {
  id: string
  owner_id: string
  title: string
  description: string
  objective: string
  topic: string
  keywords: string
  status: string
  created_at: string
  updated_at: string
}

function mapInvestigation(row: InvestigationRow): Investigation {
  return {
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    description: row.description,
    objective: row.objective,
    topic: row.topic,
    keywords: parseJson<string[]>(row.keywords, []),
    status: row.status as InvestigationStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

interface EvidenceRow {
  id: string
  investigation_id: string
  owner_id: string
  title: string
  url: string
  domain: string
  snippet: string
  retrieved_content: string | null
  published_at: string | null
  author: string | null
  collected_at: string
  source: string
  source_metadata: string
  content_availability: string
  relevance_score: number | null
  relevance_breakdown: string | null
  validation_status: string
  note: string
  created_at: string
  updated_at: string
}

function mapEvidence(row: EvidenceRow): Evidence {
  return {
    id: row.id,
    investigationId: row.investigation_id,
    ownerId: row.owner_id,
    title: row.title,
    url: row.url,
    domain: row.domain,
    snippet: row.snippet,
    retrievedContent: row.retrieved_content,
    publishedAt: row.published_at,
    author: row.author,
    collectedAt: row.collected_at,
    source: row.source,
    sourceMetadata: parseJson<Record<string, unknown>>(row.source_metadata, {}),
    contentAvailability: parseJson<string[]>(row.content_availability, []),
    relevanceScore: row.relevance_score,
    relevanceBreakdown: parseJson<RelevanceBreakdown | null>(row.relevance_breakdown, null),
    validationStatus: row.validation_status as Evidence['validationStatus'],
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

interface AnalysisRow {
  id: string
  investigation_id: string
  owner_id: string
  evidence_ids: string
  model: string
  status: string
  executive_summary: string
  findings: string
  key_points: string
  supported_claims: string
  contradictions: string
  limitations: string
  information_gaps: string
  objective_alignment: string
  reference_ids: string
  insufficient_evidence: number
  raw_structured_output: string | null
  usage: string | null
  error_message: string | null
  created_at: string
}

function mapAnalysis(row: AnalysisRow, evidenceIndex: Map<string, Evidence>): Analysis {
  const referenceIds = parseJson<string[]>(row.reference_ids, [])
  return {
    id: row.id,
    investigationId: row.investigation_id,
    ownerId: row.owner_id,
    evidenceIds: parseJson<string[]>(row.evidence_ids, []),
    model: row.model,
    status: row.status as Analysis['status'],
    executiveSummary: row.executive_summary,
    findings: parseJson<AnalysisFinding[]>(row.findings, []),
    keyPoints: parseJson<string[]>(row.key_points, []),
    supportedClaims: parseJson<string[]>(row.supported_claims, []),
    contradictions: parseJson<AnalysisContradiction[]>(row.contradictions, []),
    limitations: parseJson<string[]>(row.limitations, []),
    informationGaps: parseJson<string[]>(row.information_gaps, []),
    objectiveAlignment: row.objective_alignment,
    references: referenceIds.map((id) => {
      const evidence = evidenceIndex.get(id)
      return {
        evidenceId: id,
        title: evidence?.title ?? 'Fonte não encontrada',
        url: evidence?.url ?? '',
        domain: evidence?.domain ?? '',
      }
    }),
    insufficientEvidence: toBool(row.insufficient_evidence),
    rawStructuredOutput: parseJson<Record<string, unknown> | null>(row.raw_structured_output, null),
    usage: parseJson<AnalysisUsage | null>(row.usage, null),
    errorMessage: row.error_message,
    createdAt: row.created_at,
  }
}

interface ValidationRow {
  id: string
  investigation_id: string
  evidence_id: string
  owner_id: string
  status: string
  previous_status: string | null
  justification: string
  created_at: string
}

function mapValidation(row: ValidationRow): Validation {
  return {
    id: row.id,
    investigationId: row.investigation_id,
    evidenceId: row.evidence_id,
    ownerId: row.owner_id,
    status: row.status as Validation['status'],
    previousStatus: (row.previous_status as Validation['status'] | null) ?? null,
    justification: row.justification,
    createdAt: row.created_at,
  }
}

interface ActivityRow {
  id: string
  investigation_id: string | null
  owner_id: string
  event_type: string
  description: string
  metadata: string
  created_at: string
}

function mapActivity(row: ActivityRow): ActivityLogEntry {
  return {
    id: row.id,
    investigationId: row.investigation_id,
    ownerId: row.owner_id,
    eventType: row.event_type as ActivityLogEntry['eventType'],
    description: row.description,
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    createdAt: row.created_at,
  }
}

interface UsageRow {
  id: string
  owner_id: string
  provider: string
  operation: string
  status: string
  quantity: number
  investigation_id: string | null
  error_code: string | null
  metadata: string
  created_at: string
}

function mapUsage(row: UsageRow): UsageRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    provider: row.provider as UsageRecord['provider'],
    operation: row.operation as UsageRecord['operation'],
    status: row.status as UsageRecord['status'],
    quantity: row.quantity,
    investigationId: row.investigation_id,
    errorCode: row.error_code,
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
    createdAt: row.created_at,
  }
}

class SqliteInvestigationRepository implements InvestigationRepository {
  constructor(private readonly db: Database) {}

  async create(input: Investigation): Promise<Investigation> {
    run(
      this.db,
      `INSERT INTO investigations (id, owner_id, title, description, objective, topic, keywords, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.ownerId,
        input.title,
        input.description,
        input.objective,
        input.topic,
        JSON.stringify(input.keywords),
        input.status,
        input.createdAt,
        input.updatedAt,
      ],
    )
    return input
  }

  async findById(id: string): Promise<Investigation | null> {
    const row = get<InvestigationRow>(this.db, 'SELECT * FROM investigations WHERE id = ?', [id])
    return row ? mapInvestigation(row) : null
  }

  async list(query: InvestigationQuery): Promise<{ items: Investigation[]; total: number }> {
    const where: string[] = ['owner_id = ?']
    const params: unknown[] = [query.ownerId]
    if (query.status) {
      where.push('status = ?')
      params.push(query.status)
    }
    if (query.search) {
      where.push('(LOWER(title) LIKE ? OR LOWER(topic) LIKE ? OR LOWER(objective) LIKE ?)')
      const needle = `%${query.search.toLowerCase()}%`
      params.push(needle, needle, needle)
    }
    const clause = where.join(' AND ')
    const orderColumn =
      query.sort === 'title' ? 'title' : query.sort === 'createdAt' ? 'created_at' : 'updated_at'
    const direction = query.direction === 'asc' ? 'ASC' : 'DESC'
    const rows = all<InvestigationRow>(
      this.db,
      `SELECT * FROM investigations WHERE ${clause} ORDER BY ${orderColumn} ${direction} LIMIT ? OFFSET ?`,
      [...params, query.limit, query.offset],
    )
    const totalRow = get<{ count: number }>(
      this.db,
      `SELECT COUNT(*) AS count FROM investigations WHERE ${clause}`,
      params,
    )
    return { items: rows.map(mapInvestigation), total: totalRow?.count ?? 0 }
  }

  async listByOwner(ownerId: string): Promise<Investigation[]> {
    const rows = all<InvestigationRow>(
      this.db,
      'SELECT * FROM investigations WHERE owner_id = ? ORDER BY updated_at DESC',
      [ownerId],
    )
    return rows.map(mapInvestigation)
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
    run(
      this.db,
      `UPDATE investigations SET title = ?, description = ?, objective = ?, topic = ?, keywords = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [
        next.title,
        next.description,
        next.objective,
        next.topic,
        JSON.stringify(next.keywords),
        next.status,
        next.updatedAt,
        id,
      ],
    )
    return next
  }

  async remove(id: string): Promise<boolean> {
    const existing = await this.findById(id)
    if (!existing) return false
    run(this.db, 'DELETE FROM investigations WHERE id = ?', [id])
    return true
  }

  async countByStatus(ownerId: string): Promise<Record<string, number>> {
    const rows = all<{ status: string; count: number }>(
      this.db,
      'SELECT status, COUNT(*) AS count FROM investigations WHERE owner_id = ? GROUP BY status',
      [ownerId],
    )
    const result: Record<string, number> = {}
    for (const row of rows) result[row.status] = row.count
    return result
  }

  /** Used by the migration CLI: which owners have data to copy. */
  async listAllOwners(): Promise<string[]> {
    const rows = all<{ owner_id: string }>(
      this.db,
      'SELECT DISTINCT owner_id FROM investigations ORDER BY owner_id',
    )
    return rows.map((row) => row.owner_id)
  }
}

class SqliteEvidenceRepository implements EvidenceRepository {
  constructor(private readonly db: Database) {}

  async create(input: Evidence): Promise<Evidence> {
    run(
      this.db,
      `INSERT INTO evidence (id, investigation_id, owner_id, title, url, url_normalized, domain, snippet,
        retrieved_content, published_at, author, collected_at, source, source_metadata, content_availability,
        relevance_score, relevance_breakdown, validation_status, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.investigationId,
        input.ownerId,
        input.title,
        input.url,
        normalizeUrl(input.url),
        input.domain,
        input.snippet,
        input.retrievedContent,
        input.publishedAt,
        input.author,
        input.collectedAt,
        input.source,
        JSON.stringify(input.sourceMetadata),
        JSON.stringify(input.contentAvailability),
        input.relevanceScore,
        input.relevanceBreakdown ? JSON.stringify(input.relevanceBreakdown) : null,
        input.validationStatus,
        input.note,
        input.createdAt,
        input.updatedAt,
      ],
    )
    return input
  }

  async findById(id: string): Promise<Evidence | null> {
    const row = get<EvidenceRow>(this.db, 'SELECT * FROM evidence WHERE id = ?', [id])
    return row ? mapEvidence(row) : null
  }

  async listByInvestigation(investigationId: string): Promise<Evidence[]> {
    const rows = all<EvidenceRow>(
      this.db,
      'SELECT * FROM evidence WHERE investigation_id = ? ORDER BY created_at DESC',
      [investigationId],
    )
    return rows.map(mapEvidence)
  }

  async findDuplicate(investigationId: string, urlNormalized: string): Promise<Evidence | null> {
    const row = get<EvidenceRow>(
      this.db,
      'SELECT * FROM evidence WHERE investigation_id = ? AND url_normalized = ?',
      [investigationId, urlNormalized],
    )
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
    run(
      this.db,
      `UPDATE evidence SET title = ?, snippet = ?, retrieved_content = ?, published_at = ?, author = ?,
        source_metadata = ?, content_availability = ?, relevance_score = ?, relevance_breakdown = ?,
        validation_status = ?, note = ?, updated_at = ?
       WHERE id = ?`,
      [
        next.title,
        next.snippet,
        next.retrievedContent,
        next.publishedAt,
        next.author,
        JSON.stringify(next.sourceMetadata),
        JSON.stringify(next.contentAvailability),
        next.relevanceScore,
        next.relevanceBreakdown ? JSON.stringify(next.relevanceBreakdown) : null,
        next.validationStatus,
        next.note,
        next.updatedAt,
        id,
      ],
    )
    return next
  }

  async remove(id: string): Promise<boolean> {
    const existing = await this.findById(id)
    if (!existing) return false
    run(this.db, 'DELETE FROM evidence WHERE id = ?', [id])
    return true
  }

  async countByOwner(ownerId: string): Promise<{ total: number; byStatus: Record<string, number> }> {
    const totalRow = get<{ count: number }>(
      this.db,
      'SELECT COUNT(*) AS count FROM evidence WHERE owner_id = ?',
      [ownerId],
    )
    const rows = all<{ validation_status: string; count: number }>(
      this.db,
      'SELECT validation_status, COUNT(*) AS count FROM evidence WHERE owner_id = ? GROUP BY validation_status',
      [ownerId],
    )
    const byStatus: Record<string, number> = {}
    for (const row of rows) byStatus[row.validation_status] = row.count
    return { total: totalRow?.count ?? 0, byStatus }
  }

  async countsByInvestigation(investigationId: string): Promise<Record<string, number>> {
    const rows = all<{ validation_status: string; count: number }>(
      this.db,
      'SELECT validation_status, COUNT(*) AS count FROM evidence WHERE investigation_id = ? GROUP BY validation_status',
      [investigationId],
    )
    const result: Record<string, number> = {}
    for (const row of rows) result[row.validation_status] = row.count
    return result
  }

  async createdAtBuckets(ownerId: string, days: number): Promise<Array<{ date: string; count: number }>> {
    const rows = all<{ date: string; count: number }>(
      this.db,
      `SELECT substr(created_at, 1, 10) AS date, COUNT(*) AS count
       FROM evidence
       WHERE owner_id = ? AND created_at >= ?
       GROUP BY date ORDER BY date ASC`,
      [ownerId, new Date(Date.now() - days * 86_400_000).toISOString()],
    )
    return rows
  }
}

class SqliteAnalysisRepository implements AnalysisRepository {
  constructor(
    private readonly db: Database,
    private readonly evidence: EvidenceRepository,
  ) {}

  async create(input: Analysis): Promise<Analysis> {
    run(
      this.db,
      `INSERT INTO analyses (id, investigation_id, owner_id, evidence_ids, model, status, executive_summary,
        findings, key_points, supported_claims, contradictions, limitations, information_gaps,
        objective_alignment, reference_ids, insufficient_evidence, raw_structured_output, usage, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.investigationId,
        input.ownerId,
        JSON.stringify(input.evidenceIds),
        input.model,
        input.status,
        input.executiveSummary,
        JSON.stringify(input.findings),
        JSON.stringify(input.keyPoints),
        JSON.stringify(input.supportedClaims),
        JSON.stringify(input.contradictions),
        JSON.stringify(input.limitations),
        JSON.stringify(input.informationGaps),
        input.objectiveAlignment,
        JSON.stringify(input.references.map((reference) => reference.evidenceId)),
        input.insufficientEvidence ? 1 : 0,
        input.rawStructuredOutput ? JSON.stringify(input.rawStructuredOutput) : null,
        input.usage ? JSON.stringify(input.usage) : null,
        input.errorMessage,
        input.createdAt,
      ],
    )
    return input
  }

  private async evidenceIndex(investigationId: string): Promise<Map<string, Evidence>> {
    const rows = await this.evidence.listByInvestigation(investigationId)
    return new Map(rows.map((row) => [row.id, row]))
  }

  async findById(id: string): Promise<Analysis | null> {
    const row = get<AnalysisRow>(this.db, 'SELECT * FROM analyses WHERE id = ?', [id])
    if (!row) return null
    const index = await this.evidenceIndex(row.investigation_id)
    return mapAnalysis(row, index)
  }

  async listByInvestigation(investigationId: string): Promise<Analysis[]> {
    const rows = all<AnalysisRow>(
      this.db,
      'SELECT * FROM analyses WHERE investigation_id = ? ORDER BY created_at DESC',
      [investigationId],
    )
    const index = await this.evidenceIndex(investigationId)
    return rows.map((row) => mapAnalysis(row, index))
  }

  async latestForInvestigation(investigationId: string): Promise<Analysis | null> {
    const row = get<AnalysisRow>(
      this.db,
      "SELECT * FROM analyses WHERE investigation_id = ? AND status = 'completed' ORDER BY created_at DESC LIMIT 1",
      [investigationId],
    )
    if (!row) return null
    const index = await this.evidenceIndex(investigationId)
    return mapAnalysis(row, index)
  }

  async countByOwner(ownerId: string): Promise<number> {
    const row = get<{ count: number }>(
      this.db,
      "SELECT COUNT(*) AS count FROM analyses WHERE owner_id = ? AND status = 'completed'",
      [ownerId],
    )
    return row?.count ?? 0
  }

  async removeByInvestigation(investigationId: string): Promise<void> {
    run(this.db, 'DELETE FROM analyses WHERE investigation_id = ?', [investigationId])
  }
}

class SqliteValidationRepository implements ValidationRepository {
  constructor(private readonly db: Database) {}

  async create(input: Validation): Promise<Validation> {
    run(
      this.db,
      `INSERT INTO validations (id, investigation_id, evidence_id, owner_id, status, previous_status, justification, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.investigationId,
        input.evidenceId,
        input.ownerId,
        input.status,
        input.previousStatus,
        input.justification,
        input.createdAt,
      ],
    )
    return input
  }

  async listByEvidence(evidenceId: string): Promise<Validation[]> {
    const rows = all<ValidationRow>(
      this.db,
      'SELECT * FROM validations WHERE evidence_id = ? ORDER BY created_at DESC',
      [evidenceId],
    )
    return rows.map(mapValidation)
  }

  async listByInvestigation(investigationId: string): Promise<Validation[]> {
    const rows = all<ValidationRow>(
      this.db,
      'SELECT * FROM validations WHERE investigation_id = ? ORDER BY created_at DESC',
      [investigationId],
    )
    return rows.map(mapValidation)
  }

  async countByOwner(ownerId: string): Promise<number> {
    const row = get<{ count: number }>(
      this.db,
      'SELECT COUNT(*) AS count FROM validations WHERE owner_id = ?',
      [ownerId],
    )
    return row?.count ?? 0
  }
}

class SqliteActivityRepository implements ActivityRepository {
  constructor(private readonly db: Database) {}

  async create(input: ActivityLogEntry): Promise<ActivityLogEntry> {
    run(
      this.db,
      `INSERT INTO activity_logs (id, investigation_id, owner_id, event_type, description, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.investigationId,
        input.ownerId,
        input.eventType,
        input.description,
        JSON.stringify(input.metadata),
        input.createdAt,
      ],
    )
    return input
  }

  async listByOwner(ownerId: string, limit: number, offset = 0): Promise<ActivityLogEntry[]> {
    const rows = all<ActivityRow>(
      this.db,
      'SELECT * FROM activity_logs WHERE owner_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [ownerId, limit, offset],
    )
    return rows.map(mapActivity)
  }

  async listByInvestigation(investigationId: string, limit = 200): Promise<ActivityLogEntry[]> {
    const rows = all<ActivityRow>(
      this.db,
      'SELECT * FROM activity_logs WHERE investigation_id = ? ORDER BY created_at DESC LIMIT ?',
      [investigationId, limit],
    )
    return rows.map(mapActivity)
  }

  async countByOwner(ownerId: string): Promise<number> {
    const row = get<{ count: number }>(
      this.db,
      'SELECT COUNT(*) AS count FROM activity_logs WHERE owner_id = ?',
      [ownerId],
    )
    return row?.count ?? 0
  }

  async removeByInvestigation(investigationId: string): Promise<void> {
    run(this.db, 'DELETE FROM activity_logs WHERE investigation_id = ?', [investigationId])
  }
}

class SqliteUsageRepository implements UsageRepository {
  constructor(private readonly db: Database) {}

  async create(input: UsageRecord): Promise<UsageRecord> {
    run(
      this.db,
      `INSERT INTO usage_records (id, owner_id, provider, operation, status, quantity, investigation_id, error_code, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.ownerId,
        input.provider,
        input.operation,
        input.status,
        input.quantity,
        input.investigationId,
        input.errorCode,
        JSON.stringify(input.metadata),
        input.createdAt,
      ],
    )
    return input
  }

  async countInWindow(ownerId: string | null, operation: string, since: string): Promise<number> {
    const row = ownerId
      ? get<{ count: number }>(
          this.db,
          `SELECT COALESCE(SUM(quantity), 0) AS count FROM usage_records
           WHERE owner_id = ? AND operation = ? AND status = 'success' AND created_at >= ?`,
          [ownerId, operation, since],
        )
      : get<{ count: number }>(
          this.db,
          `SELECT COALESCE(SUM(quantity), 0) AS count FROM usage_records
           WHERE operation = ? AND status = 'success' AND created_at >= ?`,
          [operation, since],
        )
    return row?.count ?? 0
  }

  async listByOwner(ownerId: string, limit: number): Promise<UsageRecord[]> {
    const rows = all<UsageRow>(
      this.db,
      'SELECT * FROM usage_records WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?',
      [ownerId, limit],
    )
    return rows.map(mapUsage)
  }
}

class SqliteResearchQueryRepository implements ResearchQueryRepository {
  constructor(private readonly db: Database) {}

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
    run(
      this.db,
      `INSERT INTO research_queries (id, investigation_id, owner_id, query_hash, query, result_count, provider_request, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.id,
        input.investigationId,
        input.ownerId,
        input.queryHash,
        input.query,
        input.resultCount,
        input.providerRequest,
        input.createdAt,
      ],
    )
  }

  async latestByHash(ownerId: string, queryHash: string): Promise<{ createdAt: string; query: string } | null> {
    const row = get<{ created_at: string; query: string }>(
      this.db,
      `SELECT created_at, query FROM research_queries
       WHERE owner_id = ? AND query_hash = ? ORDER BY created_at DESC LIMIT 1`,
      [ownerId, queryHash],
    )
    return row ? { createdAt: row.created_at, query: row.query } : null
  }
}

class SqliteSettingsRepository implements SettingsRepository {
  constructor(private readonly db: Database) {}

  // `ownerId` is part of the port for adapters that scope settings per user;
  // this adapter keys by `key` alone, so it is accepted and ignored.
  async get(key: string, _ownerId?: string): Promise<string | null> {
    const row = get<{ value: string }>(this.db, 'SELECT value FROM app_settings WHERE key = ?', [key])
    return row?.value ?? null
  }

  async set(key: string, value: string, _ownerId?: string): Promise<void> {
    run(
      this.db,
      `INSERT INTO app_settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    )
  }

  async all(): Promise<Record<string, string>> {
    const rows = all<{ key: string; value: string }>(this.db, 'SELECT key, value FROM app_settings')
    const result: Record<string, string> = {}
    for (const row of rows) result[row.key] = row.value
    return result
  }
}

class SqliteUserRepository implements UserRepository {
  constructor(private readonly db: Database) {}

  async upsert(input: UserRecord): Promise<UserRecord> {
    run(
      this.db,
      `INSERT INTO users (id, email, name, avatar_url, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name, avatar_url = excluded.avatar_url`,
      [input.id, input.email, input.name, input.avatarUrl, input.createdAt],
    )
    return input
  }

  async findById(id: string): Promise<UserRecord | null> {
    const row = get<{ id: string; email: string; name: string; avatar_url: string | null; created_at: string }>(
      this.db,
      'SELECT * FROM users WHERE id = ?',
      [id],
    )
    return row
      ? { id: row.id, email: row.email, name: row.name, avatarUrl: row.avatar_url, createdAt: row.created_at }
      : null
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const row = get<{ id: string; email: string; name: string; avatar_url: string | null; created_at: string }>(
      this.db,
      'SELECT * FROM users WHERE email = ?',
      [email],
    )
    return row
      ? { id: row.id, email: row.email, name: row.name, avatarUrl: row.avatar_url, createdAt: row.created_at }
      : null
  }
}

/** URL normalisation used for duplicate detection. */
export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.hash = ''
    const trackingParams = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'gclid',
      'fbclid',
      'ref',
    ]
    for (const param of trackingParams) url.searchParams.delete(param)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`
  } catch {
    return raw.trim().toLowerCase()
  }
}

export function createSqliteRepositories(db: Database): Repositories {
  const evidence = new SqliteEvidenceRepository(db)
  return {
    investigations: new SqliteInvestigationRepository(db),
    evidence,
    analyses: new SqliteAnalysisRepository(db, evidence),
    validations: new SqliteValidationRepository(db),
    activity: new SqliteActivityRepository(db),
    usage: new SqliteUsageRepository(db),
    researchQueries: new SqliteResearchQueryRepository(db),
    settings: new SqliteSettingsRepository(db),
    users: new SqliteUserRepository(db),
  }
}
