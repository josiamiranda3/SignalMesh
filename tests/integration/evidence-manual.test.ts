import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SAMPLE_INVESTIGATION, signIn, startHarness, type Client, type Harness } from './harness.ts'
import type { ApiResponse, InvestigationDetail } from '../../shared/api.ts'
import type { Evidence, Investigation } from '../../shared/domain.ts'

/**
 * Manual evidence entry and provenance (v0.2.4.2).
 *
 * The manual path is `POST /api/investigations/:id/evidence`, which the UI now
 * exposes. These tests exercise it over real HTTP against SQLite — the same
 * assembly the browser talks to — and assert the property that was wrong before:
 * a hand-entered source is labelled `manual`, not `exa`.
 *
 * What is *not* covered here: the React dialog itself. Its behaviour is checked
 * by the browser suite (`run-e2e.ts`); these tests cover the contract the dialog
 * depends on.
 */

let harness: Harness
const clients: Record<string, Client> = {}

before(async () => {
  harness = await startHarness({
    RESEARCH_DAILY_LIMIT: '100',
    ANALYSIS_DAILY_LIMIT: '100',
    RESEARCH_GLOBAL_DAILY_LIMIT: '1000',
    ANALYSIS_GLOBAL_DAILY_LIMIT: '1000',
    DUPLICATE_GUARD_SECONDS: '0',
  })
  clients['ana'] = await signIn(harness.base, 'ana-evidence@example.com', 'Ana')
  clients['bruno'] = await signIn(harness.base, 'bruno-evidence@example.com', 'Bruno')
})

after(async () => {
  await harness.close()
})

/** Create an investigation owned by the given client. */
async function createInvestigation(who: string, title: string): Promise<Investigation> {
  const response = await clients[who]!.request<ApiResponse<Investigation>>(
    'POST',
    '/api/investigations',
    { ...SAMPLE_INVESTIGATION, title },
  )
  assert.equal(response.status, 201, `criação falhou: ${JSON.stringify(response.body)}`)
  return (response.body as { data: Investigation }).data
}

function manualPayload(overrides: Record<string, unknown> = {}) {
  return {
    source: {
      title: 'Relatório manual de teste',
      url: 'https://example.org/relatorio-manual',
      snippet: 'Trecho digitado pelo pesquisador.',
      ...overrides,
    },
    allowDuplicate: false,
  }
}

describe('manual evidence: valid entry', () => {
  it('creates the row and returns it with the typed fields', async () => {
    const investigation = await createInvestigation('ana', 'Manual válido')
    const response = await clients['ana']!.request<{
      data: { evidence: Evidence; duplicate?: boolean }
    }>('POST', `/api/investigations/${investigation.id}/evidence`, manualPayload())

    assert.equal(response.status, 201)
    const evidence = (response.body as { data: { evidence: Evidence } }).data.evidence
    assert.equal(evidence.title, 'Relatório manual de teste')
    assert.equal(evidence.url, 'https://example.org/relatorio-manual')
    assert.equal(evidence.investigationId, investigation.id)
    assert.equal(evidence.validationStatus, 'pending')
  })

  it('accepts the optional fields, including an ISO publication date', async () => {
    const investigation = await createInvestigation('ana', 'Manual com opcionais')
    const response = await clients['ana']!.request<{ data: { evidence: Evidence } }>(
      'POST',
      `/api/investigations/${investigation.id}/evidence`,
      manualPayload({
        title: 'Com autor e data',
        url: 'https://example.org/com-autor',
        author: 'Instituto de Pesquisa',
        publishedAt: '2024-03-15T00:00:00.000Z',
      }),
    )

    assert.equal(response.status, 201)
    const evidence = (response.body as { data: { evidence: Evidence } }).data.evidence
    assert.equal(evidence.author, 'Instituto de Pesquisa')
    assert.equal(evidence.publishedAt, '2024-03-15T00:00:00.000Z')
  })

  it('derives the domain from the URL when it is not supplied', async () => {
    const investigation = await createInvestigation('ana', 'Domínio derivado')
    const response = await clients['ana']!.request<{ data: { evidence: Evidence } }>(
      'POST',
      `/api/investigations/${investigation.id}/evidence`,
      manualPayload({ title: 'Domínio', url: 'https://portal.exemplo.gov.br/nota' }),
    )
    const evidence = (response.body as { data: { evidence: Evidence } }).data.evidence
    assert.equal(evidence.domain, 'portal.exemplo.gov.br')
  })
})

