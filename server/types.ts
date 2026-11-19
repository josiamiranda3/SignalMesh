/**
 * Server-side types.
 *
 * The domain shapes live in `shared/domain.ts` and are re-exported here so the
 * server has a single import surface. `UserRecord` is the only type that is
 * server-only (it carries an email that is never exposed in API payloads).
 */

export type {
  ActivityLogEntry,
  Analysis,
  AnalysisContradiction,
  AnalysisFinding,
  AnalysisReference,
  AnalysisStatus,
  AnalysisUsage,
  Evidence,
  Investigation,
  InvestigationStatus,
  Provider,
  QuotaState,
  RelevanceBreakdown,
  RelevanceWeights,
  UsageOperation,
  UsageQuotaSnapshot,
  UsageRecord,
  UsageStatus,
  Validation,
  ValidationStatus,
} from '../shared/domain.ts'

export interface UserRecord {
  id: string
  email: string
  name: string
  avatarUrl: string | null
  createdAt: string
}
