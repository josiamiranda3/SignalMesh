import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SAMPLE_INVESTIGATION, signIn, startHarness, type Client, type Harness } from './harness.ts'
import type { ApiResponse, InvestigationDetail } from '../../shared/api.ts'
import type { ActivityLogEntry, Evidence, Investigation } from '../../shared/domain.ts'

/**
 * CRUD, history and export — the surfaces that make the investigation
 * reconstructable. Export tests parse the emitted CSV/JSON rather than matching
 * strings, so a malformed quote or a dropped relation fails the test.
 */

let harness: Harness
let client: Client

before(async () => {
  // This suite exercises CRUD, history and export, not the quotas — which have
  // their own dedicated tests. Raise the ceilings so setup does not run out of
  // daily allowance halfway through the run.
  harness = await startHarness({
    RESEARCH_DAILY_LIMIT: '100',
    ANALYSIS_DAILY_LIMIT: '100',
    RESEARCH_GLOBAL_DAILY_LIMIT: '1000',
    ANALYSIS_GLOBAL_DAILY_LIMIT: '1000',
    DUPLICATE_GUARD_SECONDS: '0',
    // This suite performs simulated research and analysis, which since v0.2.4.3
    // require both cost switches. The providers are the local mock.
    ENABLE_PAID_OPERATIONS: 'true',
  })
  client = await signIn(harness.base, 'crud@example.com', 'CRUD')
})

after(async () => {
  await harness.close()
})

async function createInvestigation(title = 'Investigação de teste'): Promise<Investigation> {
  const response = await client.request<ApiResponse<Investigation>>('POST', '/api/investigations', {
    ...SAMPLE_INVESTIGATION,
    title,
  })
  assert.equal(response.status, 201)
  return (response.body as { data: Investigation }).data
}

describe('investigation CRUD', () => {
  it('creates, reads, updates and archives', async () => {
    const created = await createInvestigation('Ciclo de vida')
    assert.equal(created.status, 'active')
    assert.equal(created.keywords.length, 2)

    const read = await client.request<ApiResponse<InvestigationDetail>>('GET', `/api/investigations/${created.id}`)
    assert.equal(read.status, 200)
    assert.equal((read.body as { data: InvestigationDetail }).data.investigation.title, 'Ciclo de vida')

    const updated = await client.request<ApiResponse<Investigation>>('PATCH', `/api/investigations/${created.id}`, {
      title: 'Ciclo de vida (editado)',
      objective: 'Objetivo revisado com mais detalhe sobre o escopo da investigação.',
    })
    assert.equal(updated.status, 200)
    assert.equal((updated.body as { data: Investigation }).data.title, 'Ciclo de vida (editado)')

    const archived = await client.request<ApiResponse<Investigation>>('POST', `/api/investigations/${created.id}/archive`)
    assert.equal(archived.status, 200)
    assert.equal((archived.body as { data: Investigation }).data.status, 'archived')
  })

  it('rejects an investigation without an objective', async () => {
    const response = await client.request<ApiResponse<never>>('POST', '/api/investigations', {
      title: 'Sem objetivo',
      topic: 'teste',
    })
    assert.equal(response.status, 400)
    const details = (response.body as { error: { details: Array<{ path: string }> } }).error.details
    assert.ok(details.some((detail) => detail.path === 'objective'))
  })

  it('deletes an investigation and cascades its dependent rows', async () => {
    const created = await createInvestigation('Para excluir')
    await client.request('DELETE', `/api/investigations/${created.id}`)

    const after = await client.request('GET', `/api/investigations/${created.id}`)
    assert.equal(after.status, 404)

    const detail = await client.request<ApiResponse<{ items: Investigation[] }>>('GET', '/api/investigations')
    assert.ok(!(detail.body as { data: { items: Investigation[] } }).data.items.some((item) => item.id === created.id))
  })

  it('filters by status and searches by title, topic and objective', async () => {
    const draft = await createInvestigation('Busca: rascunho sobre energia solar')
    await client.request('PATCH', `/api/investigations/${draft.id}`, { status: 'draft' })

    const byStatus = await client.request<ApiResponse<{ items: Investigation[]; total: number }>>(
      'GET',
      '/api/investigations?status=draft',
    )
    const statusItems = (byStatus.body as { data: { items: Investigation[] } }).data.items
    assert.ok(statusItems.length >= 1)
    assert.ok(statusItems.every((item) => item.status === 'draft'))

    const bySearch = await client.request<ApiResponse<{ items: Investigation[] }>>(
      'GET',
      '/api/investigations?search=energia%20solar',
    )
    const searchItems = (bySearch.body as { data: { items: Investigation[] } }).data.items
    assert.equal(searchItems.length, 1)
    assert.equal(searchItems[0]!.id, draft.id)
  })

  it('sorts by title ascending on request', async () => {
    const response = await client.request<ApiResponse<{ items: Investigation[] }>>(
      'GET',
      '/api/investigations?sort=title&direction=asc&limit=100',
    )
    const titles = (response.body as { data: { items: Investigation[] } }).data.items.map((item) => item.title)
    const sorted = [...titles].sort((a, b) => a.localeCompare(b))
    assert.deepEqual(titles, sorted)
  })

  it('rejects an invalid list parameter instead of silently ignoring it', async () => {
    const response = await client.request<ApiResponse<never>>('GET', '/api/investigations?status=inexistente')
    assert.equal(response.status, 400)
  })
})

