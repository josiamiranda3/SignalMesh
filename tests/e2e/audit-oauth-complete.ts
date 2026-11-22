/**
 * Live verification of the OAuth completion route against REAL DeepSpace.
 *
 * Proves everything up to the point a human must consent:
 *
 *   1. the bridge sends `returnTo` to our own `/api/auth/oauth-complete`;
 *   2. the platform accepts that `returnTo` and sets the state cookie;
 *   3. the platform's `exchange-code` rejects a forged code (401/400), so a
 *      fabricated callback can never produce a session;
 *   4. our route maps that refusal to 401 and issues NO cookie.
 *
 * What it cannot prove: that a real code redeems, because that needs a completed
 * consent. Reported as a limitation, not as success.
 *
 * Run: node --experimental-transform-types tests/e2e/audit-oauth-complete.ts
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

console.log('=== 1. bridge points returnTo at our own completion route ===')
for (const provider of ['google', 'github']) {
  const response = await app.request(
    `http://localhost/api/auth/social-redirect?provider=${provider}`,
    { method: 'GET' },
  )
  const target = new URL(response.headers.get('location') ?? '')
  const returnTo = target.searchParams.get('returnTo') ?? ''
  console.log(`  ${provider}: returnTo=${returnTo}`)
  check(response.status === 302, `${provider}: bridge redirects`)
  check(
    returnTo === `${APP_ORIGIN}/api/auth/oauth-complete`,
    `${provider}: returnTo is our completion route`,
    returnTo,
  )
}

console.log('\n=== 2. the platform accepts that returnTo and issues the state cookie ===')
for (const provider of ['google', 'github']) {
  const startUrl =
    `${AUTH_WORKER}/login/social?provider=${provider}` +
    `&returnTo=${encodeURIComponent(`${APP_ORIGIN}/api/auth/oauth-complete`)}`
  const response = await fetch(startUrl, { redirect: 'manual' })
  const location = response.headers.get('location') ?? ''
  const cookies = response.headers.getSetCookie?.() ?? []
  const names = cookies.map((c) => c.split('=')[0]!.trim())
  const host = location ? new URL(location).host : ''

  console.log(`  ${provider}: ${response.status} -> ${host}; cookies=${names.join(', ')}`)
  check(response.status === 302, `${provider}: start page redirects`)
  check(host === (provider === 'google' ? 'accounts.google.com' : 'github.com'), `${provider}: reaches the provider`)
  check(names.some((n) => n.includes('better-auth.state')), `${provider}: state cookie issued`)
  check(names.some((n) => n.startsWith('social_csrf_')), `${provider}: CSRF cookie issued`)
}

console.log('\n=== 3. the platform refuses a forged code (this is the security floor) ===')
const forged = await fetch(`${AUTH_WORKER}/api/auth/exchange-code`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: 'forged-code-value' }),
})
const forgedBody = await forged.text()
console.log(`  exchange-code(forged) -> ${forged.status} ${forgedBody.slice(0, 80)}`)
check(forged.status === 400 || forged.status === 401, 'forged code is rejected upstream')
check(!/sessionToken/.test(forgedBody), 'no session token for a forged code')

console.log('\n=== 4. our route turns that refusal into 401 with no cookie ===')
const completion = await app.request('http://localhost/api/auth/oauth-complete?code=forged-code-value', {
  method: 'GET',
})
const completionBody = await completion.text()
const setCookie = completion.headers.getSetCookie?.() ?? []
console.log(`  oauth-complete(forged) -> ${completion.status} ${completionBody.slice(0, 90)}`)
check(completion.status === 401, 'route answers 401 for an unredeemable code')
check(completion.headers.get('location') === null, 'no dashboard redirect on failure')
check(setCookie.length === 0, 'no session cookie is issued for a forged code')

console.log('\n=== 5. missing code is a client error, not an upstream call ===')
const missing = await app.request('http://localhost/api/auth/oauth-complete', { method: 'GET' })
console.log(`  oauth-complete(no code) -> ${missing.status}`)
check(missing.status === 400, 'missing code rejected locally')

console.log(`\nfailures: ${failures}`)
if (failures > 0) process.exitCode = 1
