import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp, serveApp } from '../../server/bootstrap.ts'
import { CSRF_HEADER } from '../../server/lib/sessions.ts'
import { evaluateCsrfPolicy, hasSessionCookie } from '../../server/lib/csrf-policy.ts'
import { signIn, createClient } from './harness.ts'

/**
 * The CLI's real HTTP path, end to end.
 *
 * The CLI now sends `x-signalmess-request: 1` **and** a bearer token. This suite
 * proves that combination is what the server requires, by exercising the actual
 * `createApp` assembly — `csrfGuard`, then the action route — on a real socket.
 *
 * It deliberately does not stub the guard: a unit test of the policy would pass
 * even if the guard were never mounted, which is the failure this suite exists
 * to catch.
 *
 * ## What the local runtime can and cannot prove
 *
 * The Node runtime authenticates with the *local session adapter*, not the
 * platform JWT, so a token minted here is not a DeepSpace token. Therefore:
 *
 *  - the **ordering** (CSRF before dispatch, identity before dispatch) is real;
 *  - the **cookie lane** is real: a cookie request without the marker is refused
 *    with 403 before any handler runs;
 *  - the **verified-bearer exemption** cannot be produced here — `services.auth`
 *    never resolves a bearer token in local mode — so it is covered by the
 *    policy-level tests below, which drive the same function the guard calls.
 *
 * That split is stated rather than papered over: the exemption's correctness on
 * the platform depends on `verifyJwt`, which only the Worker can exercise.
 */

const OWNER = 'owner@example.com'

let base: string
let closeApp: () => Promise<void>
let app: Awaited<ReturnType<typeof buildApp>>

before(async () => {
  app = await buildApp({
    env: {
      NODE_ENV: 'development',
      DATABASE_URL: ':memory:',
      SESSION_SECRET: 'cli-flow-secret-value-long-enough-1234567890',
      ENABLE_EXTERNAL_APIS: 'false',
      // The migration action is self-scoped, not owner-gated (v0.2.3); this is
      // set only to exercise the owner-only policy alongside it.
      OWNER_USER_ID: OWNER,
    },
  })
  const served = await serveApp(app.app)
  base = served.base
  closeApp = served.close
})

after(async () => {
  await closeApp()
  app.close()
})

/** Exactly what the CLI sends: bearer + marker, no cookie, no Origin. */
async function cliRequest(options: {
  token: string | null
  marker?: boolean
  body?: unknown
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (options.marker !== false) headers[CSRF_HEADER] = '1'
  if (options.token) headers.authorization = `Bearer ${options.token}`
  const response = await fetch(`${base}/api/actions/migrateRecords`, {
    method: 'POST',
    headers,
    body: JSON.stringify(
      options.body ?? { ownerId: OWNER, rows: [{ collection: 'investigations', id: 'inv_1', data: {} }], dryRun: true },
    ),
  })
  const text = await response.text()
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    parsed = { __raw: text }
  }
  return { status: response.status, body: parsed }
}

describe('CLI request shape reaches the action route', () => {
  it('is not blocked by the CSRF guard when it sends the marker', async () => {
    // The decisive assertion for the reported risk: before this change the CLI
    // omitted the marker and the guard refused with 403 before authentication.
    const result = await cliRequest({ token: 'token-do-proprietario' })
    assert.notEqual(result.status, 403, 'o marcador CSRF deve dispensar a recusa por CSRF')
  })

  it('passes the CSRF guard but is then refused for want of a verified identity', async () => {
    // No cookie and no verified bearer in the local runtime: the guard lets the
    // request through (the marker is present) and the *action route* refuses it.
    // A 401 here proves the guard did not short-circuit before the route.
    const result = await cliRequest({ token: 'token-do-proprietario' })
    assert.equal(result.status, 401)
  })

  it('is refused with 403 when the marker is omitted and a cookie is used', async () => {
    // The cookie lane keeps the original rule. This is the browser's threat
    // model, unchanged by the bearer exemption.
    const client = await signIn(base, OWNER, 'Proprietário')
    const response = await client.request<Record<string, unknown>>(
      'POST',
      '/api/actions/migrateRecords',
      { ownerId: OWNER, rows: [], dryRun: true },
      { csrf: false },
    )
    assert.equal(response.status, 403)
  })

  it('still refuses an unknown action name even with a valid marker', async () => {
    const response = await fetch(`${base}/api/actions/naoExiste`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CSRF_HEADER]: '1' },
      body: '{}',
    })
    assert.equal(response.status, 404)
  })

  it('keeps a cross-site Origin refused regardless of the marker', async () => {
    // The origin check is independent of the CSRF lane and must stay strict.
    const response = await fetch(`${base}/api/actions/migrateRecords`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [CSRF_HEADER]: '1',
        origin: 'https://atacante.example',
      },
      body: JSON.stringify({ ownerId: OWNER, rows: [], dryRun: true }),
    })
    assert.equal(response.status, 403)
  })
})