describe('manual evidence: required fields', () => {
  it('rejects a missing title', async () => {
    const investigation = await createInvestigation('ana', 'Sem título')
    const response = await clients['ana']!.request('POST', `/api/investigations/${investigation.id}/evidence`, {
      source: { url: 'https://example.org/sem-titulo' },
      allowDuplicate: false,
    })
    assert.equal(response.status, 400)
    assert.match(JSON.stringify(response.body), /Título/i)
  })

  it('rejects an empty title', async () => {
    const investigation = await createInvestigation('ana', 'Título vazio')
    const response = await clients['ana']!.request(
      'POST',
      `/api/investigations/${investigation.id}/evidence`,
      manualPayload({ title: '   ' }),
    )
    assert.equal(response.status, 400)
  })

  it('rejects a missing url', async () => {
    const investigation = await createInvestigation('ana', 'Sem URL')
    const response = await clients['ana']!.request('POST', `/api/investigations/${investigation.id}/evidence`, {
      source: { title: 'Só título' },
      allowDuplicate: false,
    })
    assert.equal(response.status, 400)
    assert.match(JSON.stringify(response.body), /URL/i)
  })

  it('rejects a title beyond the length limit', async () => {
    const investigation = await createInvestigation('ana', 'Título longo')
    const response = await clients['ana']!.request(
      'POST',
      `/api/investigations/${investigation.id}/evidence`,
      manualPayload({ title: 'x'.repeat(401) }),
    )
    assert.equal(response.status, 400)
  })
})

describe('manual evidence: invalid URL', () => {
  it('rejects a javascript: URL', async () => {
    const investigation = await createInvestigation('ana', 'URL javascript')
    const response = await clients['ana']!.request(
      'POST',
      `/api/investigations/${investigation.id}/evidence`,
      manualPayload({ url: 'javascript:alert(1)' }),
    )
    assert.equal(response.status, 400)
  })

  it('rejects a data: URL', async () => {
    const investigation = await createInvestigation('ana', 'URL data')
    const response = await clients['ana']!.request(
      'POST',
      `/api/investigations/${investigation.id}/evidence`,
      manualPayload({ url: 'data:text/html,<h1>x</h1>' }),
    )
    assert.equal(response.status, 400)
  })

  it('rejects a relative or malformed URL', async () => {
    const investigation = await createInvestigation('ana', 'URL relativa')
    for (const url of ['/apenas-um-caminho', 'nao-e-url', 'ftp://example.org/arquivo']) {
      const response = await clients['ana']!.request(
        'POST',
        `/api/investigations/${investigation.id}/evidence`,
        manualPayload({ url }),
      )
      assert.equal(response.status, 400, `${url} deveria ser recusada`)
    }
  })
})

