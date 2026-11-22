import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SAMPLE_INVESTIGATION, signIn, startHarness, type Client, type Harness } from './harness.ts'
import type { ApiResponse } from '../../shared/api.ts'
import type { Analysis, Investigation } from '../../shared/domain.ts'

/**
 * Concurrent paid operations over HTTP.
 *
 * The point is the provider call count: when two analysis requests arrive at the
 * same time for one user, exactly one must reach Gemini. Before v0.2.4.3 the
 * guard was a `Map` inside the service, which the Worker rebuilds per request —
 * so it protected nothing there. These tests drive the real HTTP surface against
 * the SQLite adapter, where the guard is now a unique index.
 *
 * Providers are the local mock; nothing here calls Exa or Gemini for real.
 */

let harness: Harness
let client: Client
let investigationId: string

async function boot(): Promise<void> {
  harness = await startHarness({
    ENABLE_EXTERNAL_APIS: 'true',
    ENABLE_PAID_OPERATIONS: 'true',
    ANALYSIS_DAILY_LIMIT: '10',
    RESEARCH_DAILY_LIMIT: '10',
    DUPLICATE_GUARD_SECONDS: '0',
  })
  client = await signIn(harness.base, `race-${Math.random().toString(36).slice(2)}@example.com`)
  const created = await client.request<ApiResponse<Investigation>>('POST', '/api/investigations', SAMPLE_INVESTIGATION)
  investigationId = (created.body as { data: Investigation }).data.id

  // Manual evidence: reaches the analysis gate without any provider call.
  const evidence = await client.request('POST', `/api/investigations/${investigationId}/evidence`, {
    source: { title: 'Fonte para concorrência', url: 'https://example.org/race', snippet: 'conteúdo' },
    allowDuplicate: false,
  })
  assert.equal(evidence.status, 201)
}

after(async () => {
  if (harness) await harness.close()
})

describe('concurrent paid operations', () => {
  it('lets only one of two simultaneous analyses reach the provider', async () => {
    await boot()

    const [first, second] = await Promise.all([
      client.request<ApiResponse<Analysis>>('POST', `/api/investigations/${investigationId}/analyses`, {}),
      client.request<ApiResponse<Analysis>>('POST', `/api/investigations/${investigationId}/analyses`, {}),
    ])

    const statuses = [first.status, second.status].sort((a, b) => a - b)
    assert.deepEqual(statuses, [201, 429], `esperava uma aceita e uma recusada, veio ${statuses.join(',')}`)
    assert.equal(harness.mock.geminiRequests.length, 1, 'o Gemini deve ser chamado exatamente uma vez')
  })

  it('releases the slot so a later request succeeds', async () => {
    // Same user as the previous case: the refusal must not leave a reservation
    // behind, or the next attempt would be blocked forever.
    const afterRace = await client.request<ApiResponse<Analysis>>(
      'POST',
      `/api/investigations/${investigationId}/analyses`,
      {},
    )
    assert.equal(afterRace.status, 201, 'a reserva da requisição vencedora foi liberada ao concluir')
    assert.equal(harness.mock.geminiRequests.length, 2)
  })

  it('does not block a different operation of the same user', async () => {
    // A research in flight must not prevent an analysis, and vice versa.
    const [research, analysis] = await Promise.all([
      client.request('POST', `/api/investigations/${investigationId}/research`, { numResults: 2, repeat: true }),
      client.request('POST', `/api/investigations/${investigationId}/analyses`, {}),
    ])
    assert.equal(research.status, 200, `pesquisa deveria passar, veio ${research.status}`)
    assert.equal(analysis.status, 201, `análise deveria passar, veio ${analysis.status}`)
  })

  it('does not block a different user', async () => {
    const other = await signIn(harness.base, `other-${Math.random().toString(36).slice(2)}@example.com`)
    const created = await other.request<ApiResponse<Investigation>>('POST', '/api/investigations', SAMPLE_INVESTIGATION)
    const otherId = (created.body as { data: Investigation }).data.id
    await other.request('POST', `/api/investigations/${otherId}/evidence`, {
      source: { title: 'Outra fonte', url: 'https://example.org/other-race', snippet: 'x' },
      allowDuplicate: false,
    })

    const [mine, theirs] = await Promise.all([
      client.request('POST', `/api/investigations/${investigationId}/analyses`, {}),
      other.request('POST', `/api/investigations/${otherId}/analyses`, {}),
    ])
    assert.equal(mine.status, 201)
    assert.equal(theirs.status, 201, 'usuários distintos não competem pela mesma reserva')
  })
})
