import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { createAuthProxyRoutes } from '../../server/http/auth-proxy.ts'
import type { AppEnv } from '../../server/http/middleware.ts'

/**
 * `/api/auth/*` proxying to the platform auth worker.
 *
 * ## What this suite is protecting
 *
 * The SDK's browser client never talks to the auth worker directly. `signIn()`
 * and `getAuthToken()` call the **app's own origin**, and the app forwards:
 *
 *   - `POST /api/auth/token` with the platform session cookie must return the
 *     platform JWT, because that token is the only credential `verifyJwt`
 *     accepts in `resolveIdentity`.
 *   - OAuth flows start and finish on the app origin (`/social-redirect`,
 *     `/oauth-complete`), so their redirects must survive the hop unchanged.
 *
 * If this route is missing or drops a cookie, a signed-in user cannot obtain a
 * JWT and every authenticated `/api/*` call answers 401. That failure looks
 * exactly like "not logged in", which is why it is tested explicitly rather
 * than assumed.
 *
 * The upstream is stubbed: no network call, no real auth worker, no token
 * minted. Only the forwarding contract is asserted.
 */

/** Records what the proxy sent upstream, and answers with a canned response. */
interface UpstreamCall {
  url: string
  method: string
  cookie: string | null
  origin: string | null
  contentType: string | null
  body: string | null
}

const calls: UpstreamCall[] = []

const realFetch = globalThis.fetch

/** Stand in for the auth worker for the duration of one test. */
function stubAuthWorker(handler: (call: UpstreamCall) => Response) {
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    // The proxy forwards the caller's body as a stream, exactly as the official
    // scaffold does. Node's `fetch` requires `duplex` for a stream body;
    // workerd (the real runtime) does not, so this is a harness concern only.
    const withDuplex: RequestInit | undefined =
      init && init.body ? { ...init, duplex: 'half' } as RequestInit : init
    const request = input instanceof Request ? input : new Request(String(input), withDuplex)
    const call: UpstreamCall = {
      url: request.url,
      method: request.method,
      cookie: request.headers.get('cookie'),
      origin: request.headers.get('origin'),
      contentType: request.headers.get('content-type'),
      body: request.method === 'GET' || request.method === 'HEAD' ? null : await request.clone().text(),
    }
    calls.push(call)
    return handler(call)
  }) as typeof fetch
}

function appWithProxy(authWorkerUrl?: string) {
  const app = new Hono<AppEnv>()
  app.route('/api/auth', createAuthProxyRoutes({ authWorkerUrl }))
  return app
}

afterEach(() => {
  globalThis.fetch = realFetch
  calls.length = 0
})

/** The single upstream call, asserted to exist. */
function onlyCall(): UpstreamCall {
  assert.equal(calls.length, 1, 'exactly one upstream call')
  const call = calls[0]
  assert.ok(call, 'the upstream call was recorded')
  return call
}

const AUTH_URL = 'https://auth.deep.space'

describe('auth proxy: forwards the platform handshake', () => {
  it('forwards POST /token to the auth worker and returns the JWT', async () => {
    stubAuthWorker(() => Response.json({ token: 'header.payload.signature' }))
    const app = appWithProxy(AUTH_URL)

    const response = await app.request('/api/auth/token', {
      method: 'POST',
      headers: {
        cookie: '__Secure-better-auth.session_token=session-abc',
        origin: 'https://signalmess.app.space',
      },
    })

    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { token: 'header.payload.signature' })
    const call = onlyCall()
    assert.equal(call.url, `${AUTH_URL}/api/auth/token`)
    assert.equal(call.method, 'POST')
    // The credential is the platform cookie; the proxy must not strip it.
    assert.match(call.cookie ?? '', /__Secure-better-auth\.session_token=session-abc/)
    assert.equal(call.origin, 'https://signalmess.app.space')
  })

  it('preserves the query string through the hop', async () => {
    stubAuthWorker(() => Response.json({ ok: true }))
    const app = appWithProxy(AUTH_URL)

    await app.request('/api/auth/session?x=1&y=two', { method: 'GET' })

    assert.equal(onlyCall().url, `${AUTH_URL}/api/auth/session?x=1&y=two`)
  })

  it('forwards the request body and content type untouched', async () => {
    stubAuthWorker(() => Response.json({ ok: true }))
    const app = appWithProxy(AUTH_URL)

    await app.request('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'pessoa@example.com', password: 'segredo' }),
    })

    assert.equal(onlyCall().contentType, 'application/json')
    assert.deepEqual(JSON.parse(onlyCall().body ?? '{}'), {
      email: 'pessoa@example.com',
      password: 'segredo',
    })
  })

  it('returns OAuth redirects to the browser instead of following them', async () => {
    // A followed redirect would end the navigation inside the worker; the
    // browser has to perform it for the OAuth round trip to complete.
    //
    // NOTE: this used `/api/auth/social-redirect` as the example until v0.2.5.
    // That path is app-owned — the platform does not implement it, which is why
    // it 404'd in production — so it never reaches this proxy any more. The
    // platform's real OAuth entry point is `/sign-in/social`, and the callback
    // is a genuine browser redirect, so that is what this test exercises now.
    stubAuthWorker(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x' },
        }),
    )
    const app = appWithProxy(AUTH_URL)

    const response = await app.request('/api/auth/callback/google?code=abc&state=xyz', { method: 'GET' })

    assert.equal(response.status, 302)
    assert.match(response.headers.get('location') ?? '', /accounts\.google\.com\/o\/oauth2\/v2\/auth/)
  })

  it('no longer proxies social-redirect, because the app owns that route', async () => {
    // Regression guard for the production 404: forwarding this path made the
    // auth worker answer 404 and dead-ended "Continue with Google".
    stubAuthWorker(() => Response.json({ ok: true }))
    const app = appWithProxy(AUTH_URL)

    await app.request('/api/auth/social-redirect?provider=google', { method: 'GET' })

    assert.equal(calls.length, 0, 'social-redirect must not be forwarded upstream')
  })
})

