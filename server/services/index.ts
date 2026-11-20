import type { AppConfig } from '../config.ts'
import type { Repositories } from '../repositories/ports.ts'
import { ExaClient } from '../integrations/exa.ts'
import { GeminiClient } from '../integrations/gemini.ts'
import type { AuthResolver } from '../lib/auth-resolver.ts'
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
 * This module is platform-neutral: it takes a `Repositories` implementation and
 * an `AuthResolver`, and builds every service. It imports nothing from Node and
 * nothing from the Worker, so the same wiring runs under `@hono/node-server`
 * and inside a Cloudflare Worker.
 *
 * Runtime-specific construction lives in:
 *   - `server/services/node.ts`   (SQLite + local sessions)
 *   - `server/services/worker.ts` (DeepSpace Records + verified JWT)
 */
export interface Services {
  config: AppConfig
  repos: Repositories
  auth: AuthResolver
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
}

export function createServices(input: {
  config: AppConfig
  repos: Repositories
  auth: AuthResolver
}): Services {
  const { config, repos, auth } = input

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

  return {
    config,
    repos,
    auth,
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
  }
}
