import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AuthResolver } from '../../server/lib/auth-resolver.ts'
import { userRecordFromClaims } from '../../server/lib/auth-context.ts'
import { assertProductionSafety, loadConfig } from '../../server/config.ts'
import type { UserRecord } from '../../server/types.ts'

/**
 * Identity resolution.
 *
 * The point of these tests is the *mode boundary*: the local adapter must be
 * unreachable when the runtime is the platform, and the platform path must fail
 * closed whenever verification material is missing, malformed, or the token does
 * not verify. A regression here is an authentication bypass, so every negative
 * case is asserted explicitly.
 */

const USERS = new Map<string, UserRecord>([
  [
    'user_known',
    {
      id: 'user_known',
      email: 'stored@example.com',
      name: 'Nome Armazenado',
      avatarUrl: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    },
  ],
])

function usersRepo() {
  return {
    findById: async (id: string) => USERS.get(id) ?? null,
    findByEmail: async (email: string) =>
      [...USERS.values()].find((user) => user.email === email) ?? null,
    upsert: async (user: UserRecord) => {
      USERS.set(user.id, user)
      return user
    },
  }
}

interface VerifierCall {
  publicKey: string
  issuer: string
  token: string | null
}

/** A verifier that records what it was asked and returns a scripted outcome. */
function scriptedVerifier(outcome: { userId: string; claims: Record<string, unknown> } | null) {
  const calls: VerifierCall[] = []
  return {
    calls,
    verifyJwt: async (config: { publicKey: string; issuer: string }, token: string | null | undefined) => {
      calls.push({ publicKey: config.publicKey, issuer: config.issuer, token: token ?? null })
      return { result: outcome }
    },
  }
}

function request(headers: Record<string, string> = {}): Request {
  return new Request('https://signalmess.app.space/api/investigations', { headers })
}

