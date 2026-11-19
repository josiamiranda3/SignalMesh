import type {
  ActivityLogEntry,
  Analysis,
  Evidence,
  Investigation,
  InvestigationStatus,
  UsageRecord,
  UserRecord,
  Validation,
} from '../types.ts'

/**
 * Repository ports.
 *
 * The service layer depends only on these interfaces, so the SQLite
 * implementation used locally can be replaced by the DeepSpace Records
 * adapter (or any SQL database) without touching business rules.
 */

export interface InvestigationQuery {
  ownerId: string
  search?: string | undefined
  status?: InvestigationStatus | undefined
  sort: 'updatedAt' | 'createdAt' | 'title'
  direction: 'asc' | 'desc'
  limit: number
  offset: number
}

export interface InvestigationRepository {
  create(input: Investigation): Promise<Investigation>
  findById(id: string): Promise<Investigation | null>
  list(query: InvestigationQuery): Promise<{ items: Investigation[]; total: number }>
  listByOwner(ownerId: string): Promise<Investigation[]>
  update(id: string, patch: Partial<Investigation>): Promise<Investigation | null>
  remove(id: string): Promise<boolean>
  countByStatus(ownerId: string): Promise<Record<string, number>>
}

export interface EvidenceRepository {
  create(input: Evidence): Promise<Evidence>
  findById(id: string): Promise<Evidence | null>
  listByInvestigation(investigationId: string): Promise<Evidence[]>
  findDuplicate(investigationId: string, urlNormalized: string): Promise<Evidence | null>
  update(id: string, patch: Partial<Evidence>): Promise<Evidence | null>
  remove(id: string): Promise<boolean>
  countByOwner(ownerId: string): Promise<{ total: number; byStatus: Record<string, number> }>
  countsByInvestigation(investigationId: string): Promise<Record<string, number>>
  createdAtBuckets(ownerId: string, days: number): Promise<Array<{ date: string; count: number }>>
}

export interface AnalysisRepository {
  create(input: Analysis): Promise<Analysis>
  findById(id: string): Promise<Analysis | null>
  listByInvestigation(investigationId: string): Promise<Analysis[]>
  latestForInvestigation(investigationId: string): Promise<Analysis | null>
  countByOwner(ownerId: string): Promise<number>
  removeByInvestigation(investigationId: string): Promise<void>
}

export interface ValidationRepository {
  create(input: Validation): Promise<Validation>
  listByEvidence(evidenceId: string): Promise<Validation[]>
  listByInvestigation(investigationId: string): Promise<Validation[]>
  countByOwner(ownerId: string): Promise<number>
}

export interface ActivityRepository {
  create(input: ActivityLogEntry): Promise<ActivityLogEntry>
  listByOwner(ownerId: string, limit: number, offset?: number): Promise<ActivityLogEntry[]>
  listByInvestigation(investigationId: string, limit?: number): Promise<ActivityLogEntry[]>
  countByOwner(ownerId: string): Promise<number>
  removeByInvestigation(investigationId: string): Promise<void>
}

export interface UsageRepository {
  create(input: UsageRecord): Promise<UsageRecord>
  countInWindow(ownerId: string | null, operation: string, since: string): Promise<number>
  listByOwner(ownerId: string, limit: number): Promise<UsageRecord[]>
}

export interface ResearchQueryRepository {
  record(input: {
    id: string
    investigationId: string
    ownerId: string
    queryHash: string
    query: string
    resultCount: number
    providerRequest: string | null
    createdAt: string
  }): Promise<void>
  latestByHash(ownerId: string, queryHash: string): Promise<{ createdAt: string; query: string } | null>
}

export interface SettingsRepository {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  all(): Promise<Record<string, string>>
}

export interface UserRepository {
  upsert(input: UserRecord): Promise<UserRecord>
  findById(id: string): Promise<UserRecord | null>
  findByEmail(email: string): Promise<UserRecord | null>
}

export interface Repositories {
  investigations: InvestigationRepository
  evidence: EvidenceRepository
  analyses: AnalysisRepository
  validations: ValidationRepository
  activity: ActivityRepository
  usage: UsageRepository
  researchQueries: ResearchQueryRepository
  settings: SettingsRepository
  users: UserRepository
}
