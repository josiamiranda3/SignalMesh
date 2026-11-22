import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { loadConfig } from '../../server/config.ts'
import { createApp } from '../../server/app.ts'
import { createWorkerServices } from '../../server/services/worker.ts'
import type { RecordRoomNamespace } from '../../server/services/worker.ts'

/**
 * CSRF scope around the platform auth proxy.
 *
 * ## The defect this pins
 *
 * `csrfGuard` was mounted on `/api/*` as a whole, and `/api/auth/` is listed as
 * a credential route that never receives the bearer exemption. The SDK's
 * browser client drives the platform auth worker through **this origin**:
 *
 *   - `getAuthToken()`: `POST /api/auth/token`, headers `Content-Type` only
 *   - `signIn.email()` / `signOut()`: better-auth POSTs on the same origin
 *   - OAuth: `GET /api/auth/social-redirect`, `GET /api/auth/oauth-complete`
 *
 * None of them send `x-signalmess-request` — that is this app's own convention
 * and the auth worker knows nothing about it. The blanket guard therefore
 * answered **403 before the proxy ran**, so a signed-in browser could never
 * obtain the JWT `resolveIdentity` requires, and every authenticated route
 * looked like "not logged in".
 *
 * ## What must stay true
 *
 * The exemption is exactly the set of paths the proxy forwards. The app's own
 * auth routes (`/config`, `/me`, `/login`, `/logout`) and the whole rest of
 * `/api/*` keep the marker requirement. A future path added to one side without
 * the other is what this suite is designed to catch.
 */

const APP_ID = 'app_test'
const OWNER = 'user_owner'
const AUTH_WORKER = 'https://auth.deep.space'

/** Namespace double: the auth routes never reach records, so access fails loudly. */
function namespaceDouble(): RecordRoomNamespace {
  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async () => {
        throw new Error('the record room must not be reached by an auth request')
      },
    }),
  }
}

const realFetch = globalThis.fetch
let upstreamCalls: string[] = []

/** App in the runtime the proxy exists for, with the auth worker stubbed. */
function createDeepSpaceApp() {
  const bindings = {
    RECORD_ROOMS: namespaceDouble(),
    DEEPSPACE_APP_ID: APP_ID,
    AUTH_JWT_PUBLIC_KEY: 'test-public-key',
    AUTH_JWT_ISSUER: `${AUTH_WORKER}/api/auth`,
    OWNER_USER_ID: OWNER,
    AUTH_WORKER_URL: AUTH_WORKER,
  }

  const config = loadConfig(
    { NODE_ENV: 'production', APP_ORIGIN: 'https://signalmess.app.space' },
    { runtime: 'worker' },
  )
  const services = createWorkerServices({
    config,
    bindings,
    userId: 'user_caller',
    ownerUserId: OWNER,
  })

  globalThis.fetch = (async (input: Request | string | URL) => {
    const request = input instanceof Request ? input : new Request(String(input))
    upstreamCalls.push(`${request.method} ${new URL(request.url).pathname}`)
    return Response.json({ token: 'platform.jwt.value' })
  }) as typeof fetch

  return createApp({ services, config, storage: 'records', authWorkerUrl: AUTH_WORKER })
}

afterEach(() => {
  globalThis.fetch = realFetch
  upstreamCalls = []
})