describe('dashboard aggregation', () => {
  it('reflects persisted data, never placeholders', async () => {
    const investigation = await createInvestigation('Métricas reais')
    const research = await client.request<ApiResponse<{ results: Array<Record<string, string>> }>>(
      'POST',
      `/api/investigations/${investigation.id}/research`,
      { numResults: 3 },
    )
    const results = (research.body as { data: { results: Array<Record<string, string>> } }).data.results
    await client.request('POST', `/api/investigations/${investigation.id}/evidence/bulk`, {
      sources: results.map((item) => ({
        title: item['title'],
        url: item['url'],
        domain: item['domain'],
        snippet: '',
        retrievedContent: item['retrievedContent'] ?? null,
        publishedAt: item['publishedAt'] ?? null,
        author: null,
        providerRequestId: null,
        contentAvailability: ['text'],
      })),
    })

    const dashboard = await client.request<
      ApiResponse<{
        investigations: { total: number; byStatus: Record<string, number> }
        evidence: { total: number; byStatus: Record<string, number> }
        evidenceTrend: Array<{ date: string; count: number }>
        investigationTrend: Array<{ date: string; count: number }>
      }>
    >('GET', '/api/dashboard')

    const data = (dashboard.body as {
      data: {
        investigations: { total: number }
        evidence: { total: number; byStatus: Record<string, number> }
        evidenceTrend: Array<{ date: string; count: number }>
        investigationTrend: Array<{ date: string; count: number }>
      }
    }).data

    assert.ok(data.investigations.total >= 1)
    assert.ok(data.evidence.total >= 3)
    assert.equal(
      Object.values(data.evidence.byStatus).reduce((sum, value) => sum + value, 0),
      data.evidence.total,
    )
    assert.equal(data.evidenceTrend.length, 30, 'série deve cobrir 30 dias, com zeros')
    assert.equal(data.investigationTrend.length, 30)
    assert.equal(data.investigationTrend.reduce((sum, point) => sum + point.count, 0), data.investigations.total)
  })
})

