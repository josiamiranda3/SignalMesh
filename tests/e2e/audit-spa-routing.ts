/**
 * SPA routing verification against the built assets.
 *
 * The Node dev harness serves the SPA with `serveStatic`, not `env.ASSETS`, so it
 * cannot reproduce Cloudflare's `html_handling`. What it *can* prove is the other
 * half of the contract: that every deep link resolves to the shell, that static
 * files are still served, and that a missing file 404s — i.e. that the Worker's
 * fallback rule (which the config now lets run) produces the right answers.
 *
 * The `html_handling` half is covered by `tests/integration/worker-routing.test.ts`,
 * which models both asset-layer modes explicitly.
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
// Mirrors worker.ts exactly: asset layer first; a miss with a file extension is a
// JSON 404; a route-shaped miss gets the SPA shell.
built.app.use('*', serveStatic({ root: spa.root }))
built.app.get('*', (c) => {
  const { pathname } = new URL(c.req.url)
  const last = pathname.slice(pathname.lastIndexOf('/') + 1)
  if (last.includes('.')) {
    return c.json({ error: 'not_found' }, 404)
  }
  return serveStatic({ path: spa.index })(c, async () => {})
})
const server = serve({ fetch: built.app.fetch, port: PORT, hostname: '127.0.0.1' })
await new Promise((r) => setTimeout(r, 500))

async function status(path: string): Promise<{ status: number; type: string | null; location: string | null }> {
  const response = await fetch(`${BASE}${path}`, { redirect: 'manual' })
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    location: response.headers.get('location'),
  }
}

try {
  console.log('=== deep links serve the SPA shell (no redirect) ===')
  for (const route of ['/login', '/history', '/settings', '/dashboard', '/investigations', '/validation']) {
    const result = await status(route)
    check(result.status === 200, `${route} -> 200 (got ${result.status})`)
    check(result.location === null, `${route} does not redirect`, result.location ?? '')
    check(
      (result.type ?? '').includes('text/html'),
      `${route} serves HTML`,
      result.type ?? 'no content-type',
    )
  }

  console.log('\n=== the shell is the SPA, not an error page ===')
  const login = await fetch(`${BASE}/login`)
  const html = await login.text()
  check(html.includes('<div id="root">'), 'shell contains the React root')
  check(/<script[^>]+type="module"/.test(html), 'shell loads the app bundle')

  console.log('\n=== static files still served ===')
  for (const asset of ['/robots.txt', '/favicon.svg']) {
    const result = await status(asset)
    check(result.status === 200, `${asset} -> 200 (got ${result.status})`)
    check(result.location === null, `${asset} is not redirected`)
  }

  console.log('\n=== missing files 404, they do not redirect ===')
  for (const missing of ['/assets/deleted-chunk-abc123.js', '/missing.png']) {
    const result = await status(missing)
    check(result.status === 404, `${missing} -> 404 (got ${result.status})`)
    check(result.status !== 307, `${missing} is not a 307 redirect`)
  }

  console.log("\n=== the worker's SPA branch is not bypassed by a redirect ===")
  // A route-shaped path with no extension must never come back as 3xx.
  const route = await status('/investigations/inv_123/evidence')
  check(route.status === 200, 'nested route serves the shell')
  check(route.status < 300 || route.status >= 400, 'nested route is not a 3xx', String(route.status))
} finally {
  server.close()
  built.close()
}

console.log(`\nfailures: ${failures}`)
if (failures > 0) process.exitCode = 1
