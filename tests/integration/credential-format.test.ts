import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AuthResolver } from '../../server/lib/auth-resolver.ts'
import { createSocialRedirectRoutes } from '../../server/http/auth-proxy.ts'
import { Hono } from 'hono'
import type { AppEnv } from '../../server/http/middleware.ts'
import type { UserRecord } from '../../server/types.ts'

/**
 * Reproduction: the production 401 on `/api/auth/me`.
 *
 * ## The two credential types
 *
 * The platform issues **two** distinct credentials, and they are not
 * interchangeable:
 *
 * | Credential | Produced by | Format | Accepted by |
 * |---|---|---|---|
 * | session token | `exchange-code` (`{ sessionToken }`) | opaque, no dots, ~26–64 chars | `POST /api/auth/token`, as the `__Secure-better-auth.session_token` **cookie** |
 * | JWT | `POST /api/auth/token` (`{ token }`) | three base64url segments separated by `.` | `Authorization: Bearer`, and `verifyJwt` |
 *
 * ## The defect
 *
 * `oauth-complete` stored the **session token** in the cookie. That is correct
 * for `/token` (which `getAuthToken()` calls with `credentials: 'include'`), but
 * `/api/auth/me` takes the cookie and hands its value straight to `verifyJwt`,
 * which expects a signed JWT. A session token has no dots, so verification can
 * never succeed → 401.
 *
 * The tests below pin both halves: what the callback writes, and what the
 * identity resolver requires.
 */

