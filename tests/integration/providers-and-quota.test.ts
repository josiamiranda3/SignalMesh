import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SAMPLE_INVESTIGATION, signIn, startHarness, type Client, type Harness } from './harness.ts'
import type { ApiResponse } from '../../shared/api.ts'
import type { Analysis, Evidence, Investigation, UsageQuotaSnapshot } from '../../shared/domain.ts'

/**
 * Provider integration and cost protection.
 *
 * Every documented failure mode of Exa and Gemini is exercised through the real
 * HTTP client, and the quota guards are verified to hold in the backend. Nothing
 * here performs a billed call: the providers are a local mock that speaks the
 * documented wire format.
 */

let harness: Harness
let client: Client
let investigationId: string

/**
 * Boot the harness for one case.
 *
 * `ENABLE_PAID_OPERATIONS=true` is the default here because every case in this
 * file exercises a provider call, and since v0.2.4.3 a paid operation needs both
 * switches on. The cases that assert the gate itself pass `'false'` explicitly.
 */
async function boot(overrides: Record<string, string> = {}): Promise<void> {
  harness = await startHarness({ ENABLE_PAID_OPERATIONS: 'true', ...overrides })
  client = await signIn(harness.base, `user-${Math.random().toString(36).slice(2)}@example.com`)
  const created = await client.request<ApiResponse<Investigation>>('POST', '/api/investigations', SAMPLE_INVESTIGATION)
  investigationId = (created.body as { data: Investigation }).data.id
}

afterEach(async () => {
  if (harness) await harness.close()
})