describe('CSRF scope: the SDK auth handshake reaches the proxy', () => {
  /**
   * The exact requests the SDK 0.44.2 issues, with the headers it actually
   * sends. Every one of these was answered 403 before the fix.
   */
  const SDK_REQUESTS: Array<{ method: string; path: string; label: string; body?: string }> = [
    { method: 'POST', path: '/api/auth/token', label: 'getAuthToken()' },
    {
      method: 'POST',
      path: '/api/auth/sign-in/email',
      label: 'signIn.email()',
      body: JSON.stringify({ email: 'pessoa@example.com', password: 'segredo' }),
    },
    { method: 'POST', path: '/api/auth/sign-out', label: 'signOut()' },
    { method: 'GET', path: '/api/auth/session', label: 'useSession' },
    { method: 'GET', path: '/api/auth/social-redirect?provider=github', label: 'OAuth start' },
    { method: 'GET', path: '/api/auth/oauth-complete?code=abc', label: 'OAuth callback' },
  ]

  for (const request of SDK_REQUESTS) {
    it(`${request.label}: ${request.method} ${request.path} is proxied, not rejected`, async () => {
      const app = createDeepSpaceApp()

      const response = await app.request(request.path, {
        method: request.method,
        // Exactly what the SDK sends: no anti-CSRF marker header.
        headers: {
          'content-type': 'application/json',
          cookie: '__Secure-better-auth.session_token=session-abc',
        },
        ...(request.body ? { body: request.body } : {}),
      })

      assert.notEqual(response.status, 403, 'the CSRF guard must not answer this request')
      assert.equal(response.status, 200)
      assert.equal(
        upstreamCalls.length,
        1,
        'the request must have reached the auth worker, not stopped at the guard',
      )
      assert.deepEqual(await response.json(), { token: 'platform.jwt.value' })
    })
  }

  it('getAuthToken() obtains the token the Worker later verifies', async () => {
    // The end-to-end purpose of the exemption: the browser receives the
    // platform JWT. `resolveIdentity` has nothing to verify without it.
    const app = createDeepSpaceApp()
    const response = await app.request('/api/auth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })

    assert.equal(response.status, 200)
    const body = (await response.json()) as { token?: string }
    assert.equal(body.token, 'platform.jwt.value')
  })
})

describe('CSRF scope: the app-owned auth routes stay guarded', () => {
  const OWNED: Array<{ method: string; path: string }> = [
    { method: 'GET', path: '/api/auth/config' },
    { method: 'GET', path: '/api/auth/me' },
    { method: 'POST', path: '/api/auth/login' },
    { method: 'POST', path: '/api/auth/logout' },
  ]

  for (const route of OWNED) {
    it(`${route.method} ${route.path} requires the marker and never reaches the auth worker`, async () => {
      const app = createDeepSpaceApp()

      const response = await app.request(route.path, {
        method: route.method,
        headers: { cookie: 'signalmess_session=some-local-session-token' },
      })

      // GET is a safe method, so it passes the guard on method grounds and is
      // answered by the app itself. POST must be refused by the CSRF guard.
      assert.equal(upstreamCalls.length, 0, 'an owned route must never be forwarded')
      if (route.method === 'GET') {
        assert.notEqual(response.status, 403)
      } else {
        assert.equal(response.status, 403, 'a mutating owned route must still require the marker')
      }
    })
  }

  it('POST /api/auth/logout passes the guard when the marker is present', async () => {
    const app = createDeepSpaceApp()
    const response = await app.request('/api/auth/logout', {
      method: 'POST',
      headers: { 'x-signalmess-request': '1' },
    })

    // The guard is satisfied; the app answers (signing out an absent session).
    assert.notEqual(response.status, 403)
    assert.equal(upstreamCalls.length, 0, 'the app handles logout itself')
  })
})

describe('CSRF scope: the rest of the API is unaffected', () => {
  it('rejects a mutating business route without the marker, before any handler', async () => {
    const app = createDeepSpaceApp()
    const response = await app.request('/api/investigations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' }),
    })

    assert.equal(response.status, 403)
    assert.equal(upstreamCalls.length, 0)
  })

  it('rejects a cross-origin mutating request even with the marker', async () => {
    const app = createDeepSpaceApp()
    const response = await app.request('/api/investigations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://atacante.example', 'x-signalmess-request': '1' },
      body: JSON.stringify({ title: 'x' }),
    })

    assert.equal(response.status, 403)
  })

  it('does not exempt a look-alike prefix path', async () => {
    // `/api/authz/...` must not be read as an auth path by a sloppy prefix test.
    const app = createDeepSpaceApp()
    const response = await app.request('/api/authz/anything', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })

    assert.equal(response.status, 403)
    assert.equal(upstreamCalls.length, 0)
  })

  it('does not exempt the bare /api/auth path', async () => {
    const app = createDeepSpaceApp()
    const response = await app.request('/api/auth', { method: 'POST' })

    assert.equal(response.status, 403)
    assert.equal(upstreamCalls.length, 0)
  })
})
