import { serve } from '@hono/node-server'
import type { AddressInfo } from 'node:net'
import { createApp } from './app.ts'
import { assertProductionSafety, loadConfig } from './config.ts'
import { createNodeServices, type NodeServices } from './services/node.ts'
import type { AppConfig } from './config.ts'
import { seedDemoData } from './seed.ts'

/**
 * Application builder for the test suites and the local preview.
 *
 * Wraps the Node composition (`createNodeServices` + `createApp`) so the
 * integration and browser tests exercise the same assembly the dev server uses,
 * against an in-memory database.
 */

export interface BuiltApp {
  app: ReturnType<typeof createApp>
  services: NodeServices
  config: AppConfig
  db: NodeServices['db']
  close: () => void
}

export interface BuildOptions {
  /** Override environment values (tests use a fresh in-memory database). */
  env?: Record<string, string | undefined>
  /** Seed the explicitly-labelled demo investigation. */
  seed?: boolean
}

export async function buildApp(options: BuildOptions = {}): Promise<BuiltApp> {
  const env = { ...process.env, ...options.env } as Record<string, string | undefined>
  const config = loadConfig(env, { runtime: 'node' })
  assertProductionSafety(config)

  const services = createNodeServices({ config })
  const app = createApp({
    services,
    config,
    storage: 'sqlite',
    // Mount the administrative action so its authentication is exercised by
    // the HTTP tests. Its tools are unavailable here by design: the migration
    // needs a RecordRoom, which only the Worker runtime has.
    actions: {
      resolveCaller: async (request) => {
        const resolved = await services.auth.resolve(request)
        return resolved?.user.id ?? null
      },
      environment: { OWNER_USER_ID: process.env['OWNER_USER_ID']?.trim() || undefined },
    },
  })

  if (options.seed ?? config.seedDemoData) {
    await seedDemoData(services)
  }

  return {
    app,
    services,
    config,
    db: services.db,
    close: () => services.close(),
  }
}

/**
 * Start a built app on an ephemeral port.
 *
 * Tests need a real socket: cookies, the CSRF origin check and streaming
 * responses only behave correctly against an actual HTTP server.
 */
export async function serveApp(app: ReturnType<typeof createApp>): Promise<{
  base: string
  port: number
  close: () => Promise<void>
}> {
  const server = serve({
    fetch: (request: Request, ...rest: unknown[]) => {
      // The listener exists only for tests and the local preview.
      //
      // Every suite runs in one process and boots its own server on an ephemeral
      // port. Node's global `fetch` pools connections per origin, so a socket
      // belonging to a server that has since been torn down can be reused by a
      // later request and fail with ECONNRESET — in a different suite, only under
      // load. Telling the client to close after each response means no socket is
      // ever pooled, so the failure mode disappears at the source.
      const response = (app.fetch as (...args: unknown[]) => Promise<Response>)(request, ...rest)
      return response.then((result) => {
        const headers = new Headers(result.headers)
        headers.set('connection', 'close')
        return new Response(result.body, {
          status: result.status,
          statusText: result.statusText,
          headers,
        })
      })
    },
    port: 0,
    hostname: '127.0.0.1',
  })
  await new Promise<void>((resolve) => {
    if ('listening' in server && server.listening) resolve()
    else server.once('listening', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    // Destroy idle keep-alive sockets before waiting for the close to settle.
    // `server.close()` only stops accepting new connections and then waits for
    // open ones; a pooled keep-alive socket would hold it open indefinitely.
    // Several suites run in one process, so a lingering listener is inherited by
    // the next suite and eventually shows up as a stray ECONNRESET.
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        // The union type returned by `serve` includes h2c, which has no
        // `closeAllConnections`; narrow before calling it.
        const closable = server as unknown as { closeAllConnections?: () => void }
        closable.closeAllConnections?.()
      }),
  }
}
