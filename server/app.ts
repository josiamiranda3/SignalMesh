import { Hono } from 'hono'
import type { ApiErrorPayload } from '../shared/api.ts'
import type { AppConfig } from './config.ts'
import type { Services } from './services/index.ts'
import { AppError } from './lib/errors.ts'
import { withServices, csrfGuard, type AppEnv } from './http/middleware.ts'
import { createAuthRoutes } from './http/auth-routes.ts'
import { createApiRoutes, toErrorResponse } from './http/api-routes.ts'

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
}

export function createApp(options: CreateAppOptions): Hono<AppEnv> {
  const { services, config, storage } = options

  const app = new Hono<AppEnv>()
  app.use('*', withServices(services))

  // Health probe: no auth, no secrets, nothing beyond a status word.
  app.get('/api/health', (c) =>
    c.json({
      success: true as const,
      data: {
        status: 'ok' as const,
        version: '0.2.0',
        time: new Date().toISOString(),
        database: 'ok' as const,
        storage,
        runtime: config.runtime,
        authMode: config.authMode,
      },
    }),
  )

  app.use('/api/*', csrfGuard(services))
  app.route('/api/auth', createAuthRoutes())
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
