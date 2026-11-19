import type {
  ActivityLogEntry,
  Analysis,
  Evidence,
  Investigation,
  UsageQuotaSnapshot,
  UsageRecord,
  Validation,
} from './domain.ts'

export type { UsageRecord }

/**
 * API envelope.
 *
 * Success and failure are distinguishable at the type level and the HTTP status
 * always agrees with the body, so a client never has to guess.
 */
export type ApiErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'external_disabled'
  | 'provider_auth_failed'
  | 'provider_rate_limited'
  | 'provider_unavailable'
  | 'provider_timeout'
  | 'invalid_provider_response'
  | 'internal_error'

export interface ApiErrorPayload {
  code: ApiErrorCode
  message: string
  details?: Array<{ path: string; message: string }>
  /** Present on provider errors so the UI can explain what to do next. */
  provider?: string
  retryable?: boolean
}

export type ApiResponse<T> =
  | { success: true; data: T }
  | { success: false; error: ApiErrorPayload }

export interface Paginated<T> {
  items: T[]
  total: number
  limit: number
  offset: number
}

export interface SessionUser {
  id: string
  name: string
  email: string
  avatarUrl: string | null
}

export interface DashboardSummary {
  investigations: {
    total: number
    byStatus: Record<string, number>
  }
  evidence: {
    total: number
    byStatus: Record<string, number>
  }
  analyses: number
  validations: number
  activityCount: number
  evidenceTrend: Array<{ date: string; count: number }>
  investigationTrend: Array<{ date: string; count: number }>
  recentActivity: ActivityLogEntry[]
  recentInvestigations: Investigation[]
  quota: UsageQuotaSnapshot
}

export interface ResearchResultItem {
  id: string
  title: string
  url: string
  domain: string
  snippet: string
  retrievedContent: string | null
  contentAvailability: string[]
  publishedAt: string | null
  author: string | null
  previewScore: number
  alreadyAdded: boolean
  existingEvidenceId: string | null
}

export interface ResearchResponse {
  query: string
  provider: 'exa'
  results: ResearchResultItem[]
  /** Honest statement of what the provider actually returned. */
  contentNotice: string
  providerRequestId: string | null
  costUsd: number | null
  executedAt: string
  quota: UsageQuotaSnapshot
}

export interface InvestigationDetail {
  investigation: Investigation
  evidence: Evidence[]
  analyses: Analysis[]
  validations: Validation[]
  activity: ActivityLogEntry[]
  counts: {
    evidence: number
    byValidationStatus: Record<string, number>
    analyses: number
    validations: number
  }
  quota: UsageQuotaSnapshot
}

export interface ProviderStatus {
  exa: { configured: boolean; enabled: boolean; searchType: string }
  gemini: { configured: boolean; enabled: boolean; model: string }
  externalApisEnabled: boolean
  paidOperationsEnabled: boolean
}

export interface SettingsResponse {
  user: SessionUser
  quota: UsageQuotaSnapshot
  providers: ProviderStatus
  usageHistory: UsageRecord[]
  limits: {
    researchDailyLimit: number
    analysisDailyLimit: number
    researchGlobalDailyLimit: number
    analysisGlobalDailyLimit: number
  }
}

export interface HealthResponse {
  status: 'ok'
  version: string
  time: string
  database: 'ok'
}
