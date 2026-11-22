import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import {
  APP_OWNED_AUTH_PATHS,
  createSocialRedirectRoutes,
  isPlatformAuthPath,
} from '../../server/http/auth-proxy.ts'
import type { AppEnv } from '../../server/http/middleware.ts'

/**
 * OAuth completion (`/api/auth/oauth-complete`).
 *
 * ## The production 404
 *
 * After the provider handshake the auth worker returns the browser to the
 * `returnTo` it was given, carrying a one-time `code`. The SDK names that
 * destination `<app origin>/api/auth/oauth-complete` (see `nativeAuthStart`),
 * so the endpoint is **app-owned**. A live probe of
 * `auth.deep.space/api/auth/oauth-complete` returns 404, and so did our
 * deployment — nothing implemented it.
 *
 * ## The contract implemented
 *
 * Mirrors the SDK's own `nativeAuthExchange`:
 *
 *   1. `POST {AUTH_WORKER_URL}/api/auth/exchange-code`  { code } → { sessionToken }
 *   2. `POST {AUTH_WORKER_URL}/api/auth/token`          Cookie: session → { token }
 *   3. set the session cookie on our origin, redirect to the dashboard.
 *
 * Step 2 is what makes the redirect honest: the dashboard is only reached once
 * the platform has confirmed the session by issuing a JWT.
 *
 * ## What these tests prove, and what they do not
 *
 * They drive the route against a **stubbed** auth worker, so they prove routing,
 * validation, failure mapping and cookie shape. They cannot prove that Google
 * accepts our callback or that a real code redeems — that needs a human consent
 * and is reported separately as a limitation.
 */

interface Call {
  url: string
  init: RequestInit | undefined
  body: unknown
}

/** Build the bridge with a scripted auth worker. */
function build(options: {
  authWorkerUrl?: string
  appOrigin?: string
  /** Replies keyed by upstream pathname. */
  replies: Record<string, () => Response>
}): { app: Hono<AppEnv>; calls: Call[]; restore: () => void } {
  const calls: Call[] = []
  const original = globalThis.fetch

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const pathname = new URL(url).pathname
    let body: unknown = init?.body
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body)
      } catch {
        /* keep raw */
      }
    }
    calls.push({ url, init, body })
    const reply = options.replies[pathname]
    if (!reply) return new Response('not found', { status: 404 })
    return reply()
  }) as typeof fetch

  const app = new Hono<AppEnv>()
  app.route(
    '/api/auth',
    createSocialRedirectRoutes({
      authWorkerUrl: options.authWorkerUrl ?? 'https://auth.example.test',
      appOrigin: options.appOrigin ?? 'https://signalmess.test',
    }),
  )

  return { app, calls, restore: () => { globalThis.fetch = original } }
}

async function hit(
  built: ReturnType<typeof build>,
  path: string,
): Promise<{ status: number; location: string | null; body: Record<string, unknown>; setCookie: string[] }> {
  try {
    const response = await built.app.request(`http://localhost${path}`, { method: 'GET' })
    const text = await response.text()
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(text) as Record<string, unknown>
    } catch {
      body = { raw: text }
    }
    return {
      status: response.status,
      location: response.headers.get('location'),
      body,
      setCookie: response.headers.get('set-cookie') ? [response.headers.get('set-cookie')!] : [],
    }
  } finally {
    built.restore()
  }
}

const OK_EXCHANGE = () => Response.json({ sessionToken: 'session-token-value-1234567890' })
const OK_TOKEN = () => Response.json({ token: 'platform.jwt.value' })

describe('oauth-complete: routing ownership', () => {
  it('is app-owned, so the catch-all proxy does not forward it', () => {
    assert.ok(APP_OWNED_AUTH_PATHS.has('/api/auth/oauth-complete'))
    assert.equal(isPlatformAuthPath('/api/auth/oauth-complete'), false)
  })

  it('the bridge sends the code here as returnTo', async () => {
    const built = build({ replies: {} })
    const result = await hit(built, '/api/auth/social-redirect?provider=google')
    assert.equal(result.status, 302)
    const returnTo = new URL(result.location!).searchParams.get('returnTo')
    assert.equal(returnTo, 'https://signalmess.test/api/auth/oauth-complete')
  })
})

