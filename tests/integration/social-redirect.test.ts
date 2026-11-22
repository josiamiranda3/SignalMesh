import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import {
  APP_OWNED_AUTH_PATHS,
  createSocialRedirectRoutes,
  isPlatformAuthPath,
  isSupportedSocialProvider,
} from '../../server/http/auth-proxy.ts'
import type { AppEnv } from '../../server/http/middleware.ts'

/**
 * Social sign-in bridge.
 *
 * ## Two production defects, both proved here
 *
 * **404.** The SDK's `AuthOverlay` navigates to `/api/auth/social-redirect`,
 * a path implemented only in the SDK's browser bundle. The proxy forwarded it
 * and the auth worker answered 404.
 *
 * **state_mismatch.** The first fix called
 * `POST auth.deep.space/api/auth/sign-in/social` server-to-server and redirected
 * to the returned `url`. The platform answers that call with
 *
 *     set-cookie: __Secure-better-auth.state  Max-Age=300; Path=/; HttpOnly;
 *                                            Secure; SameSite=None
 *
 * — a host-only cookie for `auth.deep.space` (`__Secure-` forbids `Domain`).
 * A server-to-server fetch receives it in a Response the browser never sees, so
 * the state was created but never stored and the callback could not match it.
 *
 * ## The mechanism now used
 *
 * The browser is redirected to the auth worker's own browser-navigable start
 * page, which sets the state cookie on the origin that owns it:
 *
 *     GET https://auth.deep.space/login/social?provider=…&returnTo=…
 *       → 302 to the provider + Set-Cookie (state + CSRF)
 *
 * That is the same construction the SDK's `nativeAuthStart` uses. These tests
 * assert the redirect and its parameters; state/PKCE validation stays on the
 * platform and is deliberately not reimplemented here.
 */

function build(options: { authWorkerUrl?: string; appOrigin?: string }): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  app.route(
    '/api/auth',
    createSocialRedirectRoutes({
      authWorkerUrl: options.authWorkerUrl,
      appOrigin: options.appOrigin ?? 'https://signalmess.test',
    }),
  )
  return app
}

async function call(
  app: Hono<AppEnv>,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; location: string | null; body: Record<string, unknown> }> {
  const response = await app.request(`http://localhost${path}`, { method: 'GET', headers })
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    body = { raw: text }
  }
  return { status: response.status, location: response.headers.get('location'), body }
}

const WORKER = 'https://auth.deep.space'
const APP = 'https://signalmess.app.space'

describe('social-redirect: provider allowlist', () => {
  it('accepts google and github', () => {
    assert.equal(isSupportedSocialProvider('google'), true)
    assert.equal(isSupportedSocialProvider('github'), true)
  })

  it('rejects anything else, including path-ish or empty values', () => {
    for (const value of ['', 'facebook', '../google', 'google ', null, undefined, 42, ['google']]) {
      assert.equal(isSupportedSocialProvider(value), false, String(value))
    }
  })
})