const BINDINGS = { AUTH_JWT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----test', AUTH_JWT_ISSUER: 'https://auth.deep.space/api/auth' }

function deepspaceResolver(
  verifier: ReturnType<typeof scriptedVerifier>,
  bindings: Partial<typeof BINDINGS> = BINDINGS,
) {
  return new AuthResolver({
    mode: 'deepspace',
    sessions: { resolve: async () => null } as never,
    users: usersRepo(),
    verifyJwt: verifier.verifyJwt as never,
    bindings: () => bindings,
    ensureUser: async (user) => user,
  })
}

describe('config: runtime determines the auth mode', () => {
  it('uses the local adapter under plain Node', () => {
    const config = loadConfig({}, { runtime: 'node' })
    assert.equal(config.authMode, 'local')
    assert.equal(config.persistence, 'sqlite')
  })

  it('forces DeepSpace auth and Records on the worker runtime', () => {
    const config = loadConfig({}, { runtime: 'worker' })
    assert.equal(config.authMode, 'deepspace')
    assert.equal(config.persistence, 'records')
  })

  it('switches to DeepSpace when the platform marks the runtime with an app id', () => {
    // `deepspace dev start` runs locally but injects DEEPSPACE_APP_ID.
    const config = loadConfig({ DEEPSPACE_APP_ID: 'app_0123456789ABCDEF' }, { runtime: 'node' })
    assert.equal(config.authMode, 'deepspace')
    assert.equal(config.persistence, 'records')
  })

  it('refuses a worker configuration that would use the local adapter', () => {
    assert.throws(
      () =>
        assertProductionSafety({
          ...loadConfig({}, { runtime: 'worker' }),
          authMode: 'local',
        }),
      /DeepSpace authentication/,
    )
  })

  it('refuses the local adapter when NODE_ENV=production', () => {
    assert.throws(
      () =>
        assertProductionSafety({
          ...loadConfig({ NODE_ENV: 'production' }, { runtime: 'node' }),
          authMode: 'local',
        }),
      /NODE_ENV=production requires DeepSpace authentication/,
    )
  })

  it('refuses paid operations without the external-API switch', () => {
    assert.throws(
      () =>
        assertProductionSafety({
          ...loadConfig({ ENABLE_PAID_OPERATIONS: 'true' }, { runtime: 'worker' }),
          paidOperationsEnabled: true,
          externalApisEnabled: false,
        }),
      /ENABLE_PAID_OPERATIONS requires ENABLE_EXTERNAL_APIS/,
    )
  })
})

describe('AuthResolver: DeepSpace mode', () => {
  it('resolves a valid bearer token to the stored user', async () => {
    const verifier = scriptedVerifier({
      userId: 'user_known',
      claims: { email: 'claims@example.com', name: 'Nome do Claim' },
    })
    const resolver = deepspaceResolver(verifier)

    const identity = await resolver.resolve(request({ authorization: 'Bearer valid.jwt.token' }))
    assert.ok(identity)
    assert.equal(identity.user.id, 'user_known')
    assert.equal(identity.mode, 'deepspace')
    // Claims win over the stored row, because they are fresher.
    assert.equal(identity.user.name, 'Nome do Claim')
    assert.equal(identity.user.email, 'claims@example.com')
  })

  it('passes the platform key and issuer to the verifier', async () => {
    const verifier = scriptedVerifier({ userId: 'user_known', claims: {} })
    await deepspaceResolver(verifier).resolve(request({ authorization: 'Bearer t' }))

    assert.equal(verifier.calls.length, 1)
    assert.equal(verifier.calls[0]!.publicKey, BINDINGS.AUTH_JWT_PUBLIC_KEY)
    assert.equal(verifier.calls[0]!.issuer, BINDINGS.AUTH_JWT_ISSUER)
    assert.equal(verifier.calls[0]!.token, 't')
  })

  it('reads the platform session cookie when there is no bearer token', async () => {
    const verifier = scriptedVerifier({ userId: 'user_known', claims: {} })
    const identity = await deepspaceResolver(verifier).resolve(
      request({ cookie: '__Secure-better-auth.session_token=cookie.token.value' }),
    )

    assert.ok(identity)
    assert.equal(verifier.calls[0]!.token, 'cookie.token.value')
  })

  it('prefers the bearer token over the cookie', async () => {
    const verifier = scriptedVerifier({ userId: 'user_known', claims: {} })
    await deepspaceResolver(verifier).resolve(
      request({
        authorization: 'Bearer from.header',
        cookie: '__Secure-better-auth.session_token=from.cookie',
      }),
    )
    assert.equal(verifier.calls[0]!.token, 'from.header')
  })

  it('returns null when verification fails', async () => {
    const verifier = scriptedVerifier(null)
    const identity = await deepspaceResolver(verifier).resolve(request({ authorization: 'Bearer bad' }))
    assert.equal(identity, null)
  })

  it('returns null when there is no token at all', async () => {
    const verifier = scriptedVerifier({ userId: 'user_known', claims: {} })
    const identity = await deepspaceResolver(verifier).resolve(request())
    assert.equal(identity, null)
    assert.equal(verifier.calls.length, 0, 'não deve chamar o verificador sem token')
  })

  it('fails closed when the verifier bindings are missing', async () => {
    // Without a public key or issuer there is no way to trust anything, even a
    // header that claims an identity.
    for (const bindings of [
      {},
      { AUTH_JWT_PUBLIC_KEY: 'key' },
      { AUTH_JWT_ISSUER: 'issuer' },
    ]) {
      const verifier = scriptedVerifier({ userId: 'user_known', claims: {} })
      const identity = await deepspaceResolver(verifier, bindings).resolve(
        request({ authorization: 'Bearer looks-legit' }),
      )
      assert.equal(identity, null, `deveria falhar sem bindings completos: ${JSON.stringify(bindings)}`)
      assert.equal(verifier.calls.length, 0)
    }
  })

  it('never consults the local session store', async () => {
    const verifier = scriptedVerifier({ userId: 'user_known', claims: {} })
    let localLookups = 0
    const resolver = new AuthResolver({
      mode: 'deepspace',
      sessions: {
        resolve: async () => {
          localLookups += 1
          return null
        },
      } as never,
      users: usersRepo(),
      verifyJwt: verifier.verifyJwt as never,
      bindings: () => BINDINGS,
      ensureUser: async (user) => user,
    })

    await resolver.resolve(request({ cookie: 'signalmess_session=forged', authorization: 'Bearer t' }))
    assert.equal(localLookups, 0, 'a sessão local não pode ser consultada em modo DeepSpace')
  })

  it('derives a user record when the row does not exist yet', async () => {
    const verifier = scriptedVerifier({
      userId: 'user_brand_new',
      claims: { email: 'novo@example.com', name: 'Pessoa Nova', image: 'https://img/x.png' },
    })
    const identity = await deepspaceResolver(verifier).resolve(request({ authorization: 'Bearer t' }))

    assert.ok(identity)
    assert.equal(identity.user.id, 'user_brand_new')
    assert.equal(identity.user.email, 'novo@example.com')
    assert.equal(identity.user.name, 'Pessoa Nova')
    assert.equal(identity.user.avatarUrl, 'https://img/x.png')
  })

  it('falls back to the email local-part when the claim has no name', async () => {
    const verifier = scriptedVerifier({
      userId: 'user_no_name',
      claims: { email: 'pesquisador@example.com' },
    })
    const identity = await deepspaceResolver(verifier).resolve(request({ authorization: 'Bearer t' }))
    assert.equal(identity?.user.name, 'pesquisador')
  })
})

describe('userRecordFromClaims', () => {
  it('never invents an email that was not asserted', () => {
    const user = userRecordFromClaims({ userId: 'u1', claims: {} })
    assert.equal(user.email, '')
    assert.equal(user.name, 'Pesquisador')
  })

  it('uses the issued-at claim for the creation timestamp', () => {
    const issuedAt = Math.floor(Date.parse('2025-06-01T12:00:00.000Z') / 1000)
    const user = userRecordFromClaims({ userId: 'u1', claims: { iat: issuedAt } })
    assert.equal(user.createdAt, '2025-06-01T12:00:00.000Z')
  })
})

describe('AuthResolver: local mode', () => {
  it('resolves a session from the local cookie', async () => {
    const resolver = new AuthResolver({
      mode: 'local',
      sessions: {
        resolve: async (token: string) => (token === 'valid-local' ? USERS.get('user_known')! : null),
      } as never,
      users: usersRepo(),
      verifyJwt: async () => ({ result: null }),
      bindings: () => ({}),
      ensureUser: async (user) => user,
    })

    const identity = await resolver.resolve(request({ cookie: 'signalmess_session=valid-local' }))
    assert.ok(identity)
    assert.equal(identity.mode, 'local')
    assert.equal(identity.user.id, 'user_known')
  })

  it('rejects an unknown local session', async () => {
    const resolver = new AuthResolver({
      mode: 'local',
      sessions: { resolve: async () => null } as never,
      users: usersRepo(),
      verifyJwt: async () => ({ result: null }),
      bindings: () => ({}),
      ensureUser: async (user) => user,
    })

    const identity = await resolver.resolve(request({ cookie: 'signalmess_session=forged' }))
    assert.equal(identity, null)
  })

  it('ignores a platform bearer token in local mode', async () => {
    // In local mode a bearer header must not authenticate anyone: there is no
    // verifier configured, and trusting the header would be an open door.
    const resolver = new AuthResolver({
      mode: 'local',
      sessions: { resolve: async () => null } as never,
      users: usersRepo(),
      verifyJwt: async () => ({ result: { userId: 'user_known', claims: {} } }),
      bindings: () => BINDINGS,
      ensureUser: async (user) => user,
    })

    const identity = await resolver.resolve(request({ authorization: 'Bearer anything' }))
    assert.equal(identity, null)
  })
})