describe('Exa research', () => {
  it('builds a query from the investigation topic, keywords and objective', async () => {
    await boot()
    await client.request('POST', `/api/investigations/${investigationId}/research`, { numResults: 3 })

    assert.equal(harness.mock.exaRequests.length, 1)
    const request = harness.mock.exaRequests[0]!
    const query = String(request.query)
    assert.ok(query.includes('fraudes financeiras'), `consulta inesperada: ${query}`)
    assert.ok(query.includes('machine learning'))
    assert.equal(request.numResults, 3)
    // Content options are requested using the documented shape.
    const contents = request.contents as Record<string, unknown>
    assert.ok(contents && typeof contents === 'object')
    assert.ok('text' in contents)
    assert.ok('highlights' in contents)
  })

  it('returns provider results with provenance and content availability', async () => {
    await boot()
    const response = await client.request<ApiResponse<{ results: Array<Record<string, unknown>>; contentNotice: string }>>(
      'POST',
      `/api/investigations/${investigationId}/research`,
      { numResults: 5 },
    )
    assert.equal(response.status, 200)
    const data = (response.body as { data: { results: Array<Record<string, unknown>>; contentNotice: string } }).data
    assert.equal(data.results.length, 3)

    const withText = data.results.find((item) => item['url'] === 'https://example.org/estudo-antifraude')!
    assert.deepEqual(withText['contentAvailability'], ['text', 'highlights', 'summary'])
    assert.equal(withText['domain'], 'example.org')
    assert.ok(withText['retrievedContent'])

    const onlyHighlights = data.results.find((item) => item['url'] === 'https://example.org/regulacao')!
    assert.deepEqual(onlyHighlights['contentAvailability'], ['highlights'])
    assert.equal(onlyHighlights['retrievedContent'], null)
    assert.equal(onlyHighlights['author'], null)

    // The notice must be honest about partial content.
    assert.ok(data.contentNotice.includes('Conteúdo integral para 1 de 3'))
  })

  it('reports an empty result set without inventing data', async () => {
    await boot()
    harness.mock.exaMode = 'empty'
    const response = await client.request<ApiResponse<{ results: unknown[]; contentNotice: string }>>(
      'POST',
      `/api/investigations/${investigationId}/research`,
      {},
    )
    assert.equal(response.status, 200)
    const data = (response.body as { data: { results: unknown[]; contentNotice: string } }).data
    assert.deepEqual(data.results, [])
    assert.ok(data.contentNotice.includes('não retornou resultados'))
  })

  it('maps a 401 from the provider to a clear auth failure and does not retry', async () => {
    await boot()
    harness.mock.exaMode = 'unauthorized'
    const response = await client.request<ApiResponse<never>>('POST', `/api/investigations/${investigationId}/research`, {})
    assert.equal(response.status, 502)
    const body = response.body as { error: { code: string; provider?: string } }
    assert.equal(body.error.code, 'provider_auth_failed')
    assert.equal(body.error.provider, 'exa')
    assert.equal(harness.mock.exaRequests.length, 1, 'não deve repetir automaticamente')
  })

  it('maps a 429 from the provider to provider_rate_limited', async () => {
    await boot()
    harness.mock.exaMode = 'rate-limit'
    const response = await client.request<ApiResponse<never>>('POST', `/api/investigations/${investigationId}/research`, {})
    assert.equal(response.status, 429)
    assert.equal((response.body as { error: { code: string } }).error.code, 'provider_rate_limited')
    assert.equal(harness.mock.exaRequests.length, 1)
  })

  it('maps a 500 to provider_unavailable', async () => {
    await boot()
    harness.mock.exaMode = 'server-error'
    const response = await client.request<ApiResponse<never>>('POST', `/api/investigations/${investigationId}/research`, {})
    assert.equal(response.status, 502)
    assert.equal((response.body as { error: { code: string } }).error.code, 'provider_unavailable')
  })

  it('maps invalid JSON to invalid_provider_response', async () => {
    await boot()
    harness.mock.exaMode = 'bad-json'
    const response = await client.request<ApiResponse<never>>('POST', `/api/investigations/${investigationId}/research`, {})
    assert.equal(response.status, 502)
    assert.equal((response.body as { error: { code: string } }).error.code, 'invalid_provider_response')
  })

  it('times out instead of hanging forever', async () => {
    await boot({ EXA_TIMEOUT_MS: '400' })
    harness.mock.exaMode = 'timeout'
    const started = Date.now()
    const response = await client.request<ApiResponse<never>>('POST', `/api/investigations/${investigationId}/research`, {})
    const elapsed = Date.now() - started
    assert.equal(response.status, 504)
    assert.equal((response.body as { error: { code: string } }).error.code, 'provider_timeout')
    assert.ok(elapsed < 5000, `timeout demorou ${elapsed}ms`)
  })

  it('records a failed attempt in the usage ledger', async () => {
    await boot()
    harness.mock.exaMode = 'server-error'
    await client.request('POST', `/api/investigations/${investigationId}/research`, {})
    const settings = await client.request<ApiResponse<{ usageHistory: Array<{ operation: string; status: string }> }>>(
      'GET',
      '/api/settings',
    )
    const history = (settings.body as { data: { usageHistory: Array<{ operation: string; status: string }> } }).data.usageHistory
    assert.ok(history.some((entry) => entry.operation === 'research' && entry.status === 'error'))
  })

  it('blocks an identical research query inside the duplicate guard window', async () => {
    await boot()
    const first = await client.request('POST', `/api/investigations/${investigationId}/research`, { numResults: 2 })
    assert.equal(first.status, 200)

    const second = await client.request<ApiResponse<never>>('POST', `/api/investigations/${investigationId}/research`, {
      numResults: 2,
    })
    assert.equal(second.status, 429)
    assert.equal((second.body as { error: { code: string } }).error.code, 'rate_limited')
    assert.equal(harness.mock.exaRequests.length, 1, 'a segunda consulta não deve chegar ao provedor')
  })

  it('allows an explicit repeat of the same query', async () => {
    await boot()
    await client.request('POST', `/api/investigations/${investigationId}/research`, { numResults: 2 })
    const repeat = await client.request('POST', `/api/investigations/${investigationId}/research`, {
      numResults: 2,
      repeat: true,
    })
    assert.equal(repeat.status, 200)
    assert.equal(harness.mock.exaRequests.length, 2)
  })
})