describe('social-redirect: starts the flow by redirecting the browser', () => {
  it('is app-owned, so the catch-all proxy does not forward it', () => {
    assert.ok(APP_OWNED_AUTH_PATHS.has('/api/auth/social-redirect'))
    assert.equal(isPlatformAuthPath('/api/auth/social-redirect'), false)
  })

  it('redirects to the auth worker /login/social page, for google', async () => {
    const result = await call(build({ authWorkerUrl: WORKER, appOrigin: APP }), '/api/auth/social-redirect?provider=google')

    assert.equal(result.status, 302)
    const target = new URL(result.location!)
    assert.equal(target.origin, WORKER)
    assert.equal(target.pathname, '/login/social')
    assert.equal(target.searchParams.get('provider'), 'google')
  })

  it('redirects to the auth worker /login/social page, for github', async () => {
    const result = await call(build({ authWorkerUrl: WORKER, appOrigin: APP }), '/api/auth/social-redirect?provider=github')

    assert.equal(result.status, 302)
    const target = new URL(result.location!)
    assert.equal(target.pathname, '/login/social')
    assert.equal(target.searchParams.get('provider'), 'github')
  })

  it('names the configured app origin as returnTo, pointing at our completion route', async () => {
    const result = await call(build({ authWorkerUrl: WORKER, appOrigin: APP }), '/api/auth/social-redirect?provider=google')
    const target = new URL(result.location!)
    // The code must come back to a handler we own; the platform does not
    // implement `/api/auth/oauth-complete`.
    assert.equal(target.searchParams.get('returnTo'), `${APP}/api/auth/oauth-complete`)
  })

  it('tolerates a trailing slash on APP_ORIGIN', async () => {
    const result = await call(
      build({ authWorkerUrl: WORKER, appOrigin: 'https://signalmess.app.space/' }),
      '/api/auth/social-redirect?provider=google',
    )
    assert.equal(
      new URL(result.location!).searchParams.get('returnTo'),
      `${APP}/api/auth/oauth-complete`,
    )
  })

  it('does not depend on the incoming Host header (no open redirect)', async () => {
    // A spoofed Host must not move `returnTo` off the configured origin.
    const result = await call(
      build({ authWorkerUrl: WORKER, appOrigin: APP }),
      '/api/auth/social-redirect?provider=google',
      { host: 'evil.example', 'x-forwarded-host': 'evil.example' },
    )
    const returnTo = new URL(result.location!).searchParams.get('returnTo')!
    assert.equal(returnTo, `${APP}/api/auth/oauth-complete`)
    assert.ok(!returnTo.includes('evil.example'))
  })

  it('rejects an unsupported provider', async () => {
    const result = await call(build({ authWorkerUrl: WORKER, appOrigin: APP }), '/api/auth/social-redirect?provider=facebook')
    assert.equal(result.status, 400)
    assert.equal(result.location, null)
  })

  it('rejects a missing provider', async () => {
    const result = await call(build({ authWorkerUrl: WORKER, appOrigin: APP }), '/api/auth/social-redirect')
    assert.equal(result.status, 400)
  })

  it('fails closed without AUTH_WORKER_URL', async () => {
    const result = await call(build({ appOrigin: APP }), '/api/auth/social-redirect?provider=google')
    assert.equal(result.status, 503)
    assert.equal(result.location, null)
  })

  it('fails closed without APP_ORIGIN', async () => {
    const result = await call(
      build({ authWorkerUrl: WORKER, appOrigin: '' }),
      '/api/auth/social-redirect?provider=google',
    )
    assert.equal(result.status, 503)
    assert.equal(result.location, null)
  })

  it('refuses a non-https AUTH_WORKER_URL', async () => {
    const result = await call(
      build({ authWorkerUrl: 'http://auth.deep.space', appOrigin: APP }),
      '/api/auth/social-redirect?provider=google',
    )
    assert.equal(result.status, 503)
  })

  it('refuses a malformed AUTH_WORKER_URL', async () => {
    const result = await call(
      build({ authWorkerUrl: 'not a url', appOrigin: APP }),
      '/api/auth/social-redirect?provider=google',
    )
    assert.equal(result.status, 503)
  })
})

describe('social-redirect: the OAuth state stays on the platform', () => {
  it('never performs a server-side fetch, so no Set-Cookie can be dropped', async () => {
    // This is the exact regression that caused state_mismatch: a server-to-server
    // call received the state cookie in a Response the browser never saw.
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../../server/http/auth-proxy.ts', import.meta.url), 'utf8')
    const bridge = source.slice(
      source.indexOf('export function createSocialRedirectRoutes'),
      source.indexOf("app.get('/oauth-complete'"),
    )
    assert.ok(bridge.length > 0, 'bridge source not found')

    assert.ok(!/authWorkerFetch/.test(bridge), 'the bridge must not call the auth worker server-side')
    assert.ok(!/sign-in\/social/.test(bridge), 'the JSON sign-in endpoint must not be used')
    assert.ok(!/await fetch\(/.test(bridge), 'the bridge must not fetch')
  })

  it('never sets, reads or forwards a cookie', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../../server/http/auth-proxy.ts', import.meta.url), 'utf8')
    const bridge = source.slice(
      source.indexOf('export function createSocialRedirectRoutes'),
      source.indexOf("app.get('/oauth-complete'"),
    )
    // Strip comments: the doc block explains the Set-Cookie problem it fixes.
    const code = bridge.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    assert.ok(!/set-cookie/i.test(code), 'no cookie writing in the code')
    assert.ok(!/req\.header\('cookie'\)|cookies\[/.test(code), 'no cookie reading')
  })

  it('never implements state, PKCE or token handling', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../../server/http/auth-proxy.ts', import.meta.url), 'utf8')
    const bridge = source.slice(
      source.indexOf('export function createSocialRedirectRoutes'),
      source.indexOf("app.get('/oauth-complete'"),
    )
    const code = bridge.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    assert.ok(!/\bstate\b/i.test(code), 'no state handling')
    assert.ok(!/code_challenge|code_verifier|pkce/i.test(code), 'no PKCE handling')
    assert.ok(!/jwt/i.test(code), 'no JWT handling')
    assert.ok(!/access_token|id_token|refresh_token/.test(code), 'no token parsing')
  })
})
