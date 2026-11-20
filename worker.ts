/**
 * Cloudflare Worker entry point.
 *
 * This is the production runtime. `npx deepspace dev start` runs it locally with
 * the platform services, and `npx deepspace deploy` ships it.
 *
 * Responsibilities, and nothing else:
 *   1. declare the Durable Object manifest the deploy reads
 *   2. export the `RecordRoom` subclass that owns the app's collections
 *   3. build a Hono app per request, bound to the verified caller's identity
 *   4. serve the built SPA for non-API routes
 *
 * Business logic lives in `server/`. This file must stay assembly only.
 */

import type { Hono } from 'hono'
import { RecordRoom } from 'deepspace/worker'
import type { DOBindings, DOManifest } from 'deepspace/worker'
import { schemas } from './src/schemas.ts'
import { assertProductionSafety, loadConfig } from './server/config.ts'
import { createApp } from './server/app.ts'
import { createWorkerServices, type RecordRoomNamespace } from './server/services/worker.ts'
import { createApiRoutes } from './server/http/api-routes.ts'
import { createAuthRoutes } from './server/http/auth-routes.ts'

/**
 * Durable Object manifest.
 *
 * The deploy reads this to create the app's bindings. `deepspace dev start` and
 * `worker.ts`'s own `export class` declarations must agree with it — the
 * classes below are the ones listed here.
 */
export const __DO_MANIFEST__ = [
  { binding: 'RECORD_ROOMS', className: 'AppRecordRoom', sqlite: true },
] as const satisfies DOManifest

export interface Env extends DOBindings<typeof __DO_MANIFEST__> {
  /** Static assets produced by `vite build`. */
  ASSETS: Fetcher
  /** Immutable app identity, injected from wrangler.toml by the platform. */
  DEEPSPACE_APP_ID: string
  APP_NAME: string
  /** Platform-injected JWT verification material — never a shared secret. */
  AUTH_JWT_PUBLIC_KEY: string
  AUTH_JWT_ISSUER: string
  /** The account that owns this app; used by the admin transport. */
  OWNER_USER_ID: string

  // --- SignalMesh configuration (secrets + vars) --------------------------
  APP_ORIGIN?: string
  ALLOWED_ORIGINS?: string

  ENABLE_EXTERNAL_APIS?: string
  ENABLE_PAID_OPERATIONS?: string
  EXA_API_KEY?: string
  EXA_BASE_URL?: string
  EXA_SEARCH_TYPE?: string
  EXA_TIMEOUT_MS?: string
  GEMINI_API_KEY?: string
  GEMINI_MODEL?: string
  GEMINI_BASE_URL?: string
  GEMINI_TIMEOUT_MS?: string
  GEMINI_MAX_OUTPUT_TOKENS?: string
  GEMINI_TEMPERATURE?: string

  RESEARCH_DAILY_LIMIT?: string
  ANALYSIS_DAILY_LIMIT?: string
  RESEARCH_GLOBAL_DAILY_LIMIT?: string
  ANALYSIS_GLOBAL_DAILY_LIMIT?: string
  DUPLICATE_GUARD_SECONDS?: string
  API_RATE_LIMIT_PER_MINUTE?: string

  SEED_DEMO_DATA?: string
  NODE_ENV?: string
}

/**
 * The app's record room.
 *
 * `super(state, env, schemas, …)` bakes the collection schemas into the room, so
 * the Durable Object enforces `permissions` and `uniqueOn` for every write.
 * `ownerUserId` makes the app owner an admin of their own room.
 */
export class AppRecordRoom extends RecordRoom<Env> {
  constructor(state: DurableObjectState, env: Env) {
    super(state, env, schemas, { ownerUserId: env.OWNER_USER_ID })
  }
}