describe('evidence storage', () => {
  async function addFromResearch(): Promise<{ added: Evidence[] }> {
    const research = await client.request<ApiResponse<{ results: Array<Record<string, string>> }>>(
      'POST',
      `/api/investigations/${investigationId}/research`,
      { numResults: 3 },
    )
    const results = (research.body as { data: { results: Array<Record<string, string>> } }).data.results
    const response = await client.request<ApiResponse<{ added: Evidence[] }>>(
      'POST',
      `/api/investigations/${investigationId}/evidence/bulk`,
      {
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
      },
    )
    assert.equal(response.status, 201)
    return (response.body as { data: { added: Evidence[] } }).data
  }

  it('persists provenance and a relevance breakdown', async () => {
    await boot()
    const { added } = await addFromResearch()
    assert.equal(added.length, 3)
    for (const evidence of added) {
      assert.ok(evidence.id.startsWith('evi_'))
      assert.equal(evidence.investigationId, investigationId)
      assert.ok(evidence.relevanceBreakdown)
      assert.ok(evidence.relevanceBreakdown!.rationale.length > 0)
      assert.equal(evidence.validationStatus, 'pending')
    }
  })

  it('returns the existing row instead of duplicating a URL', async () => {
    await boot()
    await addFromResearch()
    const response = await client.request<ApiResponse<{ evidence: Evidence; duplicate: boolean }>>(
      'POST',
      `/api/investigations/${investigationId}/evidence`,
      {
        source: {
          title: 'Estudo sobre aprendizado de máquina aplicado a antifraude',
          url: 'https://example.org/estudo-antifraude?utm_source=newsletter',
          domain: 'example.org',
          snippet: '',
          retrievedContent: null,
          publishedAt: null,
          author: null,
          providerRequestId: null,
          contentAvailability: [],
        },
      },
    )
    assert.equal(response.status, 200)
    assert.equal((response.body as { data: { duplicate: boolean } }).data.duplicate, true)

    const list = await client.request<ApiResponse<Evidence[]>>('GET', `/api/investigations/${investigationId}/evidence`)
    assert.equal((list.body as { data: Evidence[] }).data.length, 3)
  })

  it('skips duplicates inside a bulk selection and reports why', async () => {
    await boot()
    await addFromResearch()
    const response = await client.request<ApiResponse<{ added: Evidence[]; skipped: Array<{ reason: string }> }>>(
      'POST',
      `/api/investigations/${investigationId}/evidence/bulk`,
      {
        sources: [
          {
            title: 'Repetida',
            url: 'https://example.org/estudo-antifraude',
            domain: 'example.org',
            snippet: '',
            retrievedContent: null,
            publishedAt: null,
            author: null,
            providerRequestId: null,
            contentAvailability: [],
          },
        ],
      },
    )
    const data = (response.body as { data: { added: Evidence[]; skipped: Array<{ reason: string }> } }).data
    assert.equal(data.added.length, 0)
    assert.ok(data.skipped[0]!.reason.includes('já adicionada'))
  })

  it('rejects a non-http URL', async () => {
    await boot()
    const response = await client.request('POST', `/api/investigations/${investigationId}/evidence`, {
      source: {
        title: 'Perigosa',
        url: 'javascript:alert(1)',
        domain: '',
        snippet: '',
        retrievedContent: null,
        publishedAt: null,
        author: null,
        providerRequestId: null,
        contentAvailability: [],
      },
    })
    assert.equal(response.status, 400)
  })

  it('marks results already added when repeating a search', async () => {
    await boot()
    await addFromResearch()
    const repeat = await client.request<
      ApiResponse<{ results: Array<{ url: string; alreadyAdded: boolean; existingEvidenceId: string | null }> }>
    >('POST', `/api/investigations/${investigationId}/research`, { numResults: 3, repeat: true })
    const results = (repeat.body as { data: { results: Array<{ alreadyAdded: boolean; existingEvidenceId: string | null }> } }).data.results
    assert.ok(results.every((item) => item.alreadyAdded))
    assert.ok(results.every((item) => item.existingEvidenceId !== null))
  })
})