const USER: UserRecord = {
  id: 'user_1',
  name: 'Test',
  email: 'test@example.com',
  avatarUrl: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as UserRecord

/** A JWT-shaped string (three segments). Not cryptographically valid. */
const JWT_SHAPE = 'header.payload.signature'

/** An opaque session token: no dots, as the platform issues it. */
const SESSION_SHAPE = 'lN1oQ2xYzRmT3dQd0h4S2pWYk5tUg'

/** Build an AuthResolver whose verifier records what it was given. */
function resolverWith(seen: Array<string | null | undefined>, verdict: unknown) {
  return new AuthResolver({
    mode: 'deepspace',
    sessions: { resolve: async () => null } as never,
    users: { findById: async () => USER } as never,
    verifyJwt: async (_config, token) => {
      seen.push(token)
      return { result: verdict }
    },
    bindings: () => ({
      AUTH_JWT_PUBLIC_KEY: 'test-public-key',
      AUTH_JWT_ISSUER: 'https://auth.deep.space/api/auth',
    }),
    ensureUser: async (user) => user,
  })
}

describe('identity resolution: the cookie value goes straight to verifyJwt', () => {
  it('passes the session-cookie value to verifyJwt verbatim', async () => {
    const seen: Array<string | null | undefined> = []
    const resolver = resolverWith(seen, null)

    const request = new Request('https://signalmess.test/api/auth/me', {
      headers: { cookie: `__Secure-better-auth.session_token=${encodeURIComponent(SESSION_SHAPE)}` },
    })
    const resolved = await resolver.resolve(request)

    // The value reached the verifier unchanged — that is the mechanism.
    assert.deepEqual(seen, [SESSION_SHAPE])
    assert.equal(resolved, null, 'a session token cannot verify as a JWT')
  })

  it('accepts the same value when it is a JWT', async () => {
    const seen: Array<string | null | undefined> = []
    const resolver = resolverWith(seen, { userId: USER.id, claims: {} })

    const request = new Request('https://signalmess.test/api/auth/me', {
      headers: { cookie: `__Secure-better-auth.session_token=${JWT_SHAPE}` },
    })
    const resolved = await resolver.resolve(request)

    assert.deepEqual(seen, [JWT_SHAPE])
    assert.ok(resolved, 'a JWT in the cookie does resolve')
    assert.equal(resolved.user.id, USER.id)
  })

  it('prefers an Authorization Bearer over the cookie', async () => {
    const seen: Array<string | null | undefined> = []
    const resolver = resolverWith(seen, { userId: USER.id, claims: {} })

    const request = new Request('https://signalmess.test/api/auth/me', {
      headers: {
        authorization: `Bearer ${JWT_SHAPE}`,
        cookie: `__Secure-better-auth.session_token=${SESSION_SHAPE}`,
      },
    })
    await resolver.resolve(request)

    assert.deepEqual(seen, [JWT_SHAPE], 'the bearer wins')
  })

  it('documents the shape difference that makes the mismatch fatal', () => {
    const segments = (v: string) => v.split('.').length
    assert.equal(segments(JWT_SHAPE), 3, 'a JWT has three segments')
    assert.equal(segments(SESSION_SHAPE), 1, 'a session token has none')
    // A verifier that parses JWT structure can never accept the second form.
    assert.notEqual(segments(JWT_SHAPE), segments(SESSION_SHAPE))
  })
})

describe('oauth-complete: what it writes into the cookie', () => {
  /** Drive the callback with a stubbed auth worker and capture the cookie. */
  async function runCallback(replies: { exchange: () => Response; token: () => Response }) {
    const original = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith('/api/auth/exchange-code')) return replies.exchange()
      if (url.endsWith('/api/auth/token')) return replies.token()
      return new Response('nf', { status: 404 })
    }) as typeof fetch

    const app = new Hono<AppEnv>()
    app.route(
      '/api/auth',
      createSocialRedirectRoutes({ authWorkerUrl: 'https://auth.example.test', appOrigin: 'https://signalmess.test' }),
    )
    try {
      return await app.request('http://localhost/api/auth/oauth-complete?code=one-time', { method: 'GET' })
    } finally {
      globalThis.fetch = original
    }
  }

  it('stores the sessionToken, not the JWT', async () => {
    const response = await runCallback({
      exchange: () => Response.json({ sessionToken: SESSION_SHAPE }),
      token: () => Response.json({ token: JWT_SHAPE }),
    })

    assert.equal(response.status, 302)
    const cookie = response.headers.get('set-cookie') ?? ''
    const value = decodeURIComponent(cookie.split(';')[0]!.split('=').slice(1).join('='))

    assert.equal(value, SESSION_SHAPE, 'the cookie carries the session token')
    assert.notEqual(value, JWT_SHAPE, 'the cookie does not carry the JWT')
  })

  it('the stored value cannot satisfy a JWT verifier', async () => {
    const response = await runCallback({
      exchange: () => Response.json({ sessionToken: SESSION_SHAPE }),
      token: () => Response.json({ token: JWT_SHAPE }),
    })
    const cookie = response.headers.get('set-cookie') ?? ''
    const value = decodeURIComponent(cookie.split(';')[0]!.split('=').slice(1).join('='))

    // Feed exactly what the browser will send to /api/auth/me.
    const seen: Array<string | null | undefined> = []
    const resolver = resolverWith(seen, null)
    const resolved = await resolver.resolve(
      new Request('https://signalmess.test/api/auth/me', {
        headers: { cookie: `__Secure-better-auth.session_token=${encodeURIComponent(value)}` },
      }),
    )

    assert.equal(seen[0], SESSION_SHAPE)
    assert.equal(resolved, null, 'this is the 401')
  })
})

describe('the endpoints that consume each credential', () => {
  it('/api/auth/token is meant to be called WITH the session cookie', async () => {
    // The SDK does exactly this: fetch('/api/auth/token', { method:'POST',
    // credentials:'include' }) with no Authorization header.
    const { readFileSync } = await import('node:fs')
    const sdk = readFileSync(new URL('../../node_modules/deepspace/dist/index.js', import.meta.url), 'utf8')
    const start = sdk.indexOf('async function getAuthToken')
    const body = sdk.slice(start, start + 700)
    assert.match(body, /fetch\("\/api\/auth\/token"/)
    assert.match(body, /credentials: "include"/)
    assert.ok(!/authorization/i.test(body), 'no Authorization header: the cookie authenticates it')
  })

  it('/api/auth/me never exchanges the cookie for a JWT', async () => {
    // It has no upstream call at all: it verifies whatever it was given.
    const { readFileSync } = await import('node:fs')
    const routes = readFileSync(new URL('../../server/http/auth-routes.ts', import.meta.url), 'utf8')
    const start = routes.indexOf("app.get('/me'")
    const body = routes.slice(start, start + 200)
    assert.match(body, /requireUser/)
    assert.ok(!/token|exchange/i.test(body), '/me performs no exchange')
  })
})