/** Collect the Worker bindings into the `EnvBag` the config loader expects. */
function envBag(env: Env): Record<string, string | undefined> {
  const bag: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') bag[key] = value
  }
  return bag
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const config = loadConfig(envBag(env), { runtime: 'worker' })
    assertProductionSafety(config)

    const url = new URL(request.url)

    // ---------------------------------------------------------------------
    // API surface
    // ---------------------------------------------------------------------
    if (url.pathname.startsWith('/api/')) {
      const identity = await resolveIdentity(request, env, config)

      // An unauthenticated request still needs the app mounted so it can get a
      // structured 401 from `requireUser` rather than a bare runtime error.
      if (!identity) {
        const services = createWorkerServices({
          config,
          bindings: workerBindings(env),
          userId: 'anonymous',
          ownerUserId: env.OWNER_USER_ID,
        })
        const app = createPublicApp(services, config, env)
        return app.fetch(request, env, ctx)
      }

      const services = createWorkerServices({
        config,
        bindings: workerBindings(env),
        userId: identity.userId,
        ownerUserId: env.OWNER_USER_ID,
      })
      const app = createApp({ services, config, storage: 'records' })
      return app.fetch(request, env, ctx)
    }

    // ---------------------------------------------------------------------
    // Static assets and SPA fallback
    // ---------------------------------------------------------------------
    const asset = await env.ASSETS.fetch(request)
    if (asset.status !== 404) return asset

    // A request for a file (has an extension) that missed must 404, not return
    // the shell — otherwise a deleted chunk parses as HTML and the page dies.
    const last = url.pathname.slice(url.pathname.lastIndexOf('/') + 1)
    if (last.includes('.')) {
      return new Response(JSON.stringify({ error: 'not_found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      })
    }

    const shellUrl = new URL(request.url)
    shellUrl.pathname = '/index.html'
    return env.ASSETS.fetch(new Request(shellUrl.toString(), request))
  },
} satisfies ExportedHandler<Env>

/** Narrow the Env into the record-room shape the services need. */
function workerBindings(env: Env): {
  RECORD_ROOMS: RecordRoomNamespace
  DEEPSPACE_APP_ID: string
  AUTH_JWT_PUBLIC_KEY?: string
  AUTH_JWT_ISSUER?: string
  OWNER_USER_ID?: string
} {
  return {
    RECORD_ROOMS: env.RECORD_ROOMS as unknown as RecordRoomNamespace,
    DEEPSPACE_APP_ID: env.DEEPSPACE_APP_ID,
    AUTH_JWT_PUBLIC_KEY: env.AUTH_JWT_PUBLIC_KEY,
    AUTH_JWT_ISSUER: env.AUTH_JWT_ISSUER,
    OWNER_USER_ID: env.OWNER_USER_ID,
  }
}

/**
 * Resolve the caller from the platform JWT.
 *
 * Done twice: here (to bind the record transport) and inside `requireUser` (to
 * authorize the route). The duplication is deliberate — the transport must be
 * bound to the caller *before* any repository call can happen, and the route
 * must independently refuse an unauthenticated request.
 */
async function resolveIdentity(
  request: Request,
  env: Env,
  config: ReturnType<typeof loadConfig>,
): Promise<{ userId: string } | null> {
  const { verifyJwt } = await import('deepspace/worker')

  const header = request.headers.get('authorization')
  const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : null
  const cookies = request.headers.get('cookie') ?? ''
  const cookieToken =
    /(?:^|;\s*)__Secure-better-auth\.session_token=([^;]+)/.exec(cookies)?.[1] ??
    /(?:^|;\s*)better-auth\.session_token=([^;]+)/.exec(cookies)?.[1] ??
    null

  const token = bearer ?? (cookieToken ? decodeURIComponent(cookieToken) : null)
  if (!token) return null

  // The platform injects these; without them nothing can be verified.
  if (!env.AUTH_JWT_PUBLIC_KEY || !env.AUTH_JWT_ISSUER) return null

  const outcome = await verifyJwt(
    { publicKey: env.AUTH_JWT_PUBLIC_KEY, issuer: env.AUTH_JWT_ISSUER },
    token,
  )
  const result = outcome.result as { userId?: string } | null
  if (!result?.userId) return null

  // Reserved: `config` is threaded for future audience/party checks.
  void config
  return { userId: result.userId }
}

/**
 * Minimal app for unauthenticated requests.
 *
 * It mounts the health probe and the auth routes so a signed-out browser can
 * read `/api/auth/config`, and lets every private route answer 401 through the
 * normal middleware.
 */
function createPublicApp(
  services: ReturnType<typeof createWorkerServices>,
  config: ReturnType<typeof loadConfig>,
  _env: Env,
): Hono {
  const app = createApp({ services, config, storage: 'records' })
  // The full app already mounts auth routes; this wrapper exists so the intent
  // is explicit at the call site.
  void createApiRoutes
  void createAuthRoutes
  return app as unknown as Hono
}