describe('Gemini analysis', () => {
  async function seedEvidence(): Promise<Evidence[]> {
    const research = await client.request<ApiResponse<{ results: Array<Record<string, string>> }>>(
      'POST',
      `/api/investigations/${investigationId}/research`,
      { numResults: 3 },
    )
    const results = (research.body as { data: { results: Array<Record<string, string>> } }).data.results
    const added = await client.request<ApiResponse<{ added: Evidence[] }>>(
      'POST',
      `/api/investigations/${investigationId}/evidence/bulk`,
      {
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
      },
    )
    return (added.body as { data: { added: Evidence[] } }).data.added
  }

  it('sends only stored evidence and returns a validated structured analysis', async () => {
    await boot()
    const evidence = await seedEvidence()

    const response = await client.request<ApiResponse<Analysis>>(
      'POST',
      `/api/investigations/${investigationId}/analyses`,
      {},
    )
    assert.equal(response.status, 201)
    const analysis = (response.body as { data: Analysis }).data

    assert.equal(analysis.status, 'completed')
    assert.ok(analysis.executiveSummary.length > 0)
    assert.ok(analysis.findings.length > 0)
    assert.ok(analysis.limitations.length > 0)
    assert.ok(analysis.informationGaps.length > 0)
    assert.ok(analysis.objectiveAlignment.length > 0)
    assert.equal(analysis.model, 'gemini-2.5-flash')
    assert.ok(analysis.usage && analysis.usage.totalTokens! > 0)

    // Every reference must be a real evidence row of this investigation.
    const known = new Set(evidence.map((item) => item.id))
    for (const reference of analysis.references) {
      assert.ok(known.has(reference.evidenceId), `referência inexistente: ${reference.evidenceId}`)
      assert.ok(reference.url.startsWith('https://'))
    }

    // The provider received the objective and every evidence id.
    const request = harness.mock.geminiRequests[0]!
    const userText = JSON.stringify(request)
    assert.ok(userText.includes('Identificar aplicações reais'))
    for (const item of evidence) assert.ok(userText.includes(item.id))
    assert.ok(userText.includes('responseSchema'))
  })

  it('rejects an analysis that cites a fabricated evidence id', async () => {
    await boot()
    await seedEvidence()
    harness.mock.geminiMode = 'fabricated-reference'

    const response = await client.request<ApiResponse<never>>(
      'POST',
      `/api/investigations/${investigationId}/analyses`,
      {},
    )
    assert.equal(response.status, 502)
    assert.equal((response.body as { error: { code: string } }).error.code, 'invalid_provider_response')

    // The failure is recorded honestly — never as a completed analysis.
    const list = await client.request<ApiResponse<Analysis[]>>(
      'GET',
      `/api/investigations/${investigationId}/analyses`,
    )
    const analyses = (list.body as { data: Analysis[] }).data
    assert.equal(analyses.length, 1)
    assert.equal(analyses[0]!.status, 'failed')
    assert.ok(analyses[0]!.findings.length === 0)
    assert.ok(analyses[0]!.errorMessage?.includes('validação'))
  })

  it('rejects a schema-invalid response', async () => {
    await boot()
    await seedEvidence()
    harness.mock.geminiMode = 'invalid-schema'

    const response = await client.request('POST', `/api/investigations/${investigationId}/analyses`, {})
    assert.equal(response.status, 502)
    assert.equal((response.body as { error: { code: string } }).error.code, 'invalid_provider_response')
  })

  it('refuses to analyse with no evidence', async () => {
    await boot()
    const response = await client.request('POST', `/api/investigations/${investigationId}/analyses`, {})
    assert.equal(response.status, 400)
    assert.equal(harness.mock.geminiRequests.length, 0)
  })

  it('maps provider auth, quota and outage failures', async () => {
    await boot()
    await seedEvidence()

    harness.mock.geminiMode = 'unauthorized'
    const auth = await client.request<ApiResponse<never>>('POST', `/api/investigations/${investigationId}/analyses`, {})
    assert.equal(auth.status, 502)
    assert.equal((auth.body as { error: { code: string } }).error.code, 'provider_auth_failed')

    harness.mock.geminiMode = 'rate-limit'
    const limit = await client.request<ApiResponse<never>>('POST', `/api/investigations/${investigationId}/analyses`, {})
    assert.equal(limit.status, 429)
    assert.equal((limit.body as { error: { code: string } }).error.code, 'provider_rate_limited')

    harness.mock.geminiMode = 'server-error'
    const outage = await client.request<ApiResponse<never>>('POST', `/api/investigations/${investigationId}/analyses`, {})
    assert.equal(outage.status, 502)
    assert.equal((outage.body as { error: { code: string } }).error.code, 'provider_unavailable')
  })

  it('rejects a truncated response instead of accepting half an analysis', async () => {
    await boot()
    await seedEvidence()
    harness.mock.geminiMode = 'truncated'
    const response = await client.request('POST', `/api/investigations/${investigationId}/analyses`, {})
    assert.equal(response.status, 502)
    assert.equal((response.body as { error: { code: string } }).error.code, 'invalid_provider_response')
  })
})

