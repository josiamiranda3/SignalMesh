import { Hono } from 'hono'
import type { ApiErrorPayload } from '../shared/api.ts'
import { assertProductionSafety, loadConfig, type AppConfig } from './config.ts'
import { openDatabase, type Database } from './db.ts'
import { createServices, type Services } from './services/index.ts'
import { AppError } from './lib/errors.ts'
import { withServices, csrfGuard, type AppEnv } from './http/middleware.ts'
import { createAuthRoutes } from './http/auth-routes.ts'
import { createApiRoutes, toErrorResponse } from './http/api-routes.ts'
import { seedDemoData } from './seed.ts'

/**
 * Application assembly.
 *
 * Exported separately from the process bootstrap so integration tests can build
 * a complete app against an in-memory database and exercise the real HTTP
 * surface, middleware and services.
 */

export interface BuiltApp {
  app: Hono<AppEnv>
  services: Services
  config: AppConfig
  db: Database
  close: () => void
}

export interface BuildOptions {
  /** Override environment values (tests use a fresh in-memory database). */
  env?: Partial<NodeJS.ProcessEnv>
  /** Reuse a database handle instead of opening the configured path. */
  database?: Database
  /** Seed the explicitly-labelled demo investigation. */
  seed?: boolean
}

export async function buildApp(options: BuildOptions = {}): Promise<BuiltApp> {
  const config = loadConfig({ ...process.env, ...options.env })
  assertProductionSafety(config)

  const db = options.database ?? openDatabase(config.databaseUrl)
  const services = createServices(config, db)

  const app = new Hono<AppEnv>()
  app.use('*', withServices(services))

  // Health probe: no auth, no secrets, no internals beyond a status word.
  app.get('/api/health', (c) =>
    c.json({
      success: true as const,
      data: {
        status: 'ok' as const,
        version: '0.1.0',
        time: new Date().toISOString(),
        database: 'ok' as const,
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

  if (options.seed ?? config.seedDemoData) {
    await seedDemoData(services)
  }

  return {
    app,
    services,
    config,
    db,
    close: () => db.close(),
  }
}
