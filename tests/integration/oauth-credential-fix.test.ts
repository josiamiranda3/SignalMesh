import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AuthResolver } from '../../server/lib/auth-resolver.ts'
import type { UserRecord } from '../../server/types.ts'

/**
 * End-to-end proof of the OAuth credential fix.
 *
 * ## Before
 *
 * The browser held a session token in `__Secure-better-auth.session_token`, and
 * the API client sent only that cookie. `AuthResolver` handed the value straight
 * to `verifyJwt`, which needs a JWT — so `/api/auth/me` answered 401 while
 * `/api/auth/token` (which *consumes* a session token) answered 200.
 *
 * ## After
 *
 * The client keeps the cookie (needed for renewal) and additionally sends
 * `Authorization: Bearer <jwt>`. The resolver prefers the bearer, so identity
 * resolves. The cookie alone still fails, which is exactly why the bearer is
 * required — this suite asserts both directions.
 */

const USER: UserRecord = {
  id: 'user_42',
  name: 'Pessoa',
  email: 'pessoa@example.com',
  avatarUrl: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
} as UserRecord

const SESSION_TOKEN = 'lN1oQ2xYzRmT3dQd0h4S2pWYk5tUg'
const VALID_JWT = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1c2VyXzQyIn0.c2ln'
const EXPIRED_JWT = 'eyJhbGciOiJFUzI1NiJ9.eyJleHAiOjB9.b2xk'

/**
 * A resolver with a verifier that models the platform: it accepts the known
 * valid token and rejects everything else. This is a stub of `verifyJwt`, not of
 * the resolver — the resolver logic under test is the real one.
 */
function resolver(accepted: Set<string>) {
  return new AuthResolver({
    mode: 'deepspace',
    sessions: { resolve: async () => null } as never,
    users: { findById: async () => USER } as never,
    verifyJwt: async (_config, token) => ({
      result: token && accepted.has(token) ? { userId: USER.id, claims: {} } : null,
    }),
    bindings: () => ({
      AUTH_JWT_PUBLIC_KEY: 'test-key',
      AUTH_JWT_ISSUER: 'https://auth.deep.space/api/auth',
    }),
    ensureUser: async (user) => user,
  })
}

/** Build the request a browser sends after the fix. */
function request(headers: Record<string, string>): Request {
  return new Request('https://signalmess.test/api/auth/me', { headers })
}

describe('the fix: bearer resolves where the cookie alone cannot', () => {
  const auth = resolver(new Set([VALID_JWT]))

  it('cookie-only (the old behaviour) yields 401', async () => {
    const resolved = await auth.resolve(
      request({ cookie: `__Secure-better-auth.session_token=${SESSION_TOKEN}` }),
    )
    assert.equal(resolved, null, 'a session token cannot be verified as a JWT')
  })

  it('cookie + bearer (the new behaviour) resolves the identity', async () => {
    const resolved = await auth.resolve(
      request({
        cookie: `__Secure-better-auth.session_token=${SESSION_TOKEN}`,
        authorization: `Bearer ${VALID_JWT}`,
      }),
    )
    assert.ok(resolved, 'identity resolves')
    assert.equal(resolved.user.id, USER.id)
    assert.equal(resolved.mode, 'deepspace')
  })

  it('bearer alone is enough (cookie not required for verification)', async () => {
    const resolved = await auth.resolve(request({ authorization: `Bearer ${VALID_JWT}` }))
    assert.ok(resolved)
    assert.equal(resolved.user.id, USER.id)
  })

  it('an invalid bearer is rejected even alongside a valid cookie', async () => {
    // The bearer wins: a bad bearer must not silently fall back to the cookie,
    // or a revoked token would keep working.
    const resolved = await auth.resolve(
      request({
        cookie: `__Secure-better-auth.session_token=${SESSION_TOKEN}`,
        authorization: 'Bearer not-a-valid-jwt',
      }),
    )
    assert.equal(resolved, null)
  })

  it('an expired bearer is rejected', async () => {
    const resolved = await auth.resolve(request({ authorization: `Bearer ${EXPIRED_JWT}` }))
    assert.equal(resolved, null)
  })

  it('no credential at all is rejected', async () => {
    assert.equal(await auth.resolve(request({})), null)
  })
})

describe('renewal: the cookie still obtains a fresh JWT', () => {
  it('a renewed token works after the previous one stops verifying', async () => {
    // Models token expiry: the old JWT no longer verifies, a new one does. The
    // cookie is unchanged throughout — that is what makes renewal possible.
    const acceptedAfterRenewal = new Set(['eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1c2VyXzQyIn0.bmV3'])
    const auth = resolver(acceptedAfterRenewal)

    const before = await auth.resolve(request({ authorization: `Bearer ${VALID_JWT}` }))
    assert.equal(before, null, 'the stale token no longer verifies')

    const renewed = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1c2VyXzQyIn0.bmV3'
    const after = await auth.resolve(
      request({
        cookie: `__Secure-better-auth.session_token=${SESSION_TOKEN}`,
        authorization: `Bearer ${renewed}`,
      }),
    )
    assert.ok(after, 'the renewed token resolves with the same cookie')
    assert.equal(after.user.id, USER.id)
  })
})

describe('isolation is preserved', () => {
  it("another user's token resolves to that user, never to a merged identity", async () => {
    const otherUserJwt = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1c2VyXzk5In0.c2ln'
    const auth = new AuthResolver({
      mode: 'deepspace',
      sessions: { resolve: async () => null } as never,
      users: { findById: async () => ({ ...USER, id: 'user_99' }) as UserRecord } as never,
      verifyJwt: async (_config, token) => ({
        result: token === otherUserJwt ? { userId: 'user_99', claims: {} } : null,
      }),
      bindings: () => ({ AUTH_JWT_PUBLIC_KEY: 'k', AUTH_JWT_ISSUER: 'i' }),
      ensureUser: async (user) => user,
    })

    const resolved = await auth.resolve(request({ authorization: `Bearer ${otherUserJwt}` }))
    assert.ok(resolved)
    assert.equal(resolved.user.id, 'user_99')
  })
})
