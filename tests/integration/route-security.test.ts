import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildApp, serveApp } from '../../server/bootstrap.ts'
import type { Client } from './harness.ts'
import { createClient, signIn } from './harness.ts'

/**
 * Route-level security audit.
 *
 * The ownership suite proves the storage layer; this one proves the HTTP layer:
 * every private route refuses an unauthenticated caller, no response leaks a
 * secret, and the integration kill switches are actually enforced.
 *
 * It runs against the real app (Hono + middleware + services + SQLite) on a real
 * socket, so 401s come from `requireUser`, not from a test double.
 */

let base: string
let closeApp: () => Promise<void>
let app: Awaited<ReturnType<typeof buildApp>>
let authenticated: Client

before(async () => {
  app = await buildApp({
    env: {
      NODE_ENV: 'development',
      DATABASE_URL: ':memory:',
      SESSION_SECRET: 'audit-secret-value-long-enough-1234567890abcd',
      // Deliberately disabled: the kill switches are what this suite audits.
      ENABLE_EXTERNAL_APIS: 'false',
      EXA_API_KEY: 'audit-exa-key-should-never-leak',
      GEMINI_API_KEY: 'audit-gemini-key-should-never-leak',
    },
  })
  const served = await serveApp(app.app)
  base = served.base
  closeApp = served.close
  authenticated = await signIn(base, 'auditoria@example.com', 'Auditoria')
})

after(async () => {
  await closeApp()
  app.close()
})

/** Every route that must not answer an anonymous caller. */
const PRIVATE_ROUTES: Array<{ method: string; path: string }> = [
  { method: 'GET', path: '/api/dashboard' },
  { method: 'GET', path: '/api/investigations' },
  { method: 'POST', path: '/api/investigations' },
  { method: 'GET', path: '/api/investigations/inv_qualquer' },
  { method: 'PATCH', path: '/api/investigations/inv_qualquer' },
  { method: 'DELETE', path: '/api/investigations/inv_qualquer' },
  { method: 'POST', path: '/api/investigations/inv_qualquer/status' },
  { method: 'POST', path: '/api/investigations/inv_qualquer/archive' },
  { method: 'GET', path: '/api/investigations/inv_qualquer/history' },
  { method: 'POST', path: '/api/investigations/inv_qualquer/research' },
  { method: 'GET', path: '/api/investigations/inv_qualquer/evidence' },
  { method: 'POST', path: '/api/investigations/inv_qualquer/evidence' },
  { method: 'POST', path: '/api/investigations/inv_qualquer/evidence/bulk' },
  { method: 'GET', path: '/api/investigations/inv_qualquer/analyses' },
  { method: 'POST', path: '/api/investigations/inv_qualquer/analyses' },
  { method: 'GET', path: '/api/investigations/inv_qualquer/export' },
  { method: 'GET', path: '/api/evidence/evi_qualquer/validations' },
  { method: 'POST', path: '/api/evidence/evi_qualquer/validation' },
  { method: 'PATCH', path: '/api/evidence/evi_qualquer' },
  { method: 'DELETE', path: '/api/evidence/evi_qualquer' },
  { method: 'GET', path: '/api/analyses/ana_qualquer' },
  { method: 'GET', path: '/api/validations' },
  { method: 'GET', path: '/api/history' },
  { method: 'GET', path: '/api/settings' },
  { method: 'PATCH', path: '/api/settings/limits' },
  { method: 'GET', path: '/api/auth/me' },
]

describe('private routes refuse anonymous callers', () => {
  it('answers 401 with the standard error envelope on every route', async () => {
    const anonymous = createClient(base)
    const failures: string[] = []

    for (const route of PRIVATE_ROUTES) {
      const response = await anonymous.request(route.method, route.path, route.method === 'GET' ? undefined : {})
      const body = response.body as { success?: boolean; error?: { code?: string } }
      if (response.status !== 401) {
        failures.push(`${route.method} ${route.path} → ${response.status}`)
      } else if (body.error?.code !== 'unauthorized') {
        failures.push(`${route.method} ${route.path} → código ${body.error?.code}`)
      }
    }

    assert.deepEqual(failures, [], `rotas sem proteção:\n${failures.join('\n')}`)
  })

  it('does not treat a client-supplied user header as identity', async () => {
    const response = await fetch(`${base}/api/investigations`, {
      headers: {
        // An attacker guessing at an internal header.
        'x-user-id': 'user_admin',
        'x-app-action': 'true',
        'x-signalmess-request': '1',
      },
    })
    assert.equal(response.status, 401, 'headers de identidade do cliente não podem autenticar')
  })

  it('does not accept a forged session cookie', async () => {
    const response = await fetch(`${base}/api/investigations`, {
      headers: {
        cookie: 'signalmess_session=forged-but-long-enough-to-pass-length-check',
        'x-signalmess-request': '1',
      },
    })
    assert.equal(response.status, 401)
  })

  it('keeps the health probe public and free of internals', async () => {
    const response = await fetch(`${base}/api/health`)
    const body = (await response.json()) as { data: Record<string, unknown> }
    assert.equal(response.status, 200)
    const serialised = JSON.stringify(body)
    assert.ok(!/KEY|TOKEN|SECRET|PASSWORD/i.test(serialised), 'health não pode expor nomes de segredo')
    assert.equal(body.data['storage'], 'sqlite')
    assert.equal(body.data['authMode'], 'local')
  })
})