describe('CSRF policy: lane selection', () => {
  /** A verifier that accepts exactly one token. */
  const verifier = async (token: string | null) =>
    token === 'valid'
      ? { mode: 'deepspace' as const, user: { id: 'u1' } as never, claims: null }
      : null

  function input(headers: Record<string, string>, path = '/api/actions/migrateRecords') {
    return {
      method: 'POST',
      headers: new Headers(headers),
      path,
      verifyCredential: async () => verifier(bearerOf(headers)),
    }
  }

  function bearerOf(headers: Record<string, string>): string | null {
    const raw = headers['authorization']
    return raw?.startsWith('Bearer ') ? raw.slice(7).trim() : null
  }

  it('allows a safe method without any marker', async () => {
    const decision = await evaluateCsrfPolicy({ ...input({}), method: 'GET' })
    assert.equal(decision.allowed, true)
    assert.equal(decision.reason, 'safe-method')
  })

  it('allows a verified bearer with no marker', async () => {
    const decision = await evaluateCsrfPolicy(input({ authorization: 'Bearer valid' }))
    assert.equal(decision.allowed, true)
    assert.equal(decision.reason, 'verified-bearer')
  })

  it('refuses an unverified bearer with no marker', async () => {
    // The exemption is keyed on verification, not on the header's presence.
    const decision = await evaluateCsrfPolicy(input({ authorization: 'Bearer forged' }))
    assert.equal(decision.allowed, false)
    assert.equal(decision.markerMissing, true)
  })

  it('refuses an authenticated bearer that also carries a session cookie', async () => {
    // Ambient credentials must never be laundered through the bearer lane.
    const decision = await evaluateCsrfPolicy(
      input({ authorization: 'Bearer valid', cookie: 'signalmess_session=abc' }),
    )
    assert.equal(decision.allowed, false)
    assert.equal(decision.reason, 'marker-missing')
  })

  it('refuses a platform session cookie carrying a bearer token', async () => {
    const decision = await evaluateCsrfPolicy(
      input({ authorization: 'Bearer valid', cookie: '__Secure-better-auth.session_token=abc' }),
    )
    assert.equal(decision.allowed, false)
  })

  it('never exempts the credential-issuing routes', async () => {
    const decision = await evaluateCsrfPolicy(
      input({ authorization: 'Bearer valid' }, '/api/auth/login'),
    )
    assert.equal(decision.allowed, false)
    assert.equal(decision.reason, 'ineligible-path')
  })

  it('treats a throwing verifier as a failed verification', async () => {
    const decision = await evaluateCsrfPolicy({
      method: 'POST',
      headers: new Headers({ authorization: 'Bearer valid' }),
      path: '/api/actions/migrateRecords',
      verifyCredential: async () => {
        throw new Error('verifier exploded')
      },
    })
    assert.equal(decision.allowed, false)
  })

  it('keeps the marker sufficient on its own', async () => {
    const decision = await evaluateCsrfPolicy(input({ [CSRF_HEADER]: '1' }))
    assert.equal(decision.allowed, true)
    assert.equal(decision.reason, 'marker-present')
  })

  it('requires the marker for a plain unauthenticated request', async () => {
    const decision = await evaluateCsrfPolicy(input({}))
    assert.equal(decision.allowed, false)
  })

  it('detects both cookie flavours as ambient credentials', () => {
    assert.equal(hasSessionCookie(new Headers({ cookie: 'signalmess_session=a' })), true)
    assert.equal(hasSessionCookie(new Headers({ cookie: 'better-auth.session_token=a' })), true)
    assert.equal(hasSessionCookie(new Headers({ cookie: 'outro=1' })), false)
    assert.equal(hasSessionCookie(new Headers()), false)
  })
})

describe('CSRF guard keeps the browser routes strict', () => {
  it('refuses a cookie mutation without the marker on a business route', async () => {
    const client = await signIn(base, 'browser@example.com', 'Navegador')
    const response = await client.request<Record<string, unknown>>(
      'POST',
      '/api/investigations',
      { title: 'x' },
      { csrf: false },
    )
    assert.equal(response.status, 403)
  })

  it('accepts the same mutation when the browser sends the marker', async () => {
    const client = await signIn(base, 'browser2@example.com', 'Navegador')
    const response = await client.request<Record<string, unknown>>('POST', '/api/investigations', {
      title: 'Investigação de teste de CSRF',
      description: '',
      objective: 'Objetivo suficientemente longo para passar na validação do formulário',
      topic: 'csrf',
      keywords: [],
      status: 'draft',
    })
    assert.equal(response.status, 201, `esperava 201, veio ${response.status}: ${JSON.stringify(response.body)}`)
  })

  it('does not let a marker alone authenticate a business route', async () => {
    // The marker is a CSRF heuristic, never an identity.
    const anonymous = createClient(base)
    const response = await anonymous.request<Record<string, unknown>>('GET', '/api/investigations')
    assert.equal(response.status, 401)
  })
})