describe('manual evidence: provenance', () => {
  it('labels a manual row as "manual", never "exa"', async () => {
    const investigation = await createInvestigation('ana', 'Procedência manual')
    const response = await clients['ana']!.request<{ data: { evidence: Evidence } }>(
      'POST',
      `/api/investigations/${investigation.id}/evidence`,
      manualPayload({ title: 'Procedência', url: 'https://example.org/procedencia' }),
    )
    const evidence = (response.body as { data: { evidence: Evidence } }).data.evidence
    assert.equal(evidence.source, 'manual', 'evidência manual não pode ser rotulada como exa')
  })

  it('records the origin in sourceMetadata', async () => {
    const investigation = await createInvestigation('ana', 'Metadados de origem')
    const response = await clients['ana']!.request<{ data: { evidence: Evidence } }>(
      'POST',
      `/api/investigations/${investigation.id}/evidence`,
      manualPayload({ title: 'Metadados', url: 'https://example.org/metadados' }),
    )
    const evidence = (response.body as { data: { evidence: Evidence } }).data.evidence
    assert.equal(evidence.sourceMetadata['origin'], 'manual')
  })

  it('preserves "exa" on the bulk (research) path', async () => {
    // `addMany` is only reachable from the research screen; its rows must keep
    // the provider label. This is the regression guard: fixing the manual path
    // must not relabel researched rows.
    const investigation = await createInvestigation('ana', 'Procedência exa')
    const response = await clients['ana']!.request<{ data: { added: Evidence[] } }>(
      'POST',
      `/api/investigations/${investigation.id}/evidence/bulk`,
      {
        sources: [
          {
            title: 'Resultado de pesquisa',
            url: 'https://example.org/resultado-pesquisa',
            snippet: 'vindo do provedor',
            providerRequestId: 'req_test_1',
          },
        ],
        allowDuplicates: false,
      },
    )
    assert.equal(response.status, 201)
    const added = (response.body as { data: { added: Evidence[] } }).data.added
    assert.equal(added.length, 1)
    assert.equal(added[0]!.source, 'exa')
    assert.equal(added[0]!.sourceMetadata['origin'], 'exa')
  })

  it('keeps both origins distinguishable in the same investigation', async () => {
    const investigation = await createInvestigation('ana', 'Dois origens')
    await clients['ana']!.request(
      'POST',
      `/api/investigations/${investigation.id}/evidence`,
      manualPayload({ title: 'Manual aqui', url: 'https://example.org/dois-manual' }),
    )
    await clients['ana']!.request('POST', `/api/investigations/${investigation.id}/evidence/bulk`, {
      sources: [{ title: 'Pesquisado aqui', url: 'https://example.org/dois-pesquisa' }],
      allowDuplicates: false,
    })

    const detail = await clients['ana']!.request<ApiResponse<InvestigationDetail>>(
      'GET',
      `/api/investigations/${investigation.id}`,
    )
    const evidence = (detail.body as { data: InvestigationDetail }).data.evidence
    const byTitle = Object.fromEntries(evidence.map((item) => [item.title, item.source]))
    assert.equal(byTitle['Manual aqui'], 'manual')
    assert.equal(byTitle['Pesquisado aqui'], 'exa')
  })
})

describe('manual evidence: persistence in SQLite', () => {
  it('survives a fresh read through the API', async () => {
    const investigation = await createInvestigation('ana', 'Persistência')
    await clients['ana']!.request(
      'POST',
      `/api/investigations/${investigation.id}/evidence`,
      manualPayload({ title: 'Persistida', url: 'https://example.org/persistida' }),
    )

    // A second request re-reads from the database, not from memory.
    const detail = await clients['ana']!.request<ApiResponse<InvestigationDetail>>(
      'GET',
      `/api/investigations/${investigation.id}`,
    )
    const evidence = (detail.body as { data: InvestigationDetail }).data.evidence
    assert.equal(evidence.length, 1)
    assert.equal(evidence[0]!.title, 'Persistida')
    assert.equal(evidence[0]!.source, 'manual')
  })

  it('reports the row in the dashboard counters', async () => {
    const investigation = await createInvestigation('ana', 'Contadores')
    await clients['ana']!.request(
      'POST',
      `/api/investigations/${investigation.id}/evidence`,
      manualPayload({ title: 'Contada', url: 'https://example.org/contada' }),
    )
    const dashboard = await clients['ana']!.request<{
      data: { evidence: { total: number } }
    }>('GET', '/api/dashboard')
    assert.ok((dashboard.body as { data: { evidence: { total: number } } }).data.evidence.total >= 1)
  })
})

describe('manual evidence: cross-user isolation', () => {
  it('refuses to add evidence to another user\'s investigation', async () => {
    const investigation = await createInvestigation('ana', 'Isolamento A')
    const response = await clients['bruno']!.request(
      'POST',
      `/api/investigations/${investigation.id}/evidence`,
      manualPayload({ title: 'Invasão', url: 'https://example.org/invasao' }),
    )
    assert.ok(
      response.status === 404 || response.status === 403,
      `Bruno não pode escrever na investigação de Ana (respondeu ${response.status})`,
    )
  })

  it('does not let a third user see the created row', async () => {
    const investigation = await createInvestigation('ana', 'Isolamento leitura')
    await clients['ana']!.request(
      'POST',
      `/api/investigations/${investigation.id}/evidence`,
      manualPayload({ title: 'Privada', url: 'https://example.org/privada' }),
    )

    const detail = await clients['bruno']!.request('GET', `/api/investigations/${investigation.id}`)
    assert.ok(detail.status === 404 || detail.status === 403)
  })

  it('requires authentication', async () => {
    const investigation = await createInvestigation('ana', 'Isolamento anônimo')
    const anonymous = await fetch(`${harness.base}/api/investigations/${investigation.id}/evidence`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signalmess-request': '1', connection: 'close' },
      body: JSON.stringify(manualPayload()),
    })
    assert.equal(anonymous.status, 401)
  })
})