describe('secrets never reach a response', () => {
  const SECRET_VALUES = ['audit-exa-key-should-never-leak', 'audit-gemini-key-should-never-leak']

  it('settings reports provider state without the key values', async () => {
    const response = await authenticated.request('GET', '/api/settings')
    const body = JSON.stringify(response.body)
    for (const secret of SECRET_VALUES) {
      assert.ok(!body.includes(secret), 'a resposta de settings não pode conter a chave')
    }
    const data = (response.body as { data: { providers: { exa: { configured: boolean } } } }).data
    assert.equal(data.providers.exa.configured, true, 'deve apenas indicar que está configurada')
  })

  it('the auth config endpoint carries no credentials', async () => {
    const response = await authenticated.request('GET', '/api/auth/config')
    const body = JSON.stringify(response.body)
    for (const secret of SECRET_VALUES) assert.ok(!body.includes(secret))
  })

  it('export contains no secret material', async () => {
    const created = await authenticated.request<{ data: { id: string } }>('POST', '/api/investigations', {
      title: 'Auditoria de segredos',
      objective: 'Verificar que a exportação não vaza credenciais do ambiente',
      topic: 'segurança',
    })
    const id = (created.body as { data: { id: string } }).data.id

    const json = await authenticated.request<string>(
      'GET',
      `/api/investigations/${id}/export?format=json&scope=investigation`,
      undefined,
      { rawText: true },
    )
    const csv = await authenticated.request<string>(
      'GET',
      `/api/investigations/${id}/export?format=csv&scope=investigation`,
      undefined,
      { rawText: true },
    )

    for (const body of [json.body, csv.body]) {
      for (const secret of SECRET_VALUES) assert.ok(!body.includes(secret))
      assert.ok(!/signalmess_session/i.test(body))
      assert.ok(!/SESSION_SECRET/i.test(body))
    }
  })
})

describe('external integrations are blocked when disabled', () => {
  it('refuses research before any provider call', async () => {
    const created = await authenticated.request<{ data: { id: string } }>('POST', '/api/investigations', {
      title: 'Bloqueio de pesquisa',
      objective: 'Verificar o bloqueio quando as integrações externas estão desligadas',
      topic: 'teste',
    })
    const id = (created.body as { data: { id: string } }).data.id

    const response = await authenticated.request('POST', `/api/investigations/${id}/research`, {})
    assert.equal(response.status, 503)
    assert.equal((response.body as { error: { code: string } }).error.code, 'external_disabled')

    const analysis = await authenticated.request('POST', `/api/investigations/${id}/analyses`, {})
    assert.equal(analysis.status, 503)
    assert.equal((analysis.body as { error: { code: string } }).error.code, 'external_disabled')
  })
})

describe('CSRF on mutating requests', () => {
  it('rejects a POST without the marker header even when authenticated', async () => {
    const response = await authenticated.request(
      'POST',
      '/api/investigations',
      { title: 'Sem CSRF', objective: 'Objetivo válido para o teste', topic: 'x' },
      { csrf: false },
    )
    assert.equal(response.status, 403)
  })

  it('rejects a cross-origin POST', async () => {
    const response = await authenticated.request(
      'POST',
      '/api/investigations',
      { title: 'Cross origin', objective: 'Objetivo válido para o teste', topic: 'x' },
      { origin: 'https://evil.example' },
    )
    assert.equal(response.status, 403)
  })
})

describe('browser cannot reach the record room directly', () => {
  it('does not expose a public records endpoint', async () => {
    for (const path of ['/api/tools/execute', '/api/records', '/api/records/query']) {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-signalmess-request': '1' },
        body: JSON.stringify({ tool: 'records.query', params: { collection: 'investigations' } }),
      })
      assert.ok(
        response.status === 404 || response.status === 401,
        `${path} não pode ser um atalho para o RecordRoom (respondeu ${response.status})`,
      )
    }
  })

  it('does not serve the former phantom migration endpoint', async () => {
    // The v0.2 CLI targeted `/api/internal/records/tools`, which was never
    // implemented. It must stay absent: the administrative path is the
    // owner-gated server action, not an internal tools proxy.
    const response = await fetch(`${base}/api/internal/records/tools`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signalmess-request': '1' },
      body: '{}',
    })
    assert.ok(response.status === 404 || response.status === 401)
  })

  it('exposes the action route but only behind authentication', async () => {
    const anonymous = await fetch(`${base}/api/actions/migrateRecords`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signalmess-request': '1' },
      body: JSON.stringify({ ownerId: 'user_x', rows: [], dryRun: true }),
    })
    assert.equal(anonymous.status, 401, 'a ação administrativa não pode ser anônima')
  })

  it('ignores forged migration headers without granting identity', async () => {
    const response = await fetch(`${base}/api/actions/migrateRecords`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-signalmess-request': '1',
        'x-migration-owner': 'user_owner',
        'x-migration-app': 'app_forged',
        'x-user-id': 'user_owner',
      },
      body: JSON.stringify({ ownerId: 'user_owner', rows: [], dryRun: true }),
    })
    assert.equal(response.status, 401, 'headers do cliente não são prova de identidade')
  })

  it('does not let the browser reach the action without an owner identity', async () => {
    // Authenticated as a normal member of the local adapter: still refused,
    // because the action is owner-gated.
    const response = await authenticated.request('POST', '/api/actions/migrateRecords', {
      ownerId: 'auditoria@example.com',
      rows: [],
      dryRun: true,
    })
    assert.ok(
      response.status === 401 || response.status === 403 || response.status === 404,
      `membro não pode executar a ação administrativa (respondeu ${response.status})`,
    )
  })
})