describe('oauth-complete: happy path', () => {
  it('redeems the code, proves the session, sets the cookie and redirects', async () => {
    const built = build({
      replies: {
        '/api/auth/exchange-code': OK_EXCHANGE,
        '/api/auth/token': OK_TOKEN,
      },
    })
    const result = await hit(built, '/api/auth/oauth-complete?code=one-time-code')

    assert.equal(result.status, 302)
    assert.equal(result.location, 'https://signalmess.test/dashboard')

    // 1. exchanged the code upstream with the exact contract
    const exchangeCall = built.calls.find((c) => c.url.endsWith('/api/auth/exchange-code'))
    assert.ok(exchangeCall, 'exchange-code must be called')
    assert.equal(exchangeCall.init?.method, 'POST')
    assert.deepEqual(exchangeCall.body, { code: 'one-time-code' })

    // 2. proved the session by requesting a JWT with the cookie
    const tokenCall = built.calls.find((c) => c.url.endsWith('/api/auth/token'))
    assert.ok(tokenCall, 'token must be requested to prove the session')
    const headers = tokenCall.init?.headers as Record<string, string>
    assert.match(headers['cookie'] ?? '', /__Secure-better-auth\.session_token=/)

    // 3. the browser receives the session cookie on OUR origin
    const cookie = result.setCookie[0]
    assert.ok(cookie, 'a Set-Cookie header must be present')
    assert.match(cookie, /__Secure-better-auth\.session_token=/)
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /Secure/)
    assert.match(cookie, /Path=\//)
    assert.match(cookie, /SameSite=Lax/)
    assert.ok(!/;\s*Domain=/i.test(cookie), 'cookie must be host-only to this origin')
  })

  it('never puts a token in the redirect URL', async () => {
    const built = build({
      replies: { '/api/auth/exchange-code': OK_EXCHANGE, '/api/auth/token': OK_TOKEN },
    })
    const result = await hit(built, '/api/auth/oauth-complete?code=one-time-code')
    assert.ok(!result.location!.includes('platform.jwt.value'))
    assert.ok(!result.location!.includes('session-token-value'))
    assert.ok(!/[?&](token|access_token|jwt)=/.test(result.location!))
  })

  it('marks the response no-store', async () => {
    const built = build({
      replies: { '/api/auth/exchange-code': OK_EXCHANGE, '/api/auth/token': OK_TOKEN },
    })
    const response = await built.app.request('http://localhost/api/auth/oauth-complete?code=c', { method: 'GET' })
    built.restore()
    assert.equal(response.headers.get('cache-control'), 'no-store')
  })
})

describe('oauth-complete: rejected codes', () => {
  it('rejects a missing code without calling upstream', async () => {
    const built = build({ replies: {} })
    const result = await hit(built, '/api/auth/oauth-complete')
    assert.equal(result.status, 400)
    assert.equal(built.calls.length, 0)
    assert.equal(result.location, null)
  })

  it('rejects an expired or invalid code (upstream 400 → 401)', async () => {
    const built = build({
      replies: { '/api/auth/exchange-code': () => Response.json({ error: 'Invalid or expired code' }, { status: 400 }) },
    })
    const result = await hit(built, '/api/auth/oauth-complete?code=expired')
    assert.equal(result.status, 401)
    assert.equal(result.location, null, 'an unauthenticated browser must not be sent to the dashboard')
    assert.equal(result.setCookie.length, 0, 'no session cookie on failure')
    const error = result.body['error'] as { code?: string }
    assert.equal(error.code, 'invalid_code')
  })

  it('rejects a reused code (upstream 401 → 401)', async () => {
    const built = build({
      replies: { '/api/auth/exchange-code': () => Response.json({ error: 'Invalid or expired code' }, { status: 401 }) },
    })
    const result = await hit(built, '/api/auth/oauth-complete?code=already-used')
    assert.equal(result.status, 401)
    assert.equal(result.setCookie.length, 0)
  })

  it('maps an upstream 500 to 502 (availability, not a bad code)', async () => {
    const built = build({
      replies: { '/api/auth/exchange-code': () => new Response('boom', { status: 500 }) },
    })
    const result = await hit(built, '/api/auth/oauth-complete?code=whatever')
    assert.equal(result.status, 502)
    const error = result.body['error'] as { code?: string; retryable?: boolean }
    assert.equal(error.code, 'provider_unavailable')
    assert.equal(error.retryable, true)
  })

  it('rejects an exchange response with no sessionToken', async () => {
    const built = build({ replies: { '/api/auth/exchange-code': () => Response.json({ ok: true }) } })
    const result = await hit(built, '/api/auth/oauth-complete?code=c')
    assert.equal(result.status, 502)
    assert.equal(result.setCookie.length, 0)
  })

  it('rejects an oversized code without calling upstream', async () => {
    const built = build({ replies: {} })
    const result = await hit(built, `/api/auth/oauth-complete?code=${'x'.repeat(5000)}`)
    assert.equal(result.status, 400)
    assert.equal(built.calls.length, 0)
  })
})

