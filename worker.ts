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
import { RecordRoom, authenticatedRoomRequest, verifyJwt } from 'deepspace/worker'
import type { DOBindings, DOManifest } from 'deepspace/worker'
import { schemas } from './src/schemas.ts'
import { assertProductionSafety, loadConfig } from './server/config.ts'
import { createApp } from './server/app.ts'
import { createWorkerServices, createRoomCaller, type RecordRoomNamespace } from './server/services/worker.ts'
import { createApiRoutes } from './server/http/api-routes.ts'
import { createAuthRoutes } from './server/http/auth-routes.ts'
import { createActionTools, registerActionRoutes } from './server/http/action-routes.ts'
import type { AppEnv } from './server/http/middleware.ts'

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
  /**
   * Platform auth-worker base URL, injected by the deploy.
   *
   * The app proxies `/api/auth/*` to it so the browser can obtain a platform
   * JWT (`POST /api/auth/token`) and run the OAuth callback flow. Absent only
   * on a misconfigured deployment, where the proxy fails closed with 503.
   */
  AUTH_WORKER_URL?: string
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
    const bindings = envBag(env)
    const config = loadConfig(bindings, { runtime: 'worker' })
    assertProductionSafety(config, bindings)

    const url = new URL(request.url)

    // ---------------------------------------------------------------------
    // Realtime record room
    // ---------------------------------------------------------------------
    // The SDK's `RecordScope` opens `GET /ws/<roomId>?token=<jwt>`. Without this
    // route the socket upgrade would fall through to the asset layer and the
    // client would retry forever, so the scope must be mounted before anything
    // else. The room id is resolved from the *verified* token, never trusted
    // from the path alone; `authenticatedRoomRequest` also injects the internal
    // identity headers after stripping caller-supplied ones.
    if (url.pathname.startsWith('/ws/')) {
      return handleWebSocket(request, env, config)
    }

    // ---------------------------------------------------------------------
    // API surface
    // ---------------------------------------------------------------------
    if (url.pathname.startsWith('/api/')) {
      const identity = await resolveIdentity(request, env, config)

      // -------------------------------------------------------------------
      // Server actions (privileged surface) — route implemented by SIGNALMESH
      // -------------------------------------------------------------------
      // `/api/actions/*` is our own Hono route, not a platform-mounted one: the
      // SDK supplies the handler contract and the `X-App-Action` transport, but
      // routing, JWT verification and authorization are this worker's job.
      //
      // Mounted before the generic API app so the action route owns its own
      // authentication: it verifies the JWT itself and refuses unknown names,
      // instead of relying on `requireUser` plus a name check scattered across
      // handlers. Each action carries its own policy (`selfScoped`/`ownerOnly`);
      // `migrateRecords` is self-scoped, so any verified caller may migrate
      // their own data and no one else's.
      if (url.pathname.startsWith('/api/actions/')) {
        const actionApp = new Hono<AppEnv>()
        registerActionRoutes(actionApp, {
          // Bearer only. This route is mounted outside `createApp`, so it never
          // passes through `csrfGuard`; accepting a session cookie here would
          // let any page cause a signed-in browser to POST to the privileged
          // surface with an ambient credential. `resolveBearerIdentity` reads the
          // Authorization header and nothing else.
          resolveCaller: async (request) => {
            const resolved = await resolveBearerIdentity(request, env, config)
            return resolved?.userId ?? null
          },
          environment: { OWNER_USER_ID: env.OWNER_USER_ID },
          createTools: (callerId) =>
            createActionTools(
              createRoomCaller({
                env: workerBindings(env) as never,
                userId: callerId,
                // The action surface runs with RBAC off, which is what makes
                // cross-collection work possible. `userBound` still stamps
                // `callerId` on every write, so this cannot create a row for
                // another account; reading another account's row is prevented
                // by the action's own ownership check.
                appAction: true,
              }),
            ),
        })
        return actionApp.fetch(request, env, ctx)
      }

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
      const app = createApp({
        services,
        config,
        storage: 'records',
        authWorkerUrl: env.AUTH_WORKER_URL,
      })
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
 *
 * ## Why `authorizedParties` is passed here too
 *
 * `server/services/worker.ts` configures `AuthResolver` with
 * `authorizedParties: config.authorizedParties`, but that resolver only protects
 * the routes that go through `requireUser`. The privileged `/api/actions/*`
 * surface authenticates through **this** function instead, so before v0.2.4 it
 * verified signature, issuer and expiry but not the `azp` binding — a token
 * minted for a different app of the same platform would have been accepted
 * here while being refused everywhere else. Both paths now share the same
 * policy; `config` is the single source of truth.
 *
 * The semantics are the SDK's, not ours: `verifyJwt` matches `azp` against the
 * configured patterns and **accepts a token with no `azp` claim**, because the
 * platform does not always set one. That is a narrowing of an otherwise valid
 * token, not the only control — signature, issuer and expiry are still enforced
 * inside `verifyJwt`.
 */
async function resolveIdentity(
  request: Request,
  env: Env,
  config: ReturnType<typeof loadConfig>,
): Promise<{ userId: string } | null> {
  const header = request.headers.get('authorization')
  const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : null
  const cookies = request.headers.get('cookie') ?? ''
  const cookieToken =
    /(?:^|;\s*)__Secure-better-auth\.session_token=([^;]+)/.exec(cookies)?.[1] ??
    /(?:^|;\s*)better-auth\.session_token=([^;]+)/.exec(cookies)?.[1] ??
    null

  const token = bearer ?? (cookieToken ? decodeURIComponent(cookieToken) : null)
  if (!token) return null

  return verifyPlatformToken(token, env, config)
}

/**
 * Bearer-only identity, for the privileged action surface.
 *
 * Identical verification to `resolveIdentity` — same `verifyJwt` call, same
 * issuer, same `authorizedParties` — but the **only** accepted source is the
 * `Authorization: Bearer` header.
 *
 * ## Why the action surface cannot accept a cookie
 *
 * `/api/actions/*` is mounted on its own Hono instance, before the app that
 * carries `csrfGuard`. A cookie is an ambient credential: the browser attaches
 * it to any request for this origin, including one a third-party page caused.
 * With no CSRF middleware on this path, a cookie would be enough to drive a
 * privileged write from another site. A bearer token is explicit — a
 * cross-origin page cannot set the header without a preflight this app never
 * grants, and cannot read the token to set it. Requiring it here restores the
 * property the middleware would otherwise have provided.
 */
async function resolveBearerIdentity(
  request: Request,
  env: Env,
  config: ReturnType<typeof loadConfig>,
): Promise<{ userId: string } | null> {
  const header = request.headers.get('authorization')
  const bearer = header?.startsWith('Bearer ') ? header.slice(7).trim() : null
  if (!bearer) return null

  return verifyPlatformToken(bearer, env, config)
}

/**
 * Verify a platform JWT.
 *
 * Shared by both resolution paths so the cryptographic policy — signature,
 * issuer, expiry, `authorizedParties` — is written once and cannot drift between
 * the general API and the privileged action surface.
 */
async function verifyPlatformToken(
  token: string,
  env: Env,
  config: ReturnType<typeof loadConfig>,
): Promise<{ userId: string } | null> {
  // The platform injects these; without them nothing can be verified.
  if (!env.AUTH_JWT_PUBLIC_KEY || !env.AUTH_JWT_ISSUER) return null

  // Same shape `AuthResolver` builds: the property is omitted when the list is
  // empty, so `verifyJwt` sees "no party constraint" rather than "match nothing".
  const verifierConfig: {
    publicKey: string
    issuer: string
    authorizedParties?: string[]
  } = { publicKey: env.AUTH_JWT_PUBLIC_KEY, issuer: env.AUTH_JWT_ISSUER }
  if (config.authorizedParties.length > 0) {
    verifierConfig.authorizedParties = config.authorizedParties
  }

  const outcome = await verifyJwt(verifierConfig, token)
  const result = outcome.result as { userId?: string } | null
  if (!result?.userId) return null

  return { userId: result.userId }
}

/**
 * Minimal app for unauthenticated requests.
 *
 * It mounts the health probe and the auth routes so a signed-out browser can
 * read `/api/auth/config` **and complete sign-in**: the platform proxy mounted
 * by `createApp` is what serves `/api/auth/token` and the OAuth callbacks, and
 * those requests arrive without a credential by definition. Mounting the app
 * without `authWorkerUrl` here would leave a signed-out visitor unable to sign
 * in at all.
 */
function createPublicApp(
  services: ReturnType<typeof createWorkerServices>,
  config: ReturnType<typeof loadConfig>,
  env: Env,
): Hono {
  const app = createApp({
    services,
    config,
    storage: 'records',
    authWorkerUrl: env.AUTH_WORKER_URL,
  })
  // The full app already mounts auth routes; this wrapper exists so the intent
  // is explicit at the call site.
  void createApiRoutes
  void createAuthRoutes
  return app as unknown as Hono
}

/**
 * WebSocket upgrade for the record room.
 *
 * `RecordScope` connects to `GET /ws/<roomId>?token=<jwt>`; the room id the
 * client asks for is `app:<APP_ID>`. The client-supplied id is only used to
 * name the room — identity comes from the verified token, and the request is
 * rewritten by `authenticatedRoomRequest` so caller-supplied identity headers
 * are removed before the Durable Object sees it.
 *
 * A missing or invalid token is refused here rather than at the DO, so an
 * anonymous visitor cannot open a socket and sit in a reconnect loop.
 */
async function handleWebSocket(
  request: Request,
  env: Env,
  config: ReturnType<typeof loadConfig>,
): Promise<Response> {
  // The upgrade itself needs the pairing header; a plain HTTP GET to /ws/* is
  // not a socket and gets a clear 400 rather than a confusing DO error.
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('Expected a WebSocket upgrade', { status: 426 })
  }

  const url = new URL(request.url)
  const token = url.searchParams.get('token')
  if (!token) return new Response('Unauthorized', { status: 401 })
  if (!env.AUTH_JWT_PUBLIC_KEY || !env.AUTH_JWT_ISSUER) {
    // Fail closed: without verifier material no socket may open.
    return new Response('Unauthorized', { status: 401 })
  }

  const socketConfig: {
    publicKey: string
    issuer: string
    authorizedParties?: string[]
  } = { publicKey: env.AUTH_JWT_PUBLIC_KEY, issuer: env.AUTH_JWT_ISSUER }
  if (config.authorizedParties.length > 0) socketConfig.authorizedParties = config.authorizedParties

  const outcome = await verifyJwt(socketConfig, token)
  const auth = outcome.result as { userId?: string; claims?: Record<string, unknown> } | null
  if (!auth?.userId) return new Response('Unauthorized', { status: 401 })

  // Resolve the room from the verified app id, never from the path segment.
  // `roomId` in the path is client input; a caller that names another app's room
  // would otherwise be routed to a namespace this worker cannot serve anyway,
  // but pinning it here keeps the behaviour explicit and auditable.
  const scopeId = `app:${env.DEEPSPACE_APP_ID}`
  const requested = url.pathname.replace(/^\/ws\/?/, '')
  if (requested && decodeURIComponent(requested) !== scopeId) {
    // Only the app's own scope is served by this worker.
    if (!decodeURIComponent(requested).startsWith('app:')) {
      return new Response('Not found', { status: 404 })
    }
  }

  const roomRequest = authenticatedRoomRequest(
    request,
    { userId: auth.userId, claims: auth.claims ?? {} } as never,
  )

  const stub = env.RECORD_ROOMS.get(env.RECORD_ROOMS.idFromName(scopeId))
  return stub.fetch(roomRequest)
}
