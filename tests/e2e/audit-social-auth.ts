/**
 * Live verification of the social sign-in bridge against REAL DeepSpace.
 *
 * Proves the chain up to the point where a human must consent:
 *
 *   GET /api/auth/social-redirect?provider=…
 *     -> 302 to https://auth.deep.space/login/social?provider=…&returnTo=…
 *     -> that page answers 302 to the provider AND sets the OAuth state cookie
 *
 * The second hop is the one that was broken: the first implementation fetched
 * `/sign-in/social` server-side, so its `Set-Cookie` never reached the browser
 * and the callback reported `state_mismatch`.
 *
 * No consent is granted, no token is minted, no credential is sent.
 *
 * Run: node --experimental-transform-types tests/e2e/audit-social-auth.ts
 */

import { Hono } from 'hono'
import { createSocialRedirectRoutes } from '../../server/http/auth-proxy.ts'
import type { AppEnv } from '../../server/http/middleware.ts'

const AUTH_WORKER = 'https://auth.deep.space'
const APP_ORIGIN = 'https://signalmess.app.space'

let failures = 0
function check(ok: boolean, label: string, detail = ''): void {
  if (!ok) {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  } else console.log(`  ok    ${label}`)
}

const app = new Hono<AppEnv>()
app.route(
  '/api/auth',
  createSocialRedirectRoutes({ authWorkerUrl: AUTH_WORKER, appOrigin: APP_ORIGIN }),
)

console.log('=== 1. bridge: provider -> auth worker start page ===')
const starts: Record<string, string> = {}

for (const provider of ['google', 'github']) {
  const response = await app.request(
    `http://localhost/api/auth/social-redirect?provider=${provider}`,
    { method: 'GET' },
  )
  const location = response.headers.get('location') ?? ''
  starts[provider] = location
  console.log(`  ${provider}: ${response.status} -> ${location}`)

  check(response.status === 302, `${provider}: bridge redirects (${response.status})`)
  const target = location ? new URL(location) : null
  check(target?.origin === AUTH_WORKER, `${provider}: goes to the auth worker origin`)
  check(target?.pathname === '/login/social', `${provider}: uses the browser-navigable start page`)
  check(target?.searchParams.get('provider') === provider, `${provider}: names the provider`)
  // The one-time code must come back to a handler this app owns; the platform
  // does not implement `/api/auth/oauth-complete`.
  check(
    target?.searchParams.get('returnTo') === `${APP_ORIGIN}/api/auth/oauth-complete`,
    `${provider}: returnTo is our completion route`,
    target?.searchParams.get('returnTo') ?? 'none',
  )
}

console.log('\n=== 2. the start page issues the state cookie (the state_mismatch fix) ===')
for (const provider of ['google', 'github']) {
  const response = await fetch(starts[provider]!, { redirect: 'manual' })

  const location = response.headers.get('location') ?? ''
  const providerHost = provider === 'google' ? 'accounts.google.com' : 'github.com'
  const host = location ? new URL(location).host : ''

  console.log(`  ${provider}: ${response.status} -> ${host}`)
  check(response.status === 302, `${provider}: start page redirects (${response.status})`)
  check(host === providerHost, `${provider}: redirects to ${providerHost} (got ${host || 'none'})`)

  // Node's fetch folds multiple Set-Cookie headers; split them back out.
  const setCookie = response.headers.getSetCookie?.() ?? []
  const names = setCookie.map((c) => c.split('=')[0]!.trim())
  console.log(`  ${provider}: Set-Cookie names: ${names.join(', ') || '(none)'}`)

  // The OAuth state lives here. Without it the callback cannot match.
  check(
    names.some((n) => n.includes('better-auth.state')),
    `${provider}: state cookie is issued`,
    names.join(', ') || 'none',
  )
  // Better Auth pairs the state with a per-attempt CSRF cookie on its own path.
  check(
    names.some((n) => n.startsWith('social_csrf_')),
    `${provider}: per-attempt CSRF cookie is issued`,
    names.join(', ') || 'none',
  )

  // Attributes matter: host-only (no Domain), Secure, HttpOnly.
  const stateCookie = setCookie.find((c) => c.includes('better-auth.state')) ?? ''
  check(/HttpOnly/i.test(stateCookie), `${provider}: state cookie is HttpOnly`)
  check(/Secure/i.test(stateCookie), `${provider}: state cookie is Secure`)
  check(!/;\s*Domain=/i.test(stateCookie), `${provider}: state cookie is host-only (no Domain)`)
  check(/SameSite=/i.test(stateCookie), `${provider}: state cookie declares SameSite`)

  // PKCE must be present — the flow is not downgraded.
  const challenge = location ? new URL(location).searchParams.get('code_challenge') : null
  const method = location ? new URL(location).searchParams.get('code_challenge_method') : null
  check(!!challenge, `${provider}: PKCE code_challenge present`)
  check(method === 'S256', `${provider}: PKCE method is S256`, method ?? 'none')

  // The callback must resume on the auth worker, keeping issuer unchanged.
  const redirectUri = location ? new URL(location).searchParams.get('redirect_uri') ?? '' : ''
  check(
    redirectUri.startsWith(`${AUTH_WORKER}/api/auth/callback/`),
    `${provider}: callback stays on the auth worker`,
    redirectUri || 'none',
  )
}

console.log('\n=== 3. refusals ===')
const bad = await app.request('http://localhost/api/auth/social-redirect?provider=facebook', { method: 'GET' })
check(bad.status === 400, `unsupported provider refused (${bad.status})`)

const noWorker = new Hono<AppEnv>()
noWorker.route('/api/auth', createSocialRedirectRoutes({ appOrigin: APP_ORIGIN }))
const nw = await noWorker.request('http://localhost/api/auth/social-redirect?provider=google', { method: 'GET' })
check(nw.status === 503, `fail closed without AUTH_WORKER_URL (${nw.status})`)

const noOrigin = new Hono<AppEnv>()
noOrigin.route('/api/auth', createSocialRedirectRoutes({ authWorkerUrl: AUTH_WORKER, appOrigin: '' }))
const no = await noOrigin.request('http://localhost/api/auth/social-redirect?provider=google', { method: 'GET' })
check(no.status === 503, `fail closed without APP_ORIGIN (${no.status})`)

console.log('\n=== 4. callback with tampered or missing state is refused by the platform ===')
// We cannot complete a real consent, but we CAN prove the platform validates
// state: a callback with no state must not be accepted. This is the check that
// would have caught state_mismatch being a false "success".
for (const path of [
  '/api/auth/callback/google',
  '/api/auth/callback/google?state=forged&code=fake',
  '/api/auth/callback/github?state=forged',
]) {
  const response = await fetch(`${AUTH_WORKER}${path}`, { redirect: 'manual' })
  const location = response.headers.get('location') ?? ''
  console.log(`  ${path} -> ${response.status} ${location ? `(${new URL(location).pathname}${new URL(location).search})` : ''}`)
  check(
    response.status !== 200,
    `tampered callback is not accepted: ${path}`,
  )
  // It must not hand back a session: no auth cookie on the callback response.
  const cookies = response.headers.getSetCookie?.() ?? []
  check(
    !cookies.some((c) => /session_token/i.test(c)),
    `no session issued for an invalid callback: ${path}`,
  )
}

console.log(`\nfailures: ${failures}`)
if (failures > 0) process.exitCode = 1
