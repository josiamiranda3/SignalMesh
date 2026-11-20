/**
 * Runtime configuration.
 *
 * Values come from the environment; nothing here reads a file or a database.
 * The same loader serves both runtimes: `process.env` under Node and the
 * Worker's `env` bindings on DeepSpace. Nothing in this module touches Node
 * APIs, so it can be imported by the worker bundle.
 *
 * Two pairs of switches matter:
 *
 *  - `ENABLE_EXTERNAL_APIS` / `ENABLE_PAID_OPERATIONS` are the cost kill
 *    switches. Both default to `false`; when off, research and analysis refuse
 *    before any network call.
 *  - `authMode` and `persistence` are derived, not invented: the runtime decides
 *    them (`deepspace` + `records` on the platform, `local` + `sqlite` under
 *    Node), so a deployed app cannot be pointed at the development adapter.
 */

export type AuthMode = 'local' | 'deepspace'
export type PersistenceKind = 'sqlite' | 'records'
export type RuntimeKind = 'node' | 'worker'

export interface AppConfig {
  /** Deployment environment, for copy and safety checks. */
  nodeEnv: 'development' | 'production' | 'test'
  runtime: RuntimeKind
  /** Port for the local Node server; ignored by the Worker. */
  port: number
  /** Absolute origin the app is served from; used for cookie and CORS policy. */
  appOrigin: string
  /** Extra origins accepted by the CSRF origin check (preview hosts). */
  allowedOrigins: string[]
  /**
   * Origins a platform JWT may be bound to (zp).
   *
   * Derived from the app origin; used by the auth resolver to refuse a token
   * minted for a different app. Empty disables the check.
   */
  authorizedParties: string[]
  /** SQLite file used only by the local Node runtime. */
  databaseUrl: string
  sessionSecret: string
  sessionTtlSeconds: number

  /** Identity source. Selected by the runtime, never by the client. */
  authMode: AuthMode
  /** Storage backend. Selected by the runtime. */
  persistence: PersistenceKind

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

  /** Seed the explicitly-labelled demo investigation (local evaluation only). */
  seedDemoData: boolean
}

/** Environment bag: `process.env` or Worker bindings, both string-valued. */
export type EnvBag = Record<string, string | undefined>

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

/**
 * Origins a platform token may be presented from.
 *
 * AZP_ORIGINS wins when set; otherwise the app's own origin (plus any allowed
 * origin) is used. Under the local Node runtime this list is empty because no
 * platform token is ever verified.
 */
function buildAuthorizedParties(env: EnvBag, appOrigin: string): string[] {
  const explicit = list(env['AZP_ORIGINS'])
  if (explicit.length > 0) return explicit
  return [appOrigin]
}

