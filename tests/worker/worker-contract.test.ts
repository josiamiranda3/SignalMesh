import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Worker entry contract.
 *
 * The Worker cannot be booted here (workerd does not start in this environment —
 * see docs/testing.md §9), so these are *static* assertions about its structure:
 * the routes it claims, the identity handling it performs, and what it must never
 * do. They are deliberately narrow — they catch the omissions that a bundle
 * inspection would not, such as a missing `/ws` route.
 *
 * They are not runtime proof. That gap is stated in the report and in
 * docs/testing.md.
 */

const source = readFileSync(join(process.cwd(), 'worker.ts'), 'utf8')
const servicesSource = readFileSync(join(process.cwd(), 'server/services/worker.ts'), 'utf8')

describe('worker entry routes', () => {
  it('claims /ws/* for the realtime record room', () => {
    // Without this the SDK's RecordScope cannot connect and retries forever.
    assert.match(source, /url\.pathname\.startsWith\('\/ws\/'\)/)
    assert.match(source, /handleWebSocket\(/)
  })

  it('routes /ws to the record room Durable Object', () => {
    const wsSection = source.slice(source.indexOf('async function handleWebSocket'))
    assert.match(wsSection, /authenticatedRoomRequest\(/)
    assert.match(wsSection, /RECORD_ROOMS\.get\(/)
    assert.match(wsSection, /idFromName\(/)
  })

  it('verifies the socket token instead of trusting the query alone', () => {
    const wsSection = source.slice(source.indexOf('async function handleWebSocket'))
    assert.match(wsSection, /url\.searchParams\.get\('token'\)/)
    assert.match(wsSection, /verifyJwt\(/)
    // A missing token is refused before the DO is contacted.
    assert.match(wsSection, /if \(!token\) return new Response\('Unauthorized', \{ status: 401 \}\)/)
  })

  it('fails the socket closed without verifier bindings', () => {
    const wsSection = source.slice(source.indexOf('async function handleWebSocket'))
    assert.match(wsSection, /AUTH_JWT_PUBLIC_KEY/)
    assert.match(wsSection, /AUTH_JWT_ISSUER/)
    assert.match(wsSection, /status: 401/)
  })

  it('pins the room to the app scope rather than the path', () => {
    const wsSection = source.slice(source.indexOf('async function handleWebSocket'))
    assert.match(wsSection, /`app:\$\{env\.DEEPSPACE_APP_ID\}`/)
  })

  it('claims /api/* for the Hono app', () => {
    assert.match(source, /url\.pathname\.startsWith\('\/api\/'\)/)
  })

  it('serves the SPA shell from ASSETS and 404s a missing file', () => {
    assert.match(source, /env\.ASSETS\.fetch/)
    assert.match(source, /last\.includes\('\.'\)/)
  })

  it('declares the Durable Object manifest', () => {
    assert.match(source, /__DO_MANIFEST__/)
    assert.match(source, /className: 'AppRecordRoom'/)
    assert.match(source, /sqlite: true/)
  })
})

describe('worker identity handling', () => {
  it('never reads an identity header from the request', () => {
    // The worker must derive identity from a verified token, not from a header a
    // caller controls. Slice from `resolveIdentity` up to the next top-level
    // declaration so the assertion covers only that function.
    const start = source.indexOf('async function resolveIdentity')
    const end = source.indexOf('async function handleWebSocket')
    const identityFn = source.slice(start, end > start ? end : undefined)

    const headerReads = [...identityFn.matchAll(/headers\.get\('([^']+)'\)/g)].map((match) => match[1])
    assert.ok(headerReads.length > 0, 'resolveIdentity deve ler ao menos um header')
    for (const header of headerReads) {
      assert.ok(
        ['authorization', 'cookie'].includes(header!),
        `resolveIdentity não deve ler o header ${header}`,
      )
    }
  })

  it('binds the record transport to the verified user id', () => {
    assert.match(source, /userId: identity\.userId/)
  })

  it('uses the owner identity only for the administrative transport', () => {
    // `ownerUserId` feeds the global usage aggregate; it must not be used as the
    // identity for ordinary requests.
    assert.match(source, /ownerUserId: env\.OWNER_USER_ID/)
    assert.match(servicesSource, /const globalUsage = createGlobalUsageReader\(bindings, ownerUserId\)/)
  })
})

describe('record transport headers', () => {
  it('sends x-user-id on every call', () => {
    assert.match(servicesSource, /'x-user-id': userId/)
  })

  it('sends x-app-action only for the administrative transport', () => {
    // The header appears exactly once, guarded by `appAction`.
    const matches = [...servicesSource.matchAll(/x-app-action/g)]
    assert.equal(matches.length, 1, 'x-app-action deve ser definido em um único lugar')
    assert.match(servicesSource, /if \(appAction\) headers\['x-app-action'\] = 'true'/)
  })

  it('builds the member store with appAction false', () => {
    assert.match(servicesSource, /appAction: false \}\)\)/)
  })

  it('builds the admin store with appAction true', () => {
    assert.match(servicesSource, /appAction: true \}\)\)/)
  })

  it('does not spread the repository map when overriding usage', () => {
    // A spread copies methods off their instance and detaches `this`, so every
    // call would throw at runtime.
    assert.ok(
      !/repos: \{ \.\.\.repos/.test(servicesSource),
      'não espalhe o mapa de repositórios: os métodos perdem o vínculo com this',
    )
    assert.match(servicesSource, /investigations: repos\.investigations/)
  })
})

describe('no DeepSpace proxy or managed AI', () => {
  const forbidden = [
    'tools.integration',
    'apiWorkerFetch',
    'deepspace/ai',
    'createDeepSpaceAI',
    'meterAi',
    '/api/integrations',
  ]

  it('never imports or calls the integration proxy', () => {
    for (const needle of forbidden) {
      assert.ok(!source.includes(needle), `worker.ts não pode usar ${needle}`)
      assert.ok(!servicesSource.includes(needle), `services/worker.ts não pode usar ${needle}`)
    }
  })
})