describe('oauth-complete: session proof is required', () => {
  it('does not redirect when the session cannot obtain a JWT (401)', async () => {
    const built = build({
      replies: {
        '/api/auth/exchange-code': OK_EXCHANGE,
        '/api/auth/token': () => Response.json({ error: 'Unauthorized' }, { status: 401 }),
      },
    })
    const result = await hit(built, '/api/auth/oauth-complete?code=c')
    assert.equal(result.status, 401)
    assert.equal(result.location, null, 'no dashboard redirect without a proven session')
    assert.equal(result.setCookie.length, 0)
    const error = result.body['error'] as { code?: string }
    assert.equal(error.code, 'session_rejected')
  })

  it('returns 502 when the token response has no token', async () => {
    const built = build({
      replies: { '/api/auth/exchange-code': OK_EXCHANGE, '/api/auth/token': () => Response.json({ ok: true }) },
    })
    const result = await hit(built, '/api/auth/oauth-complete?code=c')
    assert.equal(result.status, 502)
    assert.equal(result.location, null)
  })

  it('returns 502 when the auth worker is unreachable', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as typeof fetch
    const app = new Hono<AppEnv>()
    app.route(
      '/api/auth',
      createSocialRedirectRoutes({ authWorkerUrl: 'https://auth.example.test', appOrigin: 'https://signalmess.test' }),
    )
    try {
      const response = await app.request('http://localhost/api/auth/oauth-complete?code=c', { method: 'GET' })
      assert.equal(response.status, 502)
      assert.equal(response.headers.get('location'), null)
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('oauth-complete: configuration failures fail closed', () => {
  it('returns 503 without AUTH_WORKER_URL', async () => {
    const app = new Hono<AppEnv>()
    app.route('/api/auth', createSocialRedirectRoutes({ appOrigin: 'https://signalmess.test' }))
    const response = await app.request('http://localhost/api/auth/oauth-complete?code=c', { method: 'GET' })
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('location'), null)
  })

  it('returns 503 without APP_ORIGIN', async () => {
    const app = new Hono<AppEnv>()
    app.route('/api/auth', createSocialRedirectRoutes({ authWorkerUrl: 'https://auth.example.test' }))
    const response = await app.request('http://localhost/api/auth/oauth-complete?code=c', { method: 'GET' })
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('location'), null)
  })
})

describe('oauth-complete: state and PKCE stay with the platform', () => {
  it('does not validate, store or forward OAuth state or PKCE', async () => {
    // State and PKCE are enforced by the auth worker before it issues a code;
    // the code is single-use. This route must not reimplement either.
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../../server/http/auth-proxy.ts', import.meta.url), 'utf8')
    const start = source.indexOf("app.get('/oauth-complete'")
    const end = source.indexOf('export function createAuthProxyRoutes')
    const handler = source.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

    assert.ok(handler.length > 0, 'handler source not found')
    assert.ok(!/code_verifier|code_challenge|pkce/i.test(handler), 'no PKCE handling')
    assert.ok(!/state/i.test(handler), 'no state handling')
    assert.ok(!/jwtVerify|verifyJwt|new SignJWT/i.test(handler), 'no JWT minting or verification')
    assert.ok(!/createSession|insertSession|sessions\./.test(handler), 'no session creation')
    // The one-time code is the only caller input, and it is opaque.
    assert.match(handler, /c\.req\.query\('code'\)/)
  })
})