describe('manual evidence: duplicates', () => {
  it('reports the existing row instead of creating a second one', async () => {
    const investigation = await createInvestigation('ana', 'Duplicata')
    const payload = manualPayload({ title: 'Duplicada', url: 'https://example.org/duplicada' })

    const first = await clients['ana']!.request<{ data: { evidence: Evidence; duplicate: boolean } }>(
      'POST',
      `/api/investigations/${investigation.id}/evidence`,
      payload,
    )
    assert.equal(first.status, 201)
    assert.equal((first.body as { data: { duplicate: boolean } }).data.duplicate, false)

    const second = await clients['ana']!.request<{ data: { evidence: Evidence; duplicate: boolean } }>(
      'POST',
      `/api/investigations/${investigation.id}/evidence`,
      payload,
    )
    assert.equal(second.status, 200)
    const body = (second.body as { data: { evidence: Evidence; duplicate: boolean } }).data
    assert.equal(body.duplicate, true)
    assert.equal(body.evidence.title, 'Duplicada')
  })

  it('detects duplicates across tracking-parameter variants', async () => {
    const investigation = await createInvestigation('ana', 'Duplicata com utm')
    await clients['ana']!.request(
      'POST',
      `/api/investigations/${investigation.id}/evidence`,
      manualPayload({ title: 'Original', url: 'https://example.org/tracked' }),
    )
    const variant = await clients['ana']!.request<{ data: { duplicate: boolean } }>(
      'POST',
      `/api/investigations/${investigation.id}/evidence`,
      manualPayload({ title: 'Variante', url: 'https://example.org/tracked?utm_source=newsletter' }),
    )
    assert.equal((variant.body as { data: { duplicate: boolean } }).data.duplicate, true)
  })
})

describe('manual evidence: export preserves provenance', () => {
  it('emits "manual" in the JSON export', async () => {
    const investigation = await createInvestigation('ana', 'Export JSON')
    await clients['ana']!.request(
      'POST',
      `/api/investigations/${investigation.id}/evidence`,
      manualPayload({ title: 'Exportada JSON', url: 'https://example.org/export-json' }),
    )

    const response = await clients['ana']!.request<string>(
      'GET',
      `/api/investigations/${investigation.id}/export?format=json`,
      undefined,
      { rawText: true },
    )
    const parsed = JSON.parse(response.body) as { evidence: Array<{ title: string; source: string }> }
    const row = parsed.evidence.find((item) => item.title === 'Exportada JSON')
    assert.ok(row, 'a evidência deveria estar na exportação')
    assert.equal(row!.source, 'manual')
  })

  it('emits "manual" in the CSV export', async () => {
    const investigation = await createInvestigation('ana', 'Export CSV')
    await clients['ana']!.request(
      'POST',
      `/api/investigations/${investigation.id}/evidence`,
      manualPayload({ title: 'Exportada CSV', url: 'https://example.org/export-csv' }),
    )

    const response = await clients['ana']!.request<string>(
      'GET',
      `/api/investigations/${investigation.id}/export?format=csv`,
      undefined,
      { rawText: true },
    )
    const lines = response.body.split(/\r?\n/)
    const headerIndex = lines.findIndex((line) => line.includes('source'))
    assert.ok(headerIndex >= 0, 'o CSV deveria ter uma coluna source')
    const csvRow = lines.find((line) => line.includes('Exportada CSV'))
    assert.ok(csvRow, 'a evidência deveria estar no CSV')
    assert.match(csvRow!, /manual/)
  })
})
