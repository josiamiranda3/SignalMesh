/**
 * Runtime configuration.
 *
 * Values come from the environment; nothing here reads a file or a database.
 * The two switches `ENABLE_EXTERNAL_APIS` and `ENABLE_PAID_OPERATIONS` are the
 * global kill switches required by the cost-protection policy: when they are
 * off, research and analysis routes refuse to call any provider and say why.
 */

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test'
  port: number
  /** Absolute origin the app is served from; used for cookie and CORS policy. */
  appOrigin: string
  databaseUrl: string
  sessionSecret: string
  sessionTtlSeconds: number

  /** Global switch for Exa + Gemini calls. */
  externalApisEnabled: boolean
  /** Must ALSO be true for anything that can bill money. */
  paidOperationsEnabled: boolean

  exaApiKey: string | null
  exaBaseUrl: string
  exaSearchType: 'auto' | 'lite' | 'deep-lite' | 'deep'
  exaTimeoutMs: number

  geminiApiKey: string | null
  geminiModel: string
  geminiBaseUrl: string
  geminiTimeoutMs: number
  geminiMaxOutputTokens: number
  geminiTemperature: number

  researchDailyLimit: number
  analysisDailyLimit: number
  researchGlobalDailyLimit: number
  analysisGlobalDailyLimit: number
  /** Minimum gap between two identical research queries, in seconds. */
  duplicateGuardSeconds: number
  /** Per-window request cap applied to all API routes. */
  apiRateLimitPerMinute: number

  /** DeepSpace mode is selected by the worker adapter, not by env. */
  authMode: 'local' | 'deepspace'

  /** Seed a demo investigation for local evaluation only (explicitly labelled). */
  seedDemoData: boolean
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function enumValue<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes((value ?? '') as T) ? (value as T) : fallback
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = enumValue(env.NODE_ENV, ['development', 'production', 'test'] as const, 'development')
  const port = int(env.PORT, 8787)

  return {
    nodeEnv,
    port,
    appOrigin: env.APP_ORIGIN?.trim() || `http://127.0.0.1:${port}`,
    databaseUrl: env.DATABASE_URL?.trim() || '.data/signalmess.sqlite',
    // A development fallback keeps the local app usable; production refuses to
    // start without an explicit secret (enforced in assertProductionSafety).
    sessionSecret: env.SESSION_SECRET?.trim() || 'signalmess-local-development-secret',
    sessionTtlSeconds: int(env.SESSION_TTL_SECONDS, 60 * 60 * 24 * 14),

    externalApisEnabled: bool(env.ENABLE_EXTERNAL_APIS, false),
    paidOperationsEnabled: bool(env.ENABLE_PAID_OPERATIONS, false),

    exaApiKey: env.EXA_API_KEY?.trim() || null,
    exaBaseUrl: env.EXA_BASE_URL?.trim() || 'https://api.exa.ai',
    exaSearchType: enumValue(env.EXA_SEARCH_TYPE, ['auto', 'lite', 'deep-lite', 'deep'] as const, 'auto'),
    exaTimeoutMs: int(env.EXA_TIMEOUT_MS, 20_000),

    geminiApiKey: env.GEMINI_API_KEY?.trim() || null,
    geminiModel: env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash',
    geminiBaseUrl: env.GEMINI_BASE_URL?.trim() || 'https://generativelanguage.googleapis.com/v1beta',
    geminiTimeoutMs: int(env.GEMINI_TIMEOUT_MS, 45_000),
    geminiMaxOutputTokens: int(env.GEMINI_MAX_OUTPUT_TOKENS, 4096),
    geminiTemperature: Number.isFinite(Number(env.GEMINI_TEMPERATURE))
      ? Number(env.GEMINI_TEMPERATURE)
      : 0.2,

    researchDailyLimit: int(env.RESEARCH_DAILY_LIMIT, 3),
    analysisDailyLimit: int(env.ANALYSIS_DAILY_LIMIT, 3),
    researchGlobalDailyLimit: int(env.RESEARCH_GLOBAL_DAILY_LIMIT, 30),
    analysisGlobalDailyLimit: int(env.ANALYSIS_GLOBAL_DAILY_LIMIT, 30),
    duplicateGuardSeconds: int(env.DUPLICATE_GUARD_SECONDS, 90),
    apiRateLimitPerMinute: int(env.API_RATE_LIMIT_PER_MINUTE, 120),

    authMode: 'local',
    seedDemoData: bool(env.SEED_DEMO_DATA, false),
  }
}

/** Refuse configurations that would be unsafe in production. */
export function assertProductionSafety(config: AppConfig): void {
  if (config.nodeEnv !== 'production') return
  const problems: string[] = []
  if (config.sessionSecret === 'signalmess-local-development-secret') {
    problems.push('SESSION_SECRET must be set to a private random value in production')
  }
  if (config.sessionSecret.length < 32) {
    problems.push('SESSION_SECRET must be at least 32 characters in production')
  }
  if (config.paidOperationsEnabled && !config.externalApisEnabled) {
    problems.push('ENABLE_PAID_OPERATIONS requires ENABLE_EXTERNAL_APIS=true')
  }
  if (problems.length > 0) {
    throw new Error(`Unsafe production configuration:\n- ${problems.join('\n- ')}`)
  }
}
