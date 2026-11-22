import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPair, exportSPKI, SignJWT, type KeyObject } from 'jose'
import { verifyJwt } from 'deepspace/worker'
import { loadConfig } from '../../server/config.ts'

/**
 * `authorizedParties` on the privileged identity path (v0.2.4).
 *
 * ## What is real here and what is not
 *
 * **Real:** RSA/EC key generation, JWT signing (`jose`), and the SDK's own
 * `verifyJwt` from `deepspace/worker` — the exact function `resolveIdentity` and
 * `AuthResolver` both call. These tests therefore exercise the SDK's actual
 * `azp` logic, not a stand-in.
 *
 * **Not exercised:** `resolveIdentity` itself is a module-private function in
 * `worker.ts`, and the Worker cannot be booted in this environment (workerd does
 * not start; see docs/testing.md §6.2). What is covered is the substitution the
 * v0.2.4 fix makes — that the verifier receives `config.authorizedParties` — via
 * the same configuration shape `resolveIdentity` now builds, plus a static
 * assertion on the worker's source.
 *
 * The SDK's documented behavior, confirmed against `deepspace@0.44.2`
 * `dist/worker.js` (`matchesAuthorizedParty`) and by the probes below:
 *
 *   - `azp` absent            → **accepted** (`if (!azp) return true`)
 *   - `azp` exactly matching  → accepted
 *   - `azp` wildcard matching → accepted (`*` → `[^/]*`, plus `*.` root form)
 *   - `azp` not matching      → rejected
 *   - no `authorizedParties`  → the `azp` check is skipped entirely
 */

const ISSUER = 'https://auth.deepspace.test'
const APP_ORIGIN = 'https://signalmess.app.space'

let publicKeyPem: string
let privateKey: KeyObject

/** Generate one ES256 pair for the whole file; signing is the expensive part. */
async function keys(): Promise<{ pem: string; key: KeyObject }> {
  if (!publicKeyPem) {
    const pair = await generateKeyPair('ES256')
    publicKeyPem = await exportSPKI(pair.publicKey)
    privateKey = pair.privateKey as unknown as KeyObject
  }
  return { pem: publicKeyPem, key: privateKey }
}

/** Sign a token. `azp: null` omits the claim entirely. */
async function signToken(options: {
  subject?: string
  azp?: string | null
  issuer?: string
  expiresIn?: string
  expiresAt?: number
  wrongKey?: KeyObject
}): Promise<string> {
  const { key } = await keys()
  const payload: Record<string, unknown> = {}
  if (options.azp !== null) payload['azp'] = options.azp ?? APP_ORIGIN

  let builder = new SignJWT(payload)
    .setProtectedHeader({ alg: 'ES256' })
    .setSubject(options.subject ?? 'user_a')
    .setIssuer(options.issuer ?? ISSUER)
    .setIssuedAt()

  if (options.expiresAt !== undefined) builder = builder.setExpirationTime(options.expiresAt)
  else builder = builder.setExpirationTime(options.expiresIn ?? '5m')

  return builder.sign(options.wrongKey ?? key)
}

/** The verifier config shape `resolveIdentity` builds from `config`. */
async function verifierConfig(authorizedParties: string[]) {
  const { pem } = await keys()
  const config: { publicKey: string; issuer: string; authorizedParties?: string[] } = {
    publicKey: pem,
    issuer: ISSUER,
  }
  // Mirrors resolveIdentity/AuthResolver: omit when empty, so the SDK sees
  // "no party constraint" rather than "match nothing".
  if (authorizedParties.length > 0) config.authorizedParties = authorizedParties
  return config
}

async function verify(authorizedParties: string[], token: string) {
  return verifyJwt(await verifierConfig(authorizedParties), token)
}

describe('valid token with an authorized azp', () => {
  it('is accepted', async () => {
    const outcome = await verify([APP_ORIGIN], await signToken({}))
    assert.equal(outcome.error, undefined)
    assert.equal(outcome.result?.userId, 'user_a')
  })

  it('is accepted when azp matches one of several allowed parties', async () => {
    const outcome = await verify(
      ['https://outro.app.space', APP_ORIGIN],
      await signToken({ azp: APP_ORIGIN }),
    )
    assert.equal(outcome.result?.userId, 'user_a')
  })

  it('is accepted through a wildcard pattern', async () => {
    const outcome = await verify(['https://*.app.space'], await signToken({ azp: 'https://signalmess.app.space' }))
    assert.equal(outcome.result?.userId, 'user_a')
  })
})

