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
  const app = createApp({ services, config, storage: 'sqlite' })

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
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise<void>((resolve) => {
    if ('listening' in server && server.listening) resolve()
    else server.once('listening', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