function list(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

export interface LoadConfigOptions {
  /**
   * Which runtime is loading the config.
   *
   * `worker` forces `authMode: 'deepspace'` and `persistence: 'records'`: the
   * platform runtime must never fall back to the development identity adapter or
   * to a local SQLite file, which does not exist there.
   */
  runtime?: RuntimeKind
}

export function loadConfig(env: EnvBag = {}, options: LoadConfigOptions = {}): AppConfig {
  const runtime: RuntimeKind = options.runtime ?? 'node'
  const nodeEnv = enumValue(
    env['NODE_ENV'],
    ['development', 'production', 'test'] as const,
    runtime === 'worker' ? 'production' : 'development',
  )
  const port = int(env['PORT'], 8787)

  // The platform supplies its own origin through APP_ORIGIN when configured;
  // otherwise the app is same-origin and the CSRF check accepts the request's
  // own origin (see csrfGuard).
  const appOrigin = env['APP_ORIGIN']?.trim() || `http://127.0.0.1:${port}`

  // Auth and persistence are properties of the runtime, not of a variable the
  // client could influence. `deepspace dev start` sets APP_ID, which marks the
  // platform runtime even though it is local.
  const onPlatform = runtime === 'worker' || Boolean(env['DEEPSPACE_APP_ID']?.trim())

  return {
    nodeEnv,
    runtime,
    port,
    appOrigin,
    allowedOrigins: list(env['ALLOWED_ORIGINS']),
    authorizedParties: buildAuthorizedParties(env, appOrigin),
    databaseUrl: env['DATABASE_URL']?.trim() || '.data/signalmess.sqlite',
    sessionSecret: env['SESSION_SECRET']?.trim() || 'signalmess-local-development-secret',
    sessionTtlSeconds: int(env['SESSION_TTL_SECONDS'], 60 * 60 * 24 * 14),

    authMode: onPlatform ? 'deepspace' : 'local',
    persistence: onPlatform ? 'records' : 'sqlite',

    externalApisEnabled: bool(env['ENABLE_EXTERNAL_APIS'], false),
    paidOperationsEnabled: bool(env['ENABLE_PAID_OPERATIONS'], false),

    exaApiKey: env['EXA_API_KEY']?.trim() || null,
    exaBaseUrl: env['EXA_BASE_URL']?.trim() || 'https://api.exa.ai',
    exaSearchType: enumValue(env['EXA_SEARCH_TYPE'], ['auto', 'lite', 'deep-lite', 'deep'] as const, 'auto'),
    exaTimeoutMs: int(env['EXA_TIMEOUT_MS'], 20_000),

    geminiApiKey: env['GEMINI_API_KEY']?.trim() || null,
    geminiModel: env['GEMINI_MODEL']?.trim() || 'gemini-2.5-flash',
    geminiBaseUrl: env['GEMINI_BASE_URL']?.trim() || 'https://generativelanguage.googleapis.com/v1beta',
    geminiTimeoutMs: int(env['GEMINI_TIMEOUT_MS'], 45_000),
    geminiMaxOutputTokens: int(env['GEMINI_MAX_OUTPUT_TOKENS'], 4096),
    geminiTemperature: Number.isFinite(Number(env['GEMINI_TEMPERATURE']))
      ? Number(env['GEMINI_TEMPERATURE'])
      : 0.2,

    researchDailyLimit: int(env['RESEARCH_DAILY_LIMIT'], 3),
    analysisDailyLimit: int(env['ANALYSIS_DAILY_LIMIT'], 3),
    researchGlobalDailyLimit: int(env['RESEARCH_GLOBAL_DAILY_LIMIT'], 30),
    analysisGlobalDailyLimit: int(env['ANALYSIS_GLOBAL_DAILY_LIMIT'], 30),
    duplicateGuardSeconds: int(env['DUPLICATE_GUARD_SECONDS'], 90),
    apiRateLimitPerMinute: int(env['API_RATE_LIMIT_PER_MINUTE'], 120),

    seedDemoData: bool(env['SEED_DEMO_DATA'], false),
  }
}

/**
 * Refuse configurations that would be unsafe.
 *
 * The checks are about *exposure*, not about deployment: a Worker holding a
 * weak session secret is harmless only if the local adapter is unreachable, and
 * this function is what guarantees that the combination is never accepted.
 */
export function assertProductionSafety(config: AppConfig): void {
  const problems: string[] = []

  if (config.paidOperationsEnabled && !config.externalApisEnabled) {
    problems.push('ENABLE_PAID_OPERATIONS requires ENABLE_EXTERNAL_APIS=true')
  }

  // The local adapter trusts the email the caller types. It must never be the
  // identity source outside a controlled development machine.
  if (config.runtime === 'worker' && config.authMode !== 'deepspace') {
    problems.push('The worker runtime requires DeepSpace authentication; the local adapter is test-only')
  }

  if (config.nodeEnv === 'production' && config.authMode === 'local') {
    problems.push('NODE_ENV=production requires DeepSpace authentication, not the local adapter')
  }

  if (problems.length > 0) {
    throw new Error(`Unsafe configuration:\n- ${problems.join('\n- ')}`)
  }
}
