/**
 * Domain model shared by the API server, the worker adapter and the React app.
 *
 * These are plain serialisable structures. Persistence adapters map them to
 * their storage representation; nothing here depends on a storage engine.
 */

/** Investigation lifecycle. */
export const INVESTIGATION_STATUSES = ['draft', 'active', 'completed', 'archived'] as const
export type InvestigationStatus = (typeof INVESTIGATION_STATUSES)[number]

/** Human validation lifecycle for an evidence record. */
export const VALIDATION_STATUSES = ['pending', 'accepted', 'rejected', 'needs_review'] as const
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number]

/** Activity events recorded in the audit trail. */
export const ACTIVITY_TYPES = [
  'investigation.created',
  'investigation.updated',
  'investigation.status_changed',
  'investigation.archived',
  'investigation.deleted',
  'research.executed',
  'evidence.added',
  'evidence.updated',
  'evidence.removed',
  'evidence.note_updated',
  'analysis.requested',
  'analysis.completed',
  'analysis.failed',
  'validation.recorded',
  'export.generated',
  'quota.blocked',
] as const
export type ActivityType = (typeof ACTIVITY_TYPES)[number]

/** External providers used by the platform. */
export const PROVIDERS = ['exa', 'gemini'] as const
export type Provider = (typeof PROVIDERS)[number]

export interface Investigation {
  id: string
  ownerId: string
  title: string
  description: string
  objective: string
  topic: string
  keywords: string[]
  status: InvestigationStatus
  createdAt: string
  updatedAt: string
}

export interface SearchSourcePayload {
  title: string
  url: string
  domain: string
  snippet: string
  /** Full text returned by the provider when content was requested. */
  retrievedContent: string | null
  publishedAt: string | null
  author: string | null
  /** Provider request id, useful for support and traceability. */
  providerRequestId: string | null
  /** Which content fields the provider actually returned, e.g. ['text','highlights']. */
  contentAvailability: string[]
}

export interface Evidence {
  id: string
  investigationId: string
  ownerId: string
  title: string
  url: string
  domain: string
  snippet: string
  retrievedContent: string | null
  publishedAt: string | null
  author: string | null
  collectedAt: string
  /** Where this evidence came from. 'exa' for external research. */
  source: string
  sourceMetadata: Record<string, unknown>
  contentAvailability: string[]
  /** 0..1 prioritisation index, never a probability of truth. */
  relevanceScore: number | null
  relevanceBreakdown: RelevanceBreakdown | null
  validationStatus: ValidationStatus
  note: string
  createdAt: string
  updatedAt: string
}

export interface RelevanceBreakdown {
  topical: number | null
  recency: number | null
  sourceQuality: number | null
  objectiveAlignment: number | null
  /** Human-readable reasons for each component, produced by the scorer. */
  rationale: string[]
  /** Weight set that produced this score, for reproducibility. */
  weights: RelevanceWeights
  /** Components that could not be evaluated (missing data). */
  missing: string[]
}

export interface RelevanceWeights {
  topical: number
  recency: number
  sourceQuality: number
  objectiveAlignment: number
}

/** One generated finding, always tied to evidence ids that really exist. */
export interface AnalysisFinding {
  statement: string
  evidenceIds: string[]
  confidence: 'low' | 'medium' | 'high'
}

export interface AnalysisContradiction {
  description: string
  evidenceIds: string[]
}

export interface AnalysisReference {
  evidenceId: string
  title: string
  url: string
  domain: string
}

export type AnalysisStatus = 'completed' | 'failed'

export interface Analysis {
  id: string
  investigationId: string
  ownerId: string
  evidenceIds: string[]
  model: string
  status: AnalysisStatus
  executiveSummary: string
  findings: AnalysisFinding[]
  keyPoints: string[]
  supportedClaims: string[]
  contradictions: AnalysisContradiction[]
  limitations: string[]
  informationGaps: string[]
  objectiveAlignment: string
  references: AnalysisReference[]
  /** True when the model reported that evidence was insufficient. */
  insufficientEvidence: boolean
  /** Full structured output exactly as validated, kept for audit. */
  rawStructuredOutput: Record<string, unknown> | null
  usage: AnalysisUsage | null
  errorMessage: string | null
  createdAt: string
}

export interface AnalysisUsage {
  promptTokens: number | null
  candidateTokens: number | null
  totalTokens: number | null
}

export interface Validation {
  id: string
  investigationId: string
  evidenceId: string
  ownerId: string
  status: ValidationStatus
  previousStatus: ValidationStatus | null
  justification: string
  createdAt: string
}

export interface ActivityLogEntry {
  id: string
  investigationId: string | null
  ownerId: string
  eventType: ActivityType
  description: string
  metadata: Record<string, unknown>
  createdAt: string
}

export type UsageOperation = 'research' | 'analysis'
export type UsageStatus = 'success' | 'error' | 'blocked'

export interface UsageRecord {
  id: string
  ownerId: string
  provider: Provider
  operation: UsageOperation
  status: UsageStatus
  quantity: number
  investigationId: string | null
  errorCode: string | null
  metadata: Record<string, unknown>
  createdAt: string
}

/** Per-user daily quota snapshot returned to the UI. */
export interface UsageQuotaSnapshot {
  research: QuotaState
  analysis: QuotaState
  externalApisEnabled: boolean
  paidOperationsEnabled: boolean
}

export interface QuotaState {
  used: number
  limit: number
  remaining: number
  resetsAt: string
}
