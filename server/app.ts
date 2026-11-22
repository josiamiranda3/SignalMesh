import { Hono } from 'hono'
import type { ApiErrorPayload } from '../shared/api.ts'
import type { AppConfig } from './config.ts'
import type { Services } from './services/index.ts'
import { AppError } from './lib/errors.ts'
import { withServices, csrfGuard, type AppEnv } from './http/middleware.ts'
import { createAuthRoutes } from './http/auth-routes.ts'
import { createAuthProxyRoutes, createSocialRedirectRoutes, isPlatformAuthPath } from './http/auth-proxy.ts'
import { createApiRoutes, toErrorResponse } from './http/api-routes.ts'
import { registerActionRoutes } from './http/action-routes.ts'
import type { ActionToolsPort } from './actions/types.ts'

/**
 * Application assembly.
 *
 * Platform-neutral: it takes an already-wired `Services` bundle and mounts the
 * routes. It imports nothing from Node and nothing from the Worker, so the same
 * app object runs under `@hono/node-server` and inside a Cloudflare Worker.
 *
 * Mounting order is part of the contract:
 *   1. services on every request
 *   2. health probe (no auth, no secrets)
 *   3. CSRF guard on `/api/*`
 *   4. auth routes
 *   5. business routes
 *   6. not-found and error handlers
 */

export interface CreateAppOptions {
  services: Services
  config: AppConfig
  /** Report the storage backend in the health payload. */
  storage: 'sqlite' | 'records'
  /**
   * Wire the server-action surface.
   *
   * Both runtimes mount the same route; only identity resolution differs
   * (verified JWT on the Worker, local session under Node). That keeps one
   * behaviour for the administrative path and lets the HTTP tests exercise it.
   */
  actions?: {
    resolveCaller: (request: Request) => Promise<string | null>
    environment: { OWNER_USER_ID?: string }
  }
  /**
   * Platform auth-worker base URL (`AUTH_WORKER_URL`), injected by the deploy.
   *
   * Present only on the Worker runtime; the Node runtime has no auth worker and
   * mounts no proxy.
   */
  authWorkerUrl?: string
}

export function createApp(options: CreateAppOptions): Hono<AppEnv> {
  const { services, config, storage, actions, authWorkerUrl } = options

  const app = new Hono<AppEnv>()
  app.use('*', withServices(services))

  // Health probe: no auth, no secrets, nothing beyond a status word.
  app.get('/api/health', (c) =>
    c.json({
      success: true as const,
      data: {
        status: 'ok' as const,
        version: '0.2.4.3',
        time: new Date().toISOString(),
        database: 'ok' as const,
        storage,
        runtime: config.runtime,
        authMode: config.authMode,
      },
    }),
  )

  // CSRF guard for the app's own API surface.
  //
  // Scope, and why it is explicit rather than a blanket `/api/*`:
  // the SDK's browser client drives the platform auth worker through this
  // origin (`POST /api/auth/token` from `getAuthToken()`, `signIn.email()`,
  // `signOut()`, the OAuth callbacks). Those requests carry no
  // `x-signalmess-request` marker — that header is this app's convention, and
  // the auth worker knows nothing about it. A blanket guard therefore answered
  // **403 before the proxy ran**, so a signed-in browser could never obtain the
  // JWT that `resolveIdentity` requires, and every authenticated route looked
  // like "not logged in".
  //
  // The exemption is exactly the set the proxy forwards (`isPlatformAuthPath`,
  // one source of truth with `auth-proxy.ts`). Those requests are not
  // unauthenticated: the platform session cookie is their credential, and the
  // auth worker validates it and applies its own CSRF/origin checks. The app
  // adds no trust of its own — the proxy forwards and copies, it never reads an
  // identity header.
  //
  // Everything the app owns stays guarded: `/api/auth/config`, `/me`, `/login`,
  // `/logout` are NOT in that set, so they keep the marker requirement, and so
  // does the entire rest of `/api/*`.
  app.use('/api/*', async (c, next) => {
    if (isPlatformAuthPath(new URL(c.req.url).pathname)) return next()
    return csrfGuard(services)(c, next)
  })
  app.route('/api/auth', createAuthRoutes())

  // Platform auth proxy. Registered **after** the app's own auth routes so the
  // owned endpoints (`/config`, `/me`, `/login`, `/logout`) keep precedence, and
  // before the generic API router so `/api/auth/token` and the OAuth callbacks
  // reach the auth worker instead of the app's 404 handler.
  //
  // Only the Worker runtime has an auth worker to forward to; the Node runtime
  // authenticates through its local adapter, and a request that falls through
  // here still gets the owned routes above.
  if (config.authMode === 'deepspace') {
    // `/social-redirect` first: it is app-owned (the platform does not implement
    // it), so it must be registered before the catch-all proxy that would
    // otherwise forward it upstream and get a 404.
    app.route('/api/auth', createSocialRedirectRoutes({ authWorkerUrl: authWorkerUrl, appOrigin: config.appOrigin }))
    app.route('/api/auth', createAuthProxyRoutes({ authWorkerUrl: authWorkerUrl }))
  }

  if (actions) {
    registerActionRoutes(app as unknown as Hono<AppEnv>, {
      resolveCaller: actions.resolveCaller,
      environment: actions.environment,
      createTools: () => createUnavailableTools(),
    })
  }

  app.route('/api', createApiRoutes())

  app.notFound((c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.json(
        {
          success: false,
          error: { code: 'not_found', message: 'Endpoint não encontrado', retryable: false },
        },
        404,
      )
    }
    return c.text('Not found', 404)
  })

  app.onError((error, c) => {
    const { status, body } = toErrorResponse(error)

    // Log operational context for real failures, never credentials or bodies.
    if (!(error instanceof AppError) || status >= 500) {
      const requestId = c.get('requestId')
      console.error(
        `[api] ${c.req.method} ${new URL(c.req.url).pathname} → ${status} (request ${requestId})`,
        error instanceof Error ? error.message : String(error),
      )
    }

    return c.json(body as { success: false; error: ApiErrorPayload }, status as never)
  })

  return app
}

/**
 * Tools for runtimes without a RecordRoom.
 *
 * The Node runtime stores data in SQLite and has no Durable Object, so the
 * migration action — which exists to reach one — cannot run there. Rather than
 * simulate it (which would let a test "pass" against a path production does not
 * have), every tool reports why it is unavailable. The Worker supplies the real
 * tools; see `worker.ts`.
 */
function createUnavailableTools(): ActionToolsPort {
  const unavailable = async (): Promise<never> => {
    throw new Error('A ação de migração requer o runtime DeepSpace (RecordRoom).')
  }
  return {
    create: unavailable,
    update: unavailable,
    get: unavailable,
    query: unavailable,
  } as unknown as ActionToolsPort
}