describe('activity history', () => {
  it('records the full lifecycle of an investigation', async () => {
    const investigation = await createInvestigation('Trilha completa')
    await client.request('PATCH', `/api/investigations/${investigation.id}`, { title: 'Trilha completa (v2)' })
    await client.request('POST', `/api/investigations/${investigation.id}/research`, { numResults: 2 })

    const history = await client.request<ApiResponse<ActivityLogEntry[]>>(
      'GET',
      `/api/investigations/${investigation.id}/history`,
    )
    const events = (history.body as { data: ActivityLogEntry[] }).data
    const types = events.map((entry) => entry.eventType)
    assert.ok(types.includes('investigation.created'))
    assert.ok(types.includes('investigation.updated'))
    assert.ok(types.includes('research.executed'))
  })

  it('is persisted, not browser state: a fresh session sees the same trail', async () => {
    const investigation = await createInvestigation('Trilha persistente')
    const second = await signIn(harness.base, 'crud@example.com')
    const history = await second.request<ApiResponse<ActivityLogEntry[]>>(
      'GET',
      `/api/investigations/${investigation.id}/history`,
    )
    assert.equal(history.status, 200)
    assert.ok((history.body as { data: ActivityLogEntry[] }).data.length > 0)
  })

  it('exposes a global feed with totals', async () => {
    const response = await client.request<ApiResponse<{ items: ActivityLogEntry[]; total: number }>>(
      'GET',
      '/api/history?limit=10',
    )
    const data = (response.body as { data: { items: ActivityLogEntry[]; total: number } }).data
    assert.ok(data.total >= data.items.length)
    assert.ok(data.items.length <= 10)
  })
})

