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

  it('applies authorizedParties on the privileged identity path too', () => {
    // v0.2.4: `/api/actions/*` authenticates through `resolveIdentity`, not
    // through `requireUser`/`AuthResolver`. Before the fix it verified signature,
    // issuer and expiry but not the `azp` binding, so a token minted for another
    // app of the same platform was accepted here and refused everywhere else.
    const start = source.indexOf('async function resolveIdentity')
    const end = source.indexOf('async function handleWebSocket')
    const identityFn = source.slice(start, end > start ? end : undefined)

    assert.match(identityFn, /config\.authorizedParties/, 'resolveIdentity deve consultar config.authorizedParties')
    assert.match(identityFn, /verifierConfig\.authorizedParties = config\.authorizedParties/)
    // Same shape as AuthResolver: the property is omitted when the list is empty.
    assert.match(identityFn, /if \(config\.authorizedParties\.length > 0\)/)
    // And the verifier must receive that object, not a bare { publicKey, issuer }.
    assert.match(identityFn, /verifyJwt\(verifierConfig, token\)/)
    assert.ok(!/void config/.test(identityFn), 'config não pode ser descartada com void')
  })

  it('keeps the socket path and the action path under the same party policy', () => {
    // Both privileged entry points must consult the same config field.
    const wsFn = source.slice(source.indexOf('async function handleWebSocket'))
    assert.match(wsFn, /config\.authorizedParties/)
    assert.match(wsFn, /authorizedParties = config\.authorizedParties/)
    assert.match(servicesSource, /authorizedParties: \(\) => config\.authorizedParties/)
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

describe('migration goes through the server action, not a private endpoint', () => {
  const actionRoutes = readFileSync(join(process.cwd(), 'server/http/action-routes.ts'), 'utf8')
  const migrateAction = readFileSync(join(process.cwd(), 'server/actions/migrate-records.ts'), 'utf8')
  const actionIndex = readFileSync(join(process.cwd(), 'server/actions/index.ts'), 'utf8')
  const cli = readFileSync(join(process.cwd(), 'scripts/migrate-to-records.ts'), 'utf8')

  it('mounts POST /api/actions/:name', () => {
    assert.match(actionRoutes, /app\.post\('\/api\/actions\/:name'/)
  })

  it('resolves the caller before dispatching, and never from a header', () => {
    // The resolver is consulted before the action map is even indexed.
    const body = actionRoutes.slice(actionRoutes.indexOf("app.post('/api/actions/:name'"))
    const resolveAt = body.indexOf('resolveCaller(')
    const dispatchAt = body.indexOf('await action(')
    assert.ok(resolveAt > 0, 'deve resolver a identidade')
    assert.ok(dispatchAt > resolveAt, 'a identidade deve ser resolvida antes do despacho')

    // No header is read as identity anywhere in the action surface.
    for (const header of ['x-migration-owner', 'x-migration-app', 'x-user-id', 'x-app-action']) {
      assert.ok(!actionRoutes.includes(header), `a rota não deve ler ${header}`)
      assert.ok(!migrateAction.includes(header), `a ação não deve ler ${header}`)
    }
  })

  it('rejects an unknown action name with 404', () => {
    assert.match(actionRoutes, /ALLOWED_ACTIONS/)
    assert.match(actionRoutes, /Action not found/)
  })

  it('registers every action through an explicit authorization policy', () => {
    // `createActions` is the only export path, and each entry must name its
    // policy. v0.2.2 wrapped everything in `ownerOnly`, which made a second
    // account's data unmigratable by anyone; v0.2.3 binds each action to the
    // scope its data actually has.
    assert.match(actionIndex, /migrateRecords: selfScoped\(migrateRecords, \{ ownerParam: 'ownerId' \}\)/)
    assert.match(actionIndex, /export function ownerOnly/)
    assert.match(actionIndex, /export function selfScoped/)
    // The migration must not be owner-gated: that is the defect being fixed.
    assert.ok(
      !/migrateRecords: ownerOnly/.test(actionIndex),
      'migrateRecords não pode exigir o dono do app: cada conta migra os próprios dados',
    )
  })

  it('states that the action route is implemented by SIGNALMESH, not the platform', () => {
    // The route is ours; the SDK supplies types and the X-App-Action transport.
    // Comments that claim otherwise mislead an auditor about the trust boundary.
    assert.match(actionRoutes, /implemented \*\*here\*\*, by SIGNALMESH/i)
    assert.match(actionIndex, /does not mount it|This repository does/i)
  })

  it('never registers an /api/internal route', () => {
    // Assert the *route registration*, not the absence of the literal string.
    // The literal legitimately appears in comments explaining what was replaced,
    // in the security test that proves a 404, and in the audit document; a
    // substring check therefore failed for a reason unrelated to the property it
    // was meant to protect.
    const routePattern = /\.(get|post|patch|put|delete|all|use)\(\s*['"`]\/api\/internal/g
    for (const [name, text] of [
      ['worker.ts', source],
      ['action-routes.ts', actionRoutes],
      ['actions/index.ts', actionIndex],
    ] as const) {
      assert.ok(!routePattern.test(text), `${name} não pode registrar rota /api/internal`)
    }
  })

  it('the CLI calls the action and carries only a bearer token as identity', () => {
    assert.match(cli, /\/api\/actions\/migrateRecords/)
    assert.match(cli, /authorization: `Bearer \$\{input\.token\}`/)
    for (const header of ['x-migration-owner', 'x-migration-app', 'x-user-id']) {
      assert.ok(!cli.includes(header), `o CLI não deve inventar ${header}`)
    }
  })

  it('the CLI sends the CSRF marker and documents that it is not authentication', () => {
    // The marker is required by the browser-facing guard; the credential is the
    // bearer token. Assert both, so a future edit cannot quietly promote the
    // marker to an identity mechanism.
    assert.match(cli, /x-signalmess-request/)
    // The comment wraps, so match across whitespace rather than assuming a line.
    assert.match(cli, /is \*\*not[\s\S]{0,20}authentication\*\*/i, 'o CLI deve dizer que o marcador não autentica')
  })

  it('the CLI bounds every call with a timeout and a bounded retry', () => {
    assert.match(cli, /AbortController/)
    assert.match(cli, /setTimeout\(\(\) => controller\.abort\(\), input\.timeoutMs\)/)
    assert.match(cli, /DEFAULT_TIMEOUT_MS/)
    assert.match(cli, /DEFAULT_RETRIES/)
  })

  it('the CLI supports resuming a partial run without rewriting the source', () => {
    assert.match(cli, /--from/)
    assert.match(cli, /openReadOnlyDatabase/)
    // It must never reach for a write-capable opener.
    assert.ok(!/openDatabase\(/.test(cli), 'a CLI não deve abrir a origem em modo de escrita')
  })

  it('the CLI refuses to run without a target and a token', () => {
    assert.match(cli, /if \(!targetUrl \|\| !token\)/)
    assert.match(cli, /BLOQUEADA/)
  })

  it('the CLI reads the token from stdin, not from argv', () => {
    // A live credential in argv lands in shell history and process listings.
    assert.match(cli, /--token-stdin/)
    assert.match(cli, /readFileSync\(0/)
  })
})
