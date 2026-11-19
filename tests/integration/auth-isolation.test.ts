import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  SAMPLE_INVESTIGATION,
  createClient,
  signIn,
  startHarness,
  type Client,
  type Harness,
} from './harness.ts'
import type { ApiResponse } from '../../shared/api.ts'
import type { Investigation, Validation } from '../../shared/domain.ts'

/**
 * Authentication, authorization and cross-user isolation.
 *
 * These are the tests that matter most for safety: a caller must never reach
 * another user's investigation, evidence, analysis or export, and must never be
 * able to write without a session.
 */

let harness: Harness
let ana: Client
let bruno: Client
let anaInvestigationId: string

before(async () => {
  harness = await startHarness()
  ana = await signIn(harness.base, 'ana@example.com', 'Ana')
  bruno = await signIn(harness.base, 'bruno@example.com', 'Bruno')

  const created = await ana.request<ApiResponse<Investigation>>('POST', '/api/investigations', SAMPLE_INVESTIGATION)
  assert.equal(created.status, 201)
  anaInvestigationId = (created.body as { data: Investigation }).data.id
})

after(async () => {
  await harness.close()
})

describe('authentication', () => {
  it('rejects unauthenticated access to protected routes', async () => {
    const anonymous = createClient(harness.base)
    for (const path of ['/api/investigations', '/api/dashboard', '/api/settings', '/api/history']) {
      const response = await anonymous.request('GET', path)
      assert.equal(response.status, 401, `${path} deveria exigir autenticação`)
      assert.equal((response.body as { error: { code: string } }).error.code, 'unauthorized')
    }
  })

  it('issues a session cookie on login and resolves the user', async () => {
    assert.ok(ana.cookie, 'login deve emitir cookie de sessão')
    const me = await ana.request<ApiResponse<{ email: string }>>('GET', '/api/auth/me')
    assert.equal(me.status, 200)
    assert.equal((me.body as { data: { email: string } }).data.email, 'ana@example.com')
  })

  it('rejects an invalid email with a field-level error', async () => {
    const client = createClient(harness.base)
    const response = await client.request('POST', '/api/auth/login', { email: 'nao-e-email' })
    assert.equal(response.status, 400)
    const body = response.body as { error: { code: string; details?: unknown[] } }
    assert.equal(body.error.code, 'invalid_request')
    assert.ok(Array.isArray(body.error.details) && body.error.details.length > 0)
  })

  it('revokes the session on logout', async () => {
    const temporary = await signIn(harness.base, 'temporario@example.com')
    const before = await temporary.request('GET', '/api/investigations')
    assert.equal(before.status, 200)

    const logout = await temporary.request('POST', '/api/auth/logout')
    assert.equal(logout.status, 200)

    const afterLogout = await temporary.request('GET', '/api/investigations')
    assert.equal(afterLogout.status, 401)
  })

  it('rejects a forged session cookie', async () => {
    const forged = createClient(harness.base)
    forged.cookie = 'signalmess_session=forged-token-that-does-not-exist-1234567890'
    const response = await forged.request('GET', '/api/investigations')
    assert.equal(response.status, 401)
  })
})

describe('CSRF and origin protection', () => {
  it('rejects a state-changing request without the CSRF header', async () => {
    const response = await ana.request('POST', '/api/investigations', SAMPLE_INVESTIGATION, { csrf: false })
    assert.equal(response.status, 403)
  })

  it('rejects a cross-origin request', async () => {
    const response = await ana.request('POST', '/api/investigations', SAMPLE_INVESTIGATION, {
      origin: 'https://evil.example.com',
    })
    assert.equal(response.status, 403)
  })
})

