/**
 * SPA routing verification against the built assets.
 *
 * Mirrors `worker.ts` exactly: asset layer first; a miss with a file extension is a
 * JSON 404; a route-shaped miss gets the SPA shell. That is the rule the
 * `run_worker_first` SPA routes now let run, because they reach the Worker instead
 * of being answered (307) by the asset layer.
 *
 * The Cloudflare-side half — that `run_worker_first` is actually published — cannot
 * be exercised here; it is asserted against the config in
 * `tests/integration/worker-routing.test.ts` and confirmed in the build artifact.
 *
 * Run: node --experimental-transform-types tests/e2e/audit-spa-routing.ts
 */

import { buildApp } from '../../server/bootstrap.ts'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { spaRoot } from './dist-root.ts'

const PORT = 8888
const BASE = `http://127.0.0.1:${PORT}`
const spa = spaRoot()

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  if (!ok) {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  } else console.log(`  ok    ${label}`)
}

const built = await buildApp({
  env: {
    NODE_ENV: 'development',
    DATABASE_URL: ':memory:',
    PORT: String(PORT),
    APP_ORIGIN: BASE,
    ENABLE_EXTERNAL_APIS: 'false',
    SEED_DEMO_DATA: 'false',
  },
})
built.app.use('*', serveStatic({ root: spa.root }))
const serveShell = serveStatic({ path: spa.index })
built.app.get('*', async (c) => {
  const { pathname } = new URL(c.req.url)
  const last = pathname.slice(pathname.lastIndexOf('/') + 1)
  if (last.includes('.')) return c.json({ error: 'not_found' }, 404)
  // `serveStatic` writes to the context and resolves `void`; return its response
  // when it produced one so the handler always yields a Response.
  const response = await serveShell(c, async () => {})
  return response ?? c.body(null, 404)
})
const server = serve({ fetch: built.app.fetch, port: PORT, hostname: '127.0.0.1' })
await new Promise((r) => setTimeout(r, 500))

async function probe(path: string, method = 'GET'): Promise<{ status: number; type: string | null; location: string | null }> {
  const response = await fetch(`${BASE}${path}`, { method, redirect: 'manual' })
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    location: response.headers.get('location'),
  }
}

try {
  console.log('=== 1. SPA route families serve the shell (200, no redirect) ===')
  const FAMILIES: Array<[string, string[]]> = [
    ['login', ['/login']],
    ['dashboard', ['/dashboard', '/dashboard/x']],
    ['investigations', ['/investigations', '/investigations/new', '/investigations/inv_1', '/investigations/inv_1/evidence']],
    ['validation', ['/validation', '/validation/xyz']],
    ['history', ['/history', '/history/2026']],
    ['settings', ['/settings']],
  ]
  for (const [family, routes] of FAMILIES) {
    for (const route of routes) {
      const result = await probe(route)
      check(result.status === 200, `${family}: ${route} -> 200`, String(result.status))
      check(result.location === null, `${family}: ${route} does not redirect`, result.location ?? '')
      check((result.type ?? '').includes('text/html'), `${family}: ${route} serves HTML`, result.type ?? '')
    }
  }

  console.log('\n=== 2. the shell is the SPA, not an error page ===')
  const html = await (await fetch(`${BASE}/login`)).text()
  check(html.includes('<div id="root">'), 'shell contains the React root')
  check(/<script[^>]+type="module"/.test(html), 'shell loads the app bundle')

  console.log('\n=== 3. HEAD behaves like GET (no method-dependent redirect) ===')
  for (const route of ['/login', '/dashboard', '/history']) {
    const head = await probe(route, 'HEAD')
    check(head.status === 200, `HEAD ${route} -> 200`, String(head.status))
    check(head.location === null, `HEAD ${route} does not redirect`)
  }

  console.log('\n=== 4. existing static assets still served ===')
  for (const asset of ['/robots.txt', '/favicon.svg']) {
    const result = await probe(asset)
    check(result.status === 200, `${asset} -> 200`, String(result.status))
    check(result.location === null, `${asset} is not redirected`)
  }

  console.log('\n=== 5. missing files 404, they do not redirect ===')
  for (const missing of ['/assets/deleted-chunk-abc123.js', '/missing.png']) {
    const result = await probe(missing)
    check(result.status === 404, `${missing} -> 404`, String(result.status))
    check(result.status !== 307, `${missing} is not a 307 redirect`)
  }

  console.log('\n=== 6. API routes are not swallowed by the SPA fallback ===')
  const api = await probe('/api/health')
  check(api.status === 200, '/api/health -> 200', String(api.status))
  check((api.type ?? '').includes('application/json'), '/api/health answers JSON', api.type ?? '')
} finally {
  server.close()
  built.close()
}

console.log(`\nfailures: ${failures}`)
if (failures > 0) process.exitCode = 1