describe('export', () => {
  async function buildInvestigationWithEverything(): Promise<string> {
    const investigation = await createInvestigation('Exportação completa')
    const research = await client.request<ApiResponse<{ results: Array<Record<string, string>> }>>(
      'POST',
      `/api/investigations/${investigation.id}/research`,
      { numResults: 3 },
    )
    const results = (research.body as { data: { results: Array<Record<string, string>> } }).data.results
    await client.request('POST', `/api/investigations/${investigation.id}/evidence/bulk`, {
      sources: results.map((item) => ({
        title: item['title'],
        url: item['url'],
        domain: item['domain'],
        snippet: item['snippet'] ?? '',
        retrievedContent: item['retrievedContent'] ?? null,
        publishedAt: item['publishedAt'] ?? null,
        author: item['author'] ?? null,
        providerRequestId: null,
        contentAvailability: ['text'],
      })),
    })
    const evidence = await client.request<ApiResponse<Evidence[]>>('GET', `/api/investigations/${investigation.id}/evidence`)
    const first = (evidence.body as { data: Evidence[] }).data[0]!
    await client.request('POST', `/api/evidence/${first.id}/validation`, {
      status: 'accepted',
      justification: 'Metodologia adequada ao objetivo.',
    })
    await client.request('POST', `/api/investigations/${investigation.id}/analyses`, {})
    return investigation.id
  }

  it('emits a JSON bundle with every relationship intact', async () => {
    const id = await buildInvestigationWithEverything()
    const response = await client.request<string>('GET', `/api/investigations/${id}/export?format=json&scope=investigation`, undefined, { rawText: true })
    assert.equal(response.status, 200)

    const bundle = JSON.parse(response.body as string) as {
      meta: { generator: string; investigationId: string }
      investigation: { id: string }
      evidence: Array<{ id: string; investigationId: string; relevanceScore: number | null }>
      analyses: Array<{ id: string; evidenceIds: string[]; references: Array<{ evidenceId: string }> }>
      validations: Array<{ evidenceId: string; status: string; justification: string }>
      activity: Array<{ eventType: string }>
    }

    assert.equal(bundle.meta.generator, 'SIGNALMESH')
    assert.equal(bundle.meta.investigationId, id)
    assert.equal(bundle.investigation.id, id)
    assert.equal(bundle.evidence.length, 3)
    assert.ok(bundle.evidence.every((item) => item.investigationId === id))
    assert.equal(bundle.validations.length, 1)
    assert.equal(bundle.validations[0]!.status, 'accepted')
    assert.equal(bundle.analyses.length, 1)

    // Relationships must resolve: every reference points at an exported row.
    const exportedIds = new Set(bundle.evidence.map((item) => item.id))
    for (const reference of bundle.analyses[0]!.references) {
      assert.ok(exportedIds.has(reference.evidenceId), 'referência deve existir no pacote')
    }
    assert.ok(bundle.activity.length > 0)
  })

  it('respects the requested scope', async () => {
    const id = await buildInvestigationWithEverything()
    const response = await client.request<string>('GET', `/api/investigations/${id}/export?format=json&scope=evidence`, undefined, { rawText: true })
    const bundle = JSON.parse(response.body as string) as Record<string, unknown>
    assert.ok(Array.isArray(bundle['evidence']))
    assert.equal(bundle['analyses'], undefined)
    assert.equal(bundle['validations'], undefined)
  })

  it('emits parseable CSV with escaped values', async () => {
    const id = await buildInvestigationWithEverything()
    const response = await client.request<string>('GET', `/api/investigations/${id}/export?format=csv&scope=investigation`, undefined, { rawText: true })
    assert.equal(response.status, 200)
    assert.ok((response.headers.get('content-type') ?? '').includes('text/csv'))

    const text = (response.body as string).replace(/^\uFEFF/, '')
    const rows = parseCsv(text)
    assert.ok(rows.length >= 5, `CSV inesperadamente curto: ${rows.length}`)
    assert.equal(rows[0]![0], 'record_type')

    const types = new Set(rows.slice(1).map((row) => row[0]))
    assert.ok(types.has('evidence'))
    assert.ok(types.has('validation'))
    assert.ok(types.has('analysis'))
    assert.ok(types.has('activity'))

    // Every row must have the same column count as the header.
    for (const row of rows) assert.equal(row.length, rows[0]!.length)
  })

  it('uses a comprehensible filename and forbids caching', async () => {
    const id = await buildInvestigationWithEverything()
    const response = await client.request('GET', `/api/investigations/${id}/export?format=json`)
    const disposition = response.headers.get('content-disposition') ?? ''
    assert.ok(disposition.includes('signalmess-exportacao-completa-investigation-'))
    assert.ok(disposition.includes('.json'))
    assert.equal(response.headers.get('cache-control'), 'no-store')
  })

  it('never includes credentials or session material', async () => {
    const id = await buildInvestigationWithEverything()
    const json = await client.request<string>('GET', `/api/investigations/${id}/export?format=json`, undefined, { rawText: true })
    const csv = await client.request<string>('GET', `/api/investigations/${id}/export?format=csv`, undefined, { rawText: true })
    for (const body of [json.body as string, csv.body as string]) {
      assert.ok(!/signalmess_session/i.test(body))
      assert.ok(!/api[_-]?key/i.test(body))
      assert.ok(!/test-exa-key|test-gemini-key/i.test(body))
      assert.ok(!/password/i.test(body))
    }
  })

  it('records the export in the activity trail', async () => {
    const id = await buildInvestigationWithEverything()
    await client.request('GET', `/api/investigations/${id}/export?format=csv&scope=evidence`)
    const history = await client.request<ApiResponse<ActivityLogEntry[]>>('GET', `/api/investigations/${id}/history`)
    const events = (history.body as { data: ActivityLogEntry[] }).data
    assert.ok(events.some((entry) => entry.eventType === 'export.generated'))
  })
})

describe('settings', () => {
  it('reports provider state without ever exposing key material', async () => {
    const response = await client.request<ApiResponse<{ providers: { exa: { configured: boolean }; gemini: { configured: boolean } } }>>('GET', '/api/settings')
    assert.equal(response.status, 200)
    const body = JSON.stringify(response.body)
    assert.ok(!body.includes('test-exa-key'))
    assert.ok(!body.includes('test-gemini-key'))

    const data = (response.body as { data: { providers: { exa: { configured: boolean }; gemini: { configured: boolean } } } }).data
    assert.equal(data.providers.exa.configured, true)
    assert.equal(data.providers.gemini.configured, true)
  })
})

/** RFC 4180 parser sufficient to verify our own output. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          inQuotes = false
        }
      } else {
        field += char
      }
      continue
    }
    if (char === '"') {
      inQuotes = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\r') {
      continue
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((entry) => entry.length > 1 || (entry[0] ?? '').length > 0)
}
