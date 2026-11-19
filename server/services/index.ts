import type { AppConfig } from '../config.ts'
import type { Database } from '../db.ts'
import { createSqliteRepositories } from '../repositories/sqlite.ts'
import type { Repositories } from '../repositories/ports.ts'
import { ExaClient } from '../integrations/exa.ts'
import { GeminiClient } from '../integrations/gemini.ts'
import { SessionStore } from '../lib/sessions.ts'
import { ActivityService } from './activity.ts'
import { AnalysisService } from './analysis.ts'
import { DashboardService } from './dashboard.ts'
import { EvidenceService } from './evidence.ts'
import { ExportService } from './export.ts'
import { InvestigationService } from './investigations.ts'
import { ResearchService } from './research.ts'
import { UsageService } from './usage.ts'
import { ValidationService } from './validation.ts'

/**
 * Composition root.
 *
 * Wiring lives here and nowhere else. Swapping the persistence adapter (for
 * DeepSpace Records or another database) means constructing different
 * repositories; every service below is unaware of the storage engine.
 */
export interface Services {
  config: AppConfig
  repos: Repositories
  sessions: SessionStore
  activity: ActivityService
  usage: UsageService
  investigations: InvestigationService
  evidence: EvidenceService
  research: ResearchService
  analysis: AnalysisService
  validation: ValidationService
  dashboard: DashboardService
  exports: ExportService
  exa: ExaClient
  gemini: GeminiClient
  db: Database
}

export function createServices(config: AppConfig, db: Database): Services {
  const repos = createSqliteRepositories(db)
  const activity = new ActivityService(repos)
  const usage = new UsageService(repos, config)
  const investigations = new InvestigationService(repos, activity)
  const evidence = new EvidenceService(repos, investigations, activity)
  const exa = new ExaClient(config)
  const gemini = new GeminiClient(config)
  const research = new ResearchService(repos, investigations, usage, activity, exa)
  const analysis = new AnalysisService(repos, investigations, evidence, usage, activity, gemini)
  const validation = new ValidationService(repos, investigations, evidence, activity)
  const dashboard = new DashboardService(repos, activity, usage)
  const exports = new ExportService(repos, investigations, activity)
  const sessions = new SessionStore(db, repos.users, config.sessionTtlSeconds)

  return {
    config,
    repos,
    sessions,
    activity,
    usage,
    investigations,
    evidence,
    research,
    analysis,
    validation,
    dashboard,
    exports,
    exa,
    gemini,
    db,
  }
}