describe('cross-user isolation', () => {
  it('hides another user’s investigation', async () => {
    const response = await bruno.request<ApiResponse<unknown>>('GET', `/api/investigations/${anaInvestigationId}`)
    assert.equal(response.status, 404)
    assert.equal((response.body as { error: { code: string } }).error.code, 'not_found')
  })

  it('refuses to let another user update it', async () => {
    const response = await bruno.request('PATCH', `/api/investigations/${anaInvestigationId}`, { title: 'invadido' })
    assert.equal(response.status, 404)

    const check = await ana.request<ApiResponse<{ investigation: Investigation }>>(
      'GET',
      `/api/investigations/${anaInvestigationId}`,
    )
    const detail = (check.body as { data: { investigation: Investigation } }).data.investigation
    assert.equal(detail.title, SAMPLE_INVESTIGATION.title)
  })

  it('refuses to let another user delete it', async () => {
    const response = await bruno.request('DELETE', `/api/investigations/${anaInvestigationId}`)
    assert.equal(response.status, 404)

    const still = await ana.request('GET', `/api/investigations/${anaInvestigationId}`)
    assert.equal(still.status, 200)
  })

  it('refuses to let another user export it', async () => {
    const response = await bruno.request('GET', `/api/investigations/${anaInvestigationId}/export?format=json`)
    assert.equal(response.status, 404)
  })

  it('refuses to let another user research it', async () => {
    const response = await bruno.request('POST', `/api/investigations/${anaInvestigationId}/research`, {})
    assert.equal(response.status, 404)
    assert.equal(harness.mock.exaRequests.length, 0, 'nenhuma chamada ao provedor deve ocorrer')
  })

  it('does not list another user’s investigations', async () => {
    const response = await bruno.request<ApiResponse<{ items: Investigation[]; total: number }>>(
      'GET',
      '/api/investigations',
    )
    assert.equal(response.status, 200)
    assert.equal((response.body as { data: { total: number } }).data.total, 0)
  })

  it('hides another user’s evidence and validation writes', async () => {
    const research = await ana.request<ApiResponse<{ results: Array<{ id: string; url: string; title: string; domain: string }> }>>(
      'POST',
      `/api/investigations/${anaInvestigationId}/research`,
      { numResults: 2 },
    )
    assert.equal(research.status, 200)
    const results = (research.body as { data: { results: Array<{ url: string; title: string; domain: string }> } }).data.results
    const added = await ana.request<ApiResponse<{ added: Array<{ id: string }> }>>(
      'POST',
      `/api/investigations/${anaInvestigationId}/evidence/bulk`,
      {
        sources: results.map((item) => ({ ...item, snippet: 'trecho', contentAvailability: ['text'] })),
      },
    )
    assert.equal(added.status, 201)
    const evidenceId = (added.body as { data: { added: Array<{ id: string }> } }).data.added[0]!.id

    const steal = await bruno.request('GET', `/api/evidence/${evidenceId}/validations`)
    assert.equal(steal.status, 404)

    const decide = await bruno.request('POST', `/api/evidence/${evidenceId}/validation`, {
      status: 'accepted',
      justification: 'tentativa de outro usuário',
    })
    assert.equal(decide.status, 404)
  })
})

describe('validation integrity', () => {
  let evidenceId: string
  let investigationId: string

  before(async () => {
    const created = await ana.request<ApiResponse<Investigation>>('POST', '/api/investigations', {
      ...SAMPLE_INVESTIGATION,
      title: 'Investigação para testes de validação',
    })
    investigationId = (created.body as { data: Investigation }).data.id

    const added = await ana.request<ApiResponse<{ evidence: { id: string } }>>(
      'POST',
      `/api/investigations/${investigationId}/evidence`,
      {
        source: {
          title: 'Fonte para validação',
          url: 'https://example.org/fonte-validacao',
          domain: 'example.org',
          snippet: 'Trecho de teste',
          retrievedContent: null,
          publishedAt: null,
          author: null,
          providerRequestId: null,
          contentAvailability: ['snippet'],
        },
      },
    )
    assert.equal(added.status, 201)
    evidenceId = (added.body as { data: { evidence: { id: string } } }).data.evidence.id
  })

  it('requires a justification to reject', async () => {
    const response = await ana.request('POST', `/api/evidence/${evidenceId}/validation`, {
      status: 'rejected',
      justification: '',
    })
    assert.equal(response.status, 400)
  })

  it('requires a justification to request review', async () => {
    const response = await ana.request('POST', `/api/evidence/${evidenceId}/validation`, {
      status: 'needs_review',
      justification: '   ',
    })
    assert.equal(response.status, 400)
  })

  it('accepts approval without a justification', async () => {
    const response = await ana.request<ApiResponse<{ validation: Validation }>>(
      'POST',
      `/api/evidence/${evidenceId}/validation`,
      { status: 'accepted' },
    )
    assert.equal(response.status, 201)
    assert.equal((response.body as { data: { validation: Validation } }).data.validation.status, 'accepted')
  })

  it('keeps every decision in the history instead of overwriting', async () => {
    await ana.request('POST', `/api/evidence/${evidenceId}/validation`, {
      status: 'needs_review',
      justification: 'Confirmar metodologia',
    })
    await ana.request('POST', `/api/evidence/${evidenceId}/validation`, {
      status: 'rejected',
      justification: 'Metodologia não descrita',
    })

    const history = await ana.request<ApiResponse<Validation[]>>('GET', `/api/evidence/${evidenceId}/validations`)
    const items = (history.body as { data: Validation[] }).data
    assert.equal(items.length, 3, 'três decisões registradas')
    assert.equal(items[0]!.status, 'rejected')
    assert.equal(items[0]!.previousStatus, 'needs_review')
    assert.equal(items[2]!.status, 'accepted')
  })

  it('rejects repeating the same status', async () => {
    const response = await ana.request('POST', `/api/evidence/${evidenceId}/validation`, {
      status: 'rejected',
      justification: 'repetição',
    })
    assert.equal(response.status, 400)
  })
})