describe('cost protection', () => {
  /**
   * Add one evidence row through the manual endpoint.
   *
   * Analysis refuses to run without evidence, and since v0.2.4.2 a source can be
   * entered without a provider — so the gate can be reached with zero external
   * requests, which is what the assertion needs to stay meaningful.
   */
  async function seedEvidenceForGate(): Promise<void> {
    const response = await client.request('POST', `/api/investigations/${investigationId}/evidence`, {
      source: {
        title: 'Fonte para o teste de gate',
        url: 'https://example.org/gate-fixture',
        snippet: 'Conteúdo de teste, sem chamada externa.',
      },
      allowDuplicate: false,
    })
    assert.equal(response.status, 201)
  }

  it('enforces the per-user daily research limit', async () => {
    await boot({ RESEARCH_DAILY_LIMIT: '1' })
    const first = await client.request('POST', `/api/investigations/${investigationId}/research`, { numResults: 2, repeat: true })
    assert.equal(first.status, 200)

    const second = await client.request<ApiResponse<never>>('POST', `/api/investigations/${investigationId}/research`, {
      numResults: 2,
      repeat: true,
    })
    assert.equal(second.status, 429)
    assert.equal((second.body as { error: { code: string } }).error.code, 'quota_exceeded')
    assert.equal(harness.mock.exaRequests.length, 1, 'a chamada bloqueada não deve chegar ao provedor')
  })

  it('enforces the per-user daily analysis limit', async () => {
    await boot({ ANALYSIS_DAILY_LIMIT: '1' })
    const research = await client.request<ApiResponse<{ results: Array<Record<string, string>> }>>(
      'POST',
      `/api/investigations/${investigationId}/research`,
      { numResults: 3 },
    )
    const results = (research.body as { data: { results: Array<Record<string, string>> } }).data.results
    await client.request('POST', `/api/investigations/${investigationId}/evidence/bulk`, {
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

    const first = await client.request('POST', `/api/investigations/${investigationId}/analyses`, {})
    assert.equal(first.status, 201)

    const second = await client.request<ApiResponse<never>>('POST', `/api/investigations/${investigationId}/analyses`, {})
    assert.equal(second.status, 429)
    assert.equal((second.body as { error: { code: string } }).error.code, 'quota_exceeded')
    assert.equal(harness.mock.geminiRequests.length, 1)
  })

  it('reports the remaining quota and a reset instant', async () => {
    await boot({ RESEARCH_DAILY_LIMIT: '2' })
    const response = await client.request<ApiResponse<{ quota: UsageQuotaSnapshot }>>('GET', '/api/settings')
    const quota = (response.body as { data: { quota: UsageQuotaSnapshot } }).data.quota
    assert.equal(quota.research.limit, 2)
    assert.equal(quota.research.used, 0)
    assert.equal(quota.research.remaining, 2)
    assert.ok(new Date(quota.research.resetsAt).getTime() > Date.now())
    assert.equal(quota.externalApisEnabled, true)
  })

  it('blocks every provider call when external APIs are disabled', async () => {
    // `PAID=true` with `EXTERNAL=false` is an invalid configuration that
    // `assertProductionSafety` refuses at boot, so this case pins both off —
    // which is also the honest description of "everything disabled".
    await boot({ ENABLE_EXTERNAL_APIS: 'false', ENABLE_PAID_OPERATIONS: 'false' })
    const research = await client.request<ApiResponse<never>>('POST', `/api/investigations/${investigationId}/research`, {})
    assert.equal(research.status, 503)
    assert.equal((research.body as { error: { code: string } }).error.code, 'external_disabled')

    const analysis = await client.request<ApiResponse<never>>('POST', `/api/investigations/${investigationId}/analyses`, {})
    assert.equal(analysis.status, 503)

    assert.equal(harness.mock.exaRequests.length, 0)
    assert.equal(harness.mock.geminiRequests.length, 0)
  })

  it('blocks every provider call when paid operations are disabled', async () => {
    // The v0.2.4.3 gate: external calls allowed, spending not authorised.
    await boot({ ENABLE_EXTERNAL_APIS: 'true', ENABLE_PAID_OPERATIONS: 'false' })

    const research = await client.request<ApiResponse<never>>('POST', `/api/investigations/${investigationId}/research`, {})
    assert.equal(research.status, 503)
    const researchError = (research.body as { error: { code: string; message: string } }).error
    assert.equal(researchError.code, 'external_disabled')
    assert.match(researchError.message, /ENABLE_PAID_OPERATIONS/, 'a mensagem deve nomear o interruptor')

    // Analysis validates its input before reserving, so the gate can only be
    // reached with evidence present. Seed it, then assert the refusal.
    await seedEvidenceForGate()

    const analysis = await client.request<ApiResponse<never>>('POST', `/api/investigations/${investigationId}/analyses`, {})
    assert.equal(analysis.status, 503)
    const analysisError = (analysis.body as { error: { code: string; message: string } }).error
    assert.equal(analysisError.code, 'external_disabled')
    assert.match(analysisError.message, /ENABLE_PAID_OPERATIONS/)

    // Decisive: no provider was contacted on either path.
    assert.equal(harness.mock.exaRequests.length, 0, 'a Exa não pode ter sido chamada')
    assert.equal(harness.mock.geminiRequests.length, 0, 'o Gemini não pode ter sido chamado')
  })

  it('consumes no quota when paid operations are disabled', async () => {
    // The gate must run *before* any counting, so a refusal leaves the allowance
    // untouched — otherwise a blocked request would still cost the user a slot.
    await boot({ ENABLE_EXTERNAL_APIS: 'true', ENABLE_PAID_OPERATIONS: 'false', ANALYSIS_DAILY_LIMIT: '2' })

    const before = await client.request<ApiResponse<{ quota: UsageQuotaSnapshot }>>('GET', '/api/settings')
    const quotaBefore = (before.body as { data: { quota: UsageQuotaSnapshot } }).data.quota
    assert.equal(quotaBefore.analysis.used, 0)

    await client.request('POST', `/api/investigations/${investigationId}/analyses`, {})
    await client.request('POST', `/api/investigations/${investigationId}/research`, {})

    const after = await client.request<ApiResponse<{ quota: UsageQuotaSnapshot }>>('GET', '/api/settings')
    const quotaAfter = (after.body as { data: { quota: UsageQuotaSnapshot } }).data.quota
    assert.equal(quotaAfter.analysis.used, 0, 'uma recusa não pode consumir cota de análise')
    assert.equal(quotaAfter.research.used, 0, 'uma recusa não pode consumir cota de pesquisa')
    assert.equal(quotaAfter.analysis.remaining, 2)
  })

  it('runs paid operations when both switches are on', async () => {
    // The positive control: the gate must not block legitimate operation.
    await boot({ ENABLE_EXTERNAL_APIS: 'true', ENABLE_PAID_OPERATIONS: 'true' })

    const research = await client.request<ApiResponse<{ results: Array<Record<string, string>> }>>(
      'POST',
      `/api/investigations/${investigationId}/research`,
      { numResults: 3 },
    )
    assert.equal(research.status, 200)
    assert.equal(harness.mock.exaRequests.length, 1)

    const results = (research.body as { data: { results: Array<Record<string, string>> } }).data.results
    await client.request('POST', `/api/investigations/${investigationId}/evidence/bulk`, {
      sources: results.map((item) => ({
        title: item['title'],
        url: item['url'],
        snippet: '',
        retrievedContent: item['retrievedContent'] ?? null,
      })),
    })

    const analysis = await client.request<ApiResponse<Analysis>>(
      'POST',
      `/api/investigations/${investigationId}/analyses`,
      {},
    )
    assert.equal(analysis.status, 201)
    assert.equal(harness.mock.geminiRequests.length, 1)
  })

  it('blocks the provider when the API key is missing', async () => {
    await boot({ EXA_API_KEY: '' })
    const response = await client.request<ApiResponse<never>>('POST', `/api/investigations/${investigationId}/research`, {})
    assert.equal(response.status, 503)
    const body = response.body as { error: { code: string; message: string } }
    assert.equal(body.error.code, 'external_disabled')
    assert.ok(body.error.message.includes('EXA_API_KEY'))
    assert.equal(harness.mock.exaRequests.length, 0)
  })

  it('records blocked attempts so the operator can audit refusals', async () => {
    await boot({ RESEARCH_DAILY_LIMIT: '1' })
    await client.request('POST', `/api/investigations/${investigationId}/research`, { numResults: 2, repeat: true })
    await client.request('POST', `/api/investigations/${investigationId}/research`, { numResults: 2, repeat: true })

    const settings = await client.request<ApiResponse<{ usageHistory: Array<{ status: string; errorCode: string | null }> }>>(
      'GET',
      '/api/settings',
    )
    const history = (settings.body as { data: { usageHistory: Array<{ status: string; errorCode: string | null }> } }).data
      .usageHistory
    assert.ok(history.some((entry) => entry.status === 'blocked'))
  })
})
