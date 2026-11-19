import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { loadEnvFile } from './lib/env.ts'

// Load `.env` before any module reads configuration. Existing environment
// variables always win, so CI and hosted environments stay authoritative.
loadEnvFile()

const { buildApp } = await import('./app.ts')
const { loadConfig } = await import('./config.ts')

/**
 * Local runtime bootstrap.
 *
 * Serves the API and, when `--serve-dist` is passed (or `dist/` exists and NODE_ENV
 * is production), the built SPA from `dist/`. During development Vite serves the
 * frontend on port 5273 and proxies `/api` here, which keeps hot reload working
 * while the API stays a real Hono server.
 */

async function main(): Promise<void> {
  const serveDist = process.argv.includes('--serve-dist')
  const config = loadConfig()
  const { app, close, services } = await buildApp()

  if (serveDist) {
    // SPA fallback: assets first, then index.html for client routes.
    app.use('*', serveStatic({ root: './dist' }))
    app.get('*', serveStatic({ path: './dist/index.html' }))
  }

  const server = serve(
    {
      fetch: app.fetch,
      port: config.port,
      hostname: '127.0.0.1',
    },
    (info) => {
      console.info(`[signalmess] API em http://127.0.0.1:${info.port}`)
      console.info(`[signalmess] ambiente: ${config.nodeEnv}`)
      console.info(
        `[signalmess] APIs externas: ${config.externalApisEnabled ? 'habilitadas' : 'desativadas'} (ENABLE_EXTERNAL_APIS)`,
      )
      if (config.externalApisEnabled) {
        console.info(`[signalmess] Exa: ${services.exa.configured ? 'chave configurada' : 'SEM CHAVE'}`)
        console.info(`[signalmess] Gemini: ${services.gemini.configured ? 'chave configurada' : 'SEM CHAVE'}`)
      }
      if (!serveDist) console.info('[signalmess] frontend de desenvolvimento: execute "npm run dev:web"')
    },
  )

  const shutdown = (signal: string) => {
    console.info(`[signalmess] encerrando (${signal})`)
    server.close(() => {
      close()
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