describe('auth proxy: cookie scoping', () => {
  it('strips Domain from Set-Cookie so the cookie lands on this origin', async () => {
    stubAuthWorker(
      () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            'set-cookie':
              '__Secure-better-auth.session_token=abc; Domain=auth.deep.space; Path=/; HttpOnly; Secure; SameSite=Lax',
            'content-type': 'application/json',
          },
        }),
    )
    const app = appWithProxy(AUTH_URL)

    const response = await app.request('/api/auth/sign-in/email', { method: 'POST' })

    const setCookie = response.headers.get('set-cookie') ?? ''
    // A cookie scoped to the auth worker's host would never be sent to the app.
    assert.doesNotMatch(setCookie, /Domain=/i)
    assert.match(setCookie, /__Secure-better-auth\.session_token=abc/)
    assert.match(setCookie, /HttpOnly/)
  })

  it('preserves the upstream status and JSON body on failure', async () => {
    stubAuthWorker(() => Response.json({ error: 'invalid credentials' }, { status: 401 }))
    const app = appWithProxy(AUTH_URL)

    const response = await app.request('/api/auth/sign-in/email', { method: 'POST' })

    assert.equal(response.status, 401)
    assert.deepEqual(await response.json(), { error: 'invalid credentials' })
  })
})

describe('auth proxy: fails closed', () => {
  it('answers 503 when AUTH_WORKER_URL is missing, and calls nothing', async () => {
    stubAuthWorker(() => Response.json({ token: 'never' }))
    const app = appWithProxy(undefined)

    const response = await app.request('/api/auth/token', { method: 'POST' })

    // A silent 200 here would look like a signed-out user; a misconfigured
    // deployment must be distinguishable from an anonymous visitor.
    assert.equal(response.status, 503)
    const body = (await response.json()) as { error: { code: string } }
    assert.equal(body.error.code, 'auth_unavailable')
    assert.equal(calls.length, 0)
  })

  it('never treats a caller-supplied identity header as authentication', async () => {
    stubAuthWorker(() => Response.json({ token: 'from-cookie-only' }))
    const app = appWithProxy(AUTH_URL)

    await app.request('/api/auth/token', {
      method: 'POST',
      headers: { 'x-user-id': 'user_atacante', authorization: 'Bearer forjado' },
    })

    // Whatever the client sends is forwarded as-is to be judged by the auth
    // worker; the proxy itself makes no identity decision and adds none.
    const call = onlyCall()
    assert.equal(call.cookie, null)
  })
})

describe('auth proxy: leaves the app-owned routes alone', () => {
  for (const path of ['/api/auth/config', '/api/auth/me', '/api/auth/login', '/api/auth/logout']) {
    it(`does not forward ${path}`, async () => {
      stubAuthWorker(() => Response.json({ token: 'leaked' }))
      const app = appWithProxy(AUTH_URL)

      const response = await app.request(path, { method: 'GET' })

      // The app implements these itself; reaching the auth worker would bypass
      // the local adapter and the CSRF policy they rely on.
      assert.equal(response.status, 404)
      assert.equal(calls.length, 0)
    })
  }
})