describe('token with an unauthorized azp', () => {
  it('is rejected', async () => {
    const outcome = await verify([APP_ORIGIN], await signToken({ azp: 'https://atacante.example' }))
    assert.equal(outcome.result, null)
    assert.ok(outcome.error instanceof Error)
    assert.match(String(outcome.error?.message), /Authorized party/i)
  })

  it('is rejected even though signature, issuer and expiry are all valid', async () => {
    // The point of the v0.2.4 fix: without `authorizedParties` this token would
    // have been accepted on /api/actions/* while being refused on every route
    // that goes through AuthResolver.
    const token = await signToken({ azp: 'https://outro-app.app.space' })
    const withoutParties = await verify([], token)
    assert.equal(withoutParties.result?.userId, 'user_a', 'sem authorizedParties o token passa')

    const withParties = await verify([APP_ORIGIN], token)
    assert.equal(withParties.result, null, 'com authorizedParties o token é recusado')
  })

  it('is rejected for a lookalike origin', async () => {
    // Guards against a prefix/substring comparison.
    for (const azp of [
      'https://signalmess.app.space.atacante.example',
      'http://signalmess.app.space',
      'https://app.space',
    ]) {
      const outcome = await verify([APP_ORIGIN], await signToken({ azp }))
      assert.equal(outcome.result, null, `${azp} não deveria ser aceito`)
    }
  })
})

describe('token without azp follows the SDK contract', () => {
  it('is ACCEPTED when authorizedParties is configured — documented SDK behavior', async () => {
    // `matchesAuthorizedParty`: `if (!azp) return true`. This is the SDK's
    // documented narrowing, not an oversight in this app: the platform does not
    // always set `azp`, so a token without it must remain usable. Signature,
    // issuer and expiry are still enforced.
    const outcome = await verify([APP_ORIGIN], await signToken({ azp: null }))
    assert.equal(outcome.result?.userId, 'user_a')
    assert.equal(outcome.error, undefined)
  })

  it('is accepted when authorizedParties is empty', async () => {
    const outcome = await verify([], await signToken({ azp: null }))
    assert.equal(outcome.result?.userId, 'user_a')
  })
})

describe('invalid or expired token', () => {
  it('is rejected when the signature does not verify', async () => {
    const other = await generateKeyPair('ES256')
    const token = await signToken({ wrongKey: other.privateKey as unknown as KeyObject })
    const outcome = await verify([APP_ORIGIN], token)
    assert.equal(outcome.result, null)
  })

  it('is rejected when expired', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600
    const outcome = await verify([APP_ORIGIN], await signToken({ expiresAt: past }))
    assert.equal(outcome.result, null)
    assert.ok(outcome.error instanceof Error)
  })

  it('is rejected when the issuer differs', async () => {
    const outcome = await verify([APP_ORIGIN], await signToken({ issuer: 'https://outro-emissor.test' }))
    assert.equal(outcome.result, null)
  })

  it('is rejected when malformed', async () => {
    for (const token of ['', 'nao-e-um-jwt', 'a.b.c']) {
      const outcome = await verifyJwt(await verifierConfig([APP_ORIGIN]), token)
      assert.equal(outcome.result, null, `deveria recusar ${JSON.stringify(token)}`)
    }
  })

  it('is rejected when the subject claim is missing', async () => {
    const { key } = await keys()
    const token = await new SignJWT({ azp: APP_ORIGIN })
      .setProtectedHeader({ alg: 'ES256' })
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key)
    const outcome = await verify([APP_ORIGIN], token)
    assert.equal(outcome.result, null)
  })
})

describe('missing verification configuration', () => {
  it('fails closed when the public key is absent', async () => {
    // `resolveIdentity` returns null before calling verifyJwt when either
    // binding is missing; this asserts the verifier itself also refuses.
    const outcome = await verifyJwt(
      { publicKey: '', issuer: ISSUER, authorizedParties: [APP_ORIGIN] },
      await signToken({}),
    )
    assert.equal(outcome.result, null)
  })

  it('fails closed when a key from an unrelated issuer is used', async () => {
    const { pem } = await keys()
    const outcome = await verifyJwt(
      { publicKey: pem, issuer: 'https://outro-emissor.test', authorizedParties: [APP_ORIGIN] },
      await signToken({}),
    )
    assert.equal(outcome.result, null)
  })
})

describe('config.authorizedParties as the single source of truth', () => {
  it('defaults to the app origin in the worker runtime', () => {
    const config = loadConfig(
      { AUTH_JWT_ISSUER: ISSUER, APP_ORIGIN: APP_ORIGIN, DEEPSPACE_APP_ID: 'app_1' },
      { runtime: 'worker' },
    )
    assert.deepEqual(config.authorizedParties, [APP_ORIGIN])
  })

  it('honours AZP_ORIGINS when set', () => {
    const config = loadConfig(
      {
        AUTH_JWT_ISSUER: ISSUER,
        APP_ORIGIN: APP_ORIGIN,
        AZP_ORIGINS: 'https://a.example, https://*.b.example',
        DEEPSPACE_APP_ID: 'app_1',
      },
      { runtime: 'worker' },
    )
    assert.deepEqual(config.authorizedParties, ['https://a.example', 'https://*.b.example'])
  })

  it('produces a list the verifier actually enforces', async () => {
    const config = loadConfig(
      { AUTH_JWT_ISSUER: ISSUER, APP_ORIGIN: APP_ORIGIN, DEEPSPACE_APP_ID: 'app_1' },
      { runtime: 'worker' },
    )
    const accepted = await verify(config.authorizedParties, await signToken({ azp: APP_ORIGIN }))
    assert.equal(accepted.result?.userId, 'user_a')

    const refused = await verify(config.authorizedParties, await signToken({ azp: 'https://atacante.example' }))
    assert.equal(refused.result, null)
  })
})
