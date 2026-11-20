import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { loadEnvFile } from './lib/env.ts'

// Load `.env` before any module reads configuration. Existing environment
// variables always win, so CI and hosted environments stay authoritative.
loadEnvFile()

const { assertProductionSafety, loadConfig } = await import('./config.ts')
const { createApp } = await import('./app.ts')
const { createNodeServices } = await import('./services/node.ts')
const { seedDemoData } = await import('./seed.ts')

/**
 * Local Node runtime.
 *
 * Development and testing only. The production runtime is the Cloudflare Worker
 * (`worker.ts`) under `npx deepspace dev start` / `deepspace deploy`; this file
 * exists so the same application can be exercised without the platform, and so
 * the SQLite adapter stays a first-class, testable implementation.
 *
 * `createNodeServices` refuses to run on the DeepSpace runtime, so this entry
 * point cannot become a production back door.
 */

async function main(): Promise<void> {
  const serveDist = process.argv.includes('--serve-dist')
  const config = loadConfig(process.env, { runtime: 'node' })
  assertProductionSafety(config)

  const services = createNodeServices({ config })
  const app = createApp({ services, config, storage: 'sqlite' })

  if (serveDist) {
    app.use('*', serveStatic({ root: './dist' }))
    app.get('*', serveStatic({ path: './dist/index.html' }))
  }

  if (config.seedDemoData) {
    await seedDemoData(services)
  }

  const server = serve({ fetch: app.fetch, port: config.port, hostname: '127.0.0.1' }, (info) => {
    console.info(`[signalmess] API em http://127.0.0.1:${info.port}`)
    console.info(`[signalmess] runtime: node · persistência: sqlite · autenticação: ${config.authMode}`)
    console.info(
      `[signalmess] APIs externas: ${config.externalApisEnabled ? 'habilitadas' : 'desativadas'} (ENABLE_EXTERNAL_APIS)`,
    )
    if (config.externalApisEnabled) {
      console.info(`[signalmess] Exa: ${services.exa.configured ? 'chave configurada' : 'SEM CHAVE'}`)
      console.info(`[signalmess] Gemini: ${services.gemini.configured ? 'chave configurada' : 'SEM CHAVE'}`)
    }
    if (!serveDist) console.info('[signalmess] frontend de desenvolvimento: execute "npm run dev:web"')
  })

  const shutdown = (signal: string) => {
    console.info(`[signalmess] encerrando (${signal})`)
    server.close(() => {
      services.close()
      process.exit(0)
    })
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((error: unknown) => {
  console.error('[signalmess] falha ao iniciar:', error instanceof Error ? error.message : error)
  process.exit(1)
})
