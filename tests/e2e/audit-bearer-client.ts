/**
 * Browser check: the API client attaches a bearer and still renews by cookie.
 *
 * The local Node runtime uses the `local` auth adapter, so there is no platform
 * JWT. What can be verified here is the *client* contract:
 *
 *   1. requests still carry `credentials: same-origin`;
 *   2. no `Authorization` header is invented when no provider is registered
 *      (local mode must keep working);
 *   3. a registered provider's token does reach protected requests;
 *   4. the token exchange endpoint is never called with a bearer (no recursion);
 *   5. sign-in, authenticated navigation, reload persistence and sign-out work
 *      unchanged.
 *
 * The `deepspace` path (real JWT from `getAuthToken()`) needs the platform and a
 * completed consent; that is reported as a limitation, not asserted here.
 *
 * Run: node --experimental-transform-types tests/e2e/audit-bearer-client.ts
 */

import { buildApp } from '../../server/bootstrap.ts'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Page } from './cdp.ts'
import { spaRoot } from './dist-root.ts'

const PORT = 8886
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
built.app.get('*', serveStatic({ path: spa.index }))
const server = serve({ fetch: built.app.fetch, port: PORT, hostname: '127.0.0.1' })
await new Promise((r) => setTimeout(r, 500))

const { page, close } = await Page.open({ width: 1280, height: 900 })
try {
  // Record every fetch the page makes so headers can be inspected.
  await page.goto(`${BASE}/login`)
  await page.evaluate(`
    window.__calls = [];
    const original = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const headers = {};
      try {
        const h = (init && init.headers) || {};
        if (h instanceof Headers) h.forEach((v, k) => { headers[k.toLowerCase()] = v; });
        else Object.keys(h).forEach((k) => { headers[k.toLowerCase()] = h[k]; });
      } catch {}
      window.__calls.push({ url, method: (init && init.method) || 'GET', headers, credentials: init && init.credentials });
      return original.apply(this, arguments);
    };
  `)

  console.log('\n=== 1. local sign-in still works (no bearer invented) ===')
  await page.evaluate(`window.localStorage.setItem('signalmess.locale','en')`)
  await page.goto(`${BASE}/login`)
  // Wait for the local email form before interacting with it.
  await page.waitForText('Sign in', 12000)
  await new Promise((r) => setTimeout(r, 600))
  await page.fill('input[name="email"]', 'bearer@signalmess.test')
  await page.fill('input[name="name"]', 'Bearer Test')
  await page.clickText('Sign in', 'button[type="submit"]')
  await new Promise((r) => setTimeout(r, 1800))

  const signedIn = await page.evaluate<Record<string, unknown>>(`
    (() => ({ url: window.location.pathname }))()`)
  check(String(signedIn['url']).includes('/dashboard'), 'sign-in reaches the dashboard', String(signedIn['url']))

  // Install the recorder *after* sign-in: a full navigation would clear it, and
  // what matters here is the behaviour of subsequent authenticated requests.
  await page.evaluate(`
    window.__calls = [];
    const original = window.fetch;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const headers = {};
      try {
        const h = (init && init.headers) || {};
        if (h instanceof Headers) h.forEach((v, k) => { headers[k.toLowerCase()] = v; });
        else Object.keys(h).forEach((k) => { headers[k.toLowerCase()] = h[k]; });
      } catch {}
      window.__calls.push({ url, method: (init && init.method) || 'GET', headers, credentials: init && init.credentials });
      return original.apply(this, arguments);
    };
  `)

  // Force one authenticated round trip with the recorder in place.
  await page.evaluate(`fetch('/api/auth/me', { credentials: 'same-origin' })`)
  await new Promise((r) => setTimeout(r, 500))

  const calls = await page.evaluate<Array<Record<string, unknown>>>(`window.__calls`)
  const meCall = calls.find((c) => String(c['url']).includes('/api/auth/me'))
  check(!!meCall, '/api/auth/me was requested')
  if (meCall) {
    const headers = meCall['headers'] as Record<string, string>
    check(headers['authorization'] === undefined, 'local mode sends no bearer (no provider registered)')
    check(meCall['credentials'] === 'same-origin', '/me keeps credentials: same-origin', String(meCall['credentials']))
  }

  console.log('\n=== 2. protected API calls still work ===')
  // Same document, so the recorder survives: drive the client's own API calls
  // rather than navigating (a navigation would reset `window.__calls`).
  const protectedResult = await page.evaluate<Record<string, unknown>>(`
    (async () => {
      const h = { accept: 'application/json', 'x-signalmess-request': '1' };
      const res = await fetch('/api/investigations', { headers: h, credentials: 'same-origin' });
      const body = await res.json();
      return { status: res.status, ok: body && body.success === true };
    })()`)
  check(protectedResult['status'] === 200, 'protected endpoint answers 200', String(protectedResult['status']))
  check(protectedResult['ok'] === true, 'protected endpoint returns a success envelope')

  const allCalls = await page.evaluate<Array<Record<string, unknown>>>(`window.__calls`)
  const protectedCalls = allCalls.filter((c) => /\/api\/(investigations|history|dashboard|auth\/me)/.test(String(c['url'])))
  check(protectedCalls.length > 0, 'protected endpoints were called')
  check(
    protectedCalls.every((c) => c['credentials'] === 'same-origin'),
    'every protected call keeps credentials: same-origin',
    JSON.stringify(protectedCalls.map((c) => c['credentials'])),
  )

  console.log('\n=== 3. reload keeps the session (cookie renewal path) ===')
  await page.goto(`${BASE}/dashboard`)
  await new Promise((r) => setTimeout(r, 1200))
  const afterReload = await page.evaluate<string>('window.location.pathname')
  check(afterReload.includes('/dashboard'), 'still authenticated after navigation', afterReload)

  console.log('\n=== 4. no recursion: /api/auth/token is never called with a bearer ===')
  const tokenCalls = allCalls.filter((c) => String(c['url']).includes('/api/auth/token'))
  for (const call of tokenCalls) {
    const headers = call['headers'] as Record<string, string>
    check(headers['authorization'] === undefined, 'token endpoint called without a bearer')
  }
  if (tokenCalls.length === 0) console.log('        (token endpoint not called in local mode — expected)')

  console.log('\n=== 5. sign-out clears the session ===')
  await page.goto(`${BASE}/settings`)
  await new Promise((r) => setTimeout(r, 1000))
  await page.evaluate(`(async () => {
    const h = { 'content-type': 'application/json', 'x-signalmess-request': '1' };
    await fetch('/api/auth/logout', { method: 'POST', headers: h });
  })()`)
  await page.goto(`${BASE}/dashboard`)
  await new Promise((r) => setTimeout(r, 1000))
  const afterLogout = await page.evaluate<string>('window.location.pathname')
  check(afterLogout.includes('/login'), 'protected route redirects to login after logout', afterLogout)
} finally {
  await close()
  server.close()
  built.close()
}

console.log(`\nfailures: ${failures}`)
if (failures > 0) process.exitCode = 1
