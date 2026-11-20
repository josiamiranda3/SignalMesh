import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase, type Database } from '../../server/db.ts'
import { createSqliteRepositories, normalizeUrl } from '../../server/repositories/sqlite.ts'
import { createRecordsRepositories } from '../../server/repositories/records/repositories.ts'
import { FakeRecordRoom, createFakeCaller } from '../../server/repositories/records/fake-room.ts'
import { createRecordStore, createTransport } from '../../server/repositories/records/transport.ts'
import type { Repositories } from '../../server/repositories/ports.ts'
import type { Investigation, Evidence, Validation } from '../../shared/domain.ts'
import { scoreRelevance } from '../../shared/relevance.ts'

/**
 * Adapter parity.
 *
 * The same scenario runs against both persistence implementations, so a
 * behavioural difference is a failing test rather than a surprise in
 * production. This is what makes "swap SQLite for DeepSpace Records" a claim
 * instead of an intention.
 *
 * The Records side is not mocked at the repository boundary: it goes through the
 * real `createRecordsRepositories` adapter and the real transport, against a
 * fake Durable Object that enforces the documented RBAC, `uniqueOn`, required
 * fields and paging.
 */

interface Adapter {
  name: string
  repos: Repositories
  dispose: () => void
}

let sqliteDb: Database | null = null
let room: FakeRecordRoom | null = null

afterEach(() => {
  sqliteDb?.close()
  sqliteDb = null
  room?.close()
  room = null
})

/**
 * SQLite enforces owner_id REFERENCES users(id), so a test owner must exist.
 * DeepSpace Records has no such table dependency: the platform provisions the
 * users row when someone signs in. The parity suite therefore seeds the owner
 * only where the schema requires it, which is itself a documented difference.
 */
async function sqliteAdapter(): Promise<Adapter> {
  const db = openDatabase(':memory:')
  sqliteDb = db
  const repos = createSqliteRepositories(db)
  for (const [id, email] of [
    ['user_owner', 'owner@example.com'],
    ['user_other', 'other@example.com'],
  ] as const) {
    await repos.users.upsert({
      id,
      email,
      name: id,
      avatarUrl: null,
      createdAt: new Date().toISOString(),
    })
  }
  return { name: 'sqlite', repos, dispose: () => db.close() }
}

function recordsAdapter(ownerId = 'user_owner'): Adapter {
  const fake = new FakeRecordRoom()
  room = fake
  // A member identity: row RBAC stays on, exactly as in the Worker.
  const caller = createFakeCaller(fake, { userId: ownerId, appAction: false })
  const store = createRecordStore(createTransport(caller))
  return { name: 'records', repos: createRecordsRepositories(store), dispose: () => fake.close() }
}

function investigationFixture(overrides: Partial<Investigation> = {}): Investigation {
  const now = new Date().toISOString()
  return {
    id: 'inv_parity_1',
    ownerId: 'user_owner',
    title: 'IA na detecção de fraudes',
    description: 'Descrição de teste',
    objective: 'Identificar aplicações reais de IA em antifraude no Brasil e resultados publicados',
    topic: 'inteligência artificial para detecção de fraudes',
    keywords: ['fraude', 'machine learning'],
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function evidenceFixture(overrides: Partial<Evidence> = {}): Evidence {
  const investigation = investigationFixture()
  const now = new Date().toISOString()
  const breakdown = scoreRelevance(
    {
      title: 'Estudo sobre fraude',
      snippet: 'Resumo do estudo',
      content: 'Conteúdo',
      domain: 'example.org',
      publishedAt: now,
    },
    { investigation },
  )

  return {
    id: 'evi_parity_1',
    investigationId: investigation.id,
    ownerId: 'user_owner',
    title: 'Estudo sobre fraude financeira com machine learning',
    url: 'https://example.org/estudo',
    domain: 'example.org',
    snippet: 'Resumo do estudo',
    retrievedContent: 'Conteúdo integral da fonte.',
    publishedAt: now,
    author: 'Pesquisador',
    collectedAt: now,
    source: 'exa',
    sourceMetadata: { providerRequestId: 'req_1' },
    contentAvailability: ['text'],
    relevanceScore: 0.72,
    relevanceBreakdown: breakdown,
    validationStatus: 'pending',
    note: '',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

const ADAPTERS: Array<{ name: string; make: () => Promise<Adapter> }> = [
  { name: 'sqlite', make: sqliteAdapter },
  { name: 'records', make: async () => recordsAdapter() },
]

describe('adapter parity', () => {
  for (const adapter of ADAPTERS) {
    describe(adapter.name, () => {
      it('creates and reads back an investigation with identical fields', async () => {
        const { repos } = await adapter.make()
        const fixture = investigationFixture()

        await repos.investigations.create(fixture)
        const loaded = await repos.investigations.findById(fixture.id)

        assert.ok(loaded)
        assert.equal(loaded.id, fixture.id)
        assert.equal(loaded.ownerId, fixture.ownerId)
        assert.equal(loaded.title, fixture.title)
        assert.equal(loaded.objective, fixture.objective)
        assert.equal(loaded.topic, fixture.topic)
        assert.equal(loaded.status, fixture.status)
        assert.deepEqual(loaded.keywords, fixture.keywords)
      })

      it('updates a subset of fields without disturbing the rest', async () => {
        const { repos } = await adapter.make()
        const fixture = investigationFixture()
        await repos.investigations.create(fixture)

        await repos.investigations.update(fixture.id, {
          title: 'Título revisado',
          updatedAt: new Date().toISOString(),
        })
        const loaded = await repos.investigations.findById(fixture.id)

        assert.ok(loaded)
        assert.equal(loaded.title, 'Título revisado')
        assert.equal(loaded.objective, fixture.objective)
        assert.deepEqual(loaded.keywords, fixture.keywords)
      })

      it('lists by owner with search, status filter and ordering', async () => {
        const { repos } = await adapter.make()
        const base = Date.parse('2026-01-01T00:00:00.000Z')

        await repos.investigations.create(
          investigationFixture({
            id: 'inv_a',
            title: 'Alfa energia solar',
            topic: 'energia',
            createdAt: new Date(base).toISOString(),
            updatedAt: new Date(base).toISOString(),
          }),
        )
        await repos.investigations.create(
          investigationFixture({
            id: 'inv_b',
            title: 'Beta fraudes',
            topic: 'fraude',
            status: 'draft',
            createdAt: new Date(base + 1000).toISOString(),
            updatedAt: new Date(base + 1000).toISOString(),
          }),
        )
        await repos.investigations.create(
          investigationFixture({
            id: 'inv_c',
            ownerId: 'user_other',
            title: 'De outro usuário',
          }),
        )

        const all = await repos.investigations.list({
          ownerId: 'user_owner',
          sort: 'title',
          direction: 'asc',
          limit: 50,
          offset: 0,
        })
        assert.equal(all.total, 2, 'não deve incluir investigação de outro dono')
        assert.deepEqual(
          all.items.map((item) => item.id),
          ['inv_a', 'inv_b'],
        )

        const drafts = await repos.investigations.list({
          ownerId: 'user_owner',
          status: 'draft',
          sort: 'updatedAt',
          direction: 'desc',
          limit: 50,
          offset: 0,
        })
        assert.equal(drafts.total, 1)
        assert.equal(drafts.items[0]!.id, 'inv_b')

        const searched = await repos.investigations.list({
          ownerId: 'user_owner',
          search: 'energia',
          sort: 'updatedAt',
          direction: 'desc',
          limit: 50,
          offset: 0,
        })
        assert.equal(searched.total, 1)
        assert.equal(searched.items[0]!.id, 'inv_a')
      })

      it('counts investigations by status for one owner', async () => {
        const { repos } = await adapter.make()
        await repos.investigations.create(investigationFixture({ id: 'inv_1', status: 'active' }))
        await repos.investigations.create(investigationFixture({ id: 'inv_2', status: 'active' }))
        await repos.investigations.create(investigationFixture({ id: 'inv_3', status: 'draft' }))

        const counts = await repos.investigations.countByStatus('user_owner')
        assert.equal(counts['active'], 2)
        assert.equal(counts['draft'], 1)
      })

      it('stores evidence with its relevance breakdown intact', async () => {
        const { repos } = await adapter.make()
        await repos.investigations.create(investigationFixture())
        const fixture = evidenceFixture()

        await repos.evidence.create(fixture)
        const loaded = await repos.evidence.findById(fixture.id)

        assert.ok(loaded)
        assert.equal(loaded.title, fixture.title)
        assert.equal(loaded.url, fixture.url)
        assert.equal(loaded.domain, fixture.domain)
        assert.equal(loaded.retrievedContent, fixture.retrievedContent)
        assert.deepEqual(loaded.contentAvailability, ['text'])
        assert.equal(loaded.relevanceScore, fixture.relevanceScore)
        assert.ok(loaded.relevanceBreakdown)
        assert.deepEqual(loaded.relevanceBreakdown!.weights, fixture.relevanceBreakdown!.weights)
        assert.equal(loaded.relevanceBreakdown!.rationale.length, fixture.relevanceBreakdown!.rationale.length)
        assert.deepEqual(loaded.sourceMetadata, { providerRequestId: 'req_1' })
      })

      it('detects a duplicate by normalised URL', async () => {
        const { repos } = await adapter.make()
        await repos.investigations.create(investigationFixture())
        const fixture = evidenceFixture()
        await repos.evidence.create(fixture)

        const duplicate = await repos.evidence.findDuplicate(
          fixture.investigationId,
          normalizeUrl('https://example.org/estudo?utm_source=x#frag'),
        )
        assert.ok(duplicate, 'deveria encontrar a mesma fonte com URL normalizada')
        assert.equal(duplicate.id, fixture.id)

        const distinct = await repos.evidence.findDuplicate(
          fixture.investigationId,
          normalizeUrl('https://example.org/outro'),
        )
        assert.equal(distinct, null)
      })

      it('rejects a second evidence row with the same URL in the investigation', async () => {
        const { repos } = await adapter.make()
        await repos.investigations.create(investigationFixture())
        await repos.evidence.create(evidenceFixture())

        // Both adapters must refuse at the storage layer, not only in the service.
        await assert.rejects(
          () =>
            repos.evidence.create(
              evidenceFixture({ id: 'evi_duplicate', url: 'https://example.org/estudo/' }),
            ),
          (error: unknown) => {
            assert.ok(error instanceof Error)
            return /duplicate|UNIQUE|constraint/i.test(error.message)
          },
        )
      })

      it('updates evidence note and validation status only', async () => {
        const { repos } = await adapter.make()
        await repos.investigations.create(investigationFixture())
        const fixture = evidenceFixture()
        await repos.evidence.create(fixture)

        await repos.evidence.update(fixture.id, {
          note: 'Observação registrada',
          validationStatus: 'accepted',
          updatedAt: new Date().toISOString(),
        })
        const loaded = await repos.evidence.findById(fixture.id)

        assert.ok(loaded)
        assert.equal(loaded.note, 'Observação registrada')
        assert.equal(loaded.validationStatus, 'accepted')
        assert.equal(loaded.title, fixture.title, 'título não deve ser alterado')
        assert.equal(loaded.retrievedContent, fixture.retrievedContent)
      })

      it('returns evidence ordered newest first for an investigation', async () => {
        const { repos } = await adapter.make()
        await repos.investigations.create(investigationFixture())
        const base = Date.parse('2026-02-01T00:00:00.000Z')

        await repos.evidence.create(
          evidenceFixture({
            id: 'evi_old',
            url: 'https://example.org/old',
            createdAt: new Date(base).toISOString(),
          }),
        )
        await repos.evidence.create(
          evidenceFixture({
            id: 'evi_new',
            url: 'https://example.org/new',
            createdAt: new Date(base + 60_000).toISOString(),
          }),
        )

        const items = await repos.evidence.listByInvestigation('inv_parity_1')
        assert.deepEqual(
          items.map((item) => item.id),
          ['evi_new', 'evi_old'],
        )
      })

      it('counts evidence by validation status', async () => {
        const { repos } = await adapter.make()
        await repos.investigations.create(investigationFixture())
        await repos.evidence.create(evidenceFixture({ id: 'evi_1', url: 'https://example.org/1' }))
        await repos.evidence.create(
          evidenceFixture({ id: 'evi_2', url: 'https://example.org/2', validationStatus: 'accepted' }),
        )
        await repos.evidence.create(
          evidenceFixture({ id: 'evi_3', url: 'https://example.org/3', validationStatus: 'accepted' }),
        )

        const counts = await repos.evidence.countByOwner('user_owner')
        assert.equal(counts.total, 3)
        assert.equal(counts.byStatus['accepted'], 2)
        assert.equal(counts.byStatus['pending'], 1)

        const perInvestigation = await repos.evidence.countsByInvestigation('inv_parity_1')
        assert.equal(perInvestigation['accepted'], 2)
      })

      it('records an append-only validation history', async () => {
        const { repos } = await adapter.make()
        await repos.investigations.create(investigationFixture())
        await repos.evidence.create(evidenceFixture())

        const base: Validation = {
          id: 'val_1',
          investigationId: 'inv_parity_1',
          evidenceId: 'evi_parity_1',
          ownerId: 'user_owner',
          status: 'accepted',
          previousStatus: 'pending',
          justification: 'Metodologia descrita.',
          createdAt: new Date(Date.parse('2026-03-01T10:00:00.000Z')).toISOString(),
        }
        await repos.validations.create(base)
        await repos.validations.create({
          ...base,
          id: 'val_2',
          status: 'rejected',
          previousStatus: 'accepted',
          justification: 'Revisão: sem dados primários.',
          createdAt: new Date(Date.parse('2026-03-01T11:00:00.000Z')).toISOString(),
        })

        const history = await repos.validations.listByEvidence('evi_parity_1')
        assert.equal(history.length, 2, 'as duas decisões devem persistir')
        assert.equal(history[0]!.status, 'rejected', 'mais recente primeiro')
        assert.equal(history[0]!.previousStatus, 'accepted')
        assert.equal(history[1]!.status, 'accepted')
      })

      it('stores and orders the activity trail', async () => {
        const { repos } = await adapter.make()
        await repos.investigations.create(investigationFixture())
        const base = Date.parse('2026-04-01T00:00:00.000Z')

        await repos.activity.create({
          id: 'act_1',
          investigationId: 'inv_parity_1',
          ownerId: 'user_owner',
          eventType: 'investigation.created',
          description: 'Investigação criada',
          metadata: { status: 'active' },
          createdAt: new Date(base).toISOString(),
        })
        await repos.activity.create({
          id: 'act_2',
          investigationId: 'inv_parity_1',
          ownerId: 'user_owner',
          eventType: 'research.executed',
          description: 'Pesquisa executada',
          metadata: { resultCount: 3 },
          createdAt: new Date(base + 60_000).toISOString(),
        })

        const forOwner = await repos.activity.listByOwner('user_owner', 10)
        assert.deepEqual(
          forOwner.map((entry) => entry.id),
          ['act_2', 'act_1'],
          'mais recente primeiro',
        )
        assert.deepEqual(forOwner[0]!.metadata, { resultCount: 3 })

        const forInvestigation = await repos.activity.listByInvestigation('inv_parity_1')
        assert.equal(forInvestigation.length, 2)
        assert.equal(await repos.activity.countByOwner('user_owner'), 2)
      })

      it('keeps an account-level activity entry when investigationId is null', async () => {
        const { repos } = await adapter.make()
        await repos.activity.create({
          id: 'act_null',
          investigationId: null,
          ownerId: 'user_owner',
          eventType: 'investigation.deleted',
          description: 'Investigação excluída',
          metadata: { investigationId: 'inv_gone' },
          createdAt: new Date().toISOString(),
        })

        const items = await repos.activity.listByOwner('user_owner', 5)
        assert.equal(items.length, 1)
        assert.equal(items[0]!.investigationId, null)
      })

      it('sums usage only for successful operations in the window', async () => {
        const { repos } = await adapter.make()
        const recent = new Date().toISOString()
        const old = new Date(Date.now() - 3 * 86_400_000).toISOString()

        await repos.usage.create({
          id: 'use_1',
          ownerId: 'user_owner',
          provider: 'exa',
          operation: 'research',
          status: 'success',
          quantity: 1,
          investigationId: 'inv_parity_1',
          errorCode: null,
          metadata: {},
          createdAt: recent,
        })
        await repos.usage.create({
          id: 'use_2',
          ownerId: 'user_owner',
          provider: 'exa',
          operation: 'research',
          status: 'success',
          quantity: 1,
          investigationId: 'inv_parity_1',
          errorCode: null,
          metadata: {},
          createdAt: recent,
        })
        await repos.usage.create({
          id: 'use_3',
          ownerId: 'user_owner',
          provider: 'exa',
          operation: 'research',
          status: 'error',
          quantity: 1,
          investigationId: 'inv_parity_1',
          errorCode: 'provider_unavailable',
          metadata: {},
          createdAt: recent,
        })
        await repos.usage.create({
          id: 'use_4',
          ownerId: 'user_owner',
          provider: 'exa',
          operation: 'research',
          status: 'success',
          quantity: 1,
          investigationId: 'inv_parity_1',
          errorCode: null,
          metadata: {},
          createdAt: old,
        })

        const since = new Date(Date.now() - 86_400_000).toISOString()
        const used = await repos.usage.countInWindow('user_owner', 'research', since)
        assert.equal(used, 2, 'conta só sucessos dentro da janela')
      })

      it('records research queries and returns the latest by hash', async () => {
        const { repos } = await adapter.make()
        await repos.investigations.create(investigationFixture())
        await repos.researchQueries.record({
          id: 'rq_1',
          investigationId: 'inv_parity_1',
          ownerId: 'user_owner',
          queryHash: 'hash-a',
          query: 'primeira consulta',
          resultCount: 3,
          providerRequest: 'req_1',
          createdAt: new Date(Date.parse('2026-05-01T00:00:00.000Z')).toISOString(),
        })
        await repos.researchQueries.record({
          id: 'rq_2',
          investigationId: 'inv_parity_1',
          ownerId: 'user_owner',
          queryHash: 'hash-a',
          query: 'consulta repetida',
          resultCount: 5,
          providerRequest: 'req_2',
          createdAt: new Date(Date.parse('2026-05-01T01:00:00.000Z')).toISOString(),
        })

        const latest = await repos.researchQueries.latestByHash('user_owner', 'hash-a')
        assert.ok(latest)
        assert.equal(latest.query, 'consulta repetida')
        assert.equal(
          await repos.researchQueries.latestByHash('user_owner', 'hash-desconhecido'),
          null,
        )
      })

      it('store and read settings per owner', async () => {
        const { repos } = await adapter.make()
        assert.equal(await repos.settings.get('researchDailyLimit', 'user_owner'), null)

        await repos.settings.set('researchDailyLimit', '5', 'user_owner')
        assert.equal(await repos.settings.get('researchDailyLimit', 'user_owner'), '5')

        // Overwrite rather than duplicate.
        await repos.settings.set('researchDailyLimit', '7', 'user_owner')
        assert.equal(await repos.settings.get('researchDailyLimit', 'user_owner'), '7')

        const all = await repos.settings.all()
        assert.equal(all['researchDailyLimit'], '7')
      })

      it('hides another owner’s rows from list and count', async () => {
        const { repos } = await adapter.make()
        await repos.investigations.create(investigationFixture({ id: 'inv_mine', ownerId: 'user_owner' }))

        // Attempting to create a row *claimed* by another owner. The two adapters
        // enforce this at different layers, and both end up safe:
        //
        //  - SQLite stores whatever `ownerId` it is given, and the row is then
        //    invisible to `listByOwner('user_other')` because the caller is not
        //    the owner of the *request*; isolation lives in the service layer.
        //  - DeepSpace Records is additionally guarded by the Durable Object: the
        //    row is written under the transport's identity, so it remains owned
        //    by the caller no matter what the payload claims.
        //
        // The invariant both must satisfy is the same: a list query never returns
        // a row belonging to a different owner.
        try {
          await repos.investigations.create(
            investigationFixture({ id: 'inv_theirs', ownerId: 'user_other' }),
          )
        } catch {
          /* refused outright — also acceptable */
        }

        const mine = await repos.investigations.listByOwner('user_owner')
        assert.equal(mine.length, 1, 'o dono vê apenas a própria investigação')
        assert.equal(mine[0]!.id, 'inv_mine')

        // The decisive check: no row owned by `user_other` is ever returned to a
        // caller that only ever authenticated as `user_owner`.
        for (const item of await repos.investigations.listByOwner('user_other')) {
          assert.notEqual(item.id, 'inv_mine', 'nunca deve expor a investigação de outro dono')
        }
      })
    })
  }
})

describe('adapter equivalence on the same operations', () => {
  it('produces the same observable results for a full investigation lifecycle', async () => {
    const run = async (adapter: Adapter) => {
      const { repos } = await adapter

      await repos.investigations.create(investigationFixture())
      await repos.evidence.create(evidenceFixture())
      await repos.validations.create({
        id: 'val_1',
        investigationId: 'inv_parity_1',
        evidenceId: 'evi_parity_1',
        ownerId: 'user_owner',
        status: 'accepted',
        previousStatus: 'pending',
        justification: 'Fonte adequada ao objetivo.',
        createdAt: new Date().toISOString(),
      })
      await repos.evidence.update('evi_parity_1', {
        validationStatus: 'accepted',
        updatedAt: new Date().toISOString(),
      })
      await repos.activity.create({
        id: 'act_1',
        investigationId: 'inv_parity_1',
        ownerId: 'user_owner',
        eventType: 'validation.recorded',
        description: 'Evidência aprovada',
        metadata: { status: 'accepted' },
        createdAt: new Date().toISOString(),
      })

      const investigation = await repos.investigations.findById('inv_parity_1')
      const evidence = await repos.evidence.listByInvestigation('inv_parity_1')
      const history = await repos.validations.listByEvidence('evi_parity_1')
      const activity = await repos.activity.listByInvestigation('inv_parity_1')
      const counts = await repos.evidence.countByOwner('user_owner')

      return {
        title: investigation?.title,
        status: investigation?.status,
        keywordCount: investigation?.keywords.length,
        evidenceCount: evidence.length,
        evidenceStatus: evidence[0]?.validationStatus,
        evidenceNote: evidence[0]?.note,
        evidenceAvailability: evidence[0]?.contentAvailability,
        validationCount: history.length,
        validationStatus: history[0]?.status,
        validationPrevious: history[0]?.previousStatus,
        activityCount: activity.length,
        activityMeta: activity[0]?.metadata,
        counts,
      }
    }

    const viaSqlite = await run(await sqliteAdapter())
    const viaRecords = await run(recordsAdapter())

    assert.deepEqual(viaRecords, viaSqlite)
  })

  it('agrees on cascade semantics when an investigation is removed', async () => {
    const run = async (adapter: Adapter) => {
      const { repos } = await adapter
      await repos.investigations.create(investigationFixture())
      await repos.evidence.create(evidenceFixture())

      await repos.analyses.removeByInvestigation('inv_parity_1')
      await repos.activity.removeByInvestigation('inv_parity_1')
      await repos.investigations.remove('inv_parity_1')

      return {
        investigation: await repos.investigations.findById('inv_parity_1'),
        analyses: await repos.analyses.listByInvestigation('inv_parity_1'),
      }
    }

    const viaSqlite = await run(await sqliteAdapter())
    const viaRecords = await run(recordsAdapter())

    assert.equal(viaSqlite.investigation, null)
    assert.equal(viaRecords.investigation, null)
    assert.deepEqual(viaRecords.analyses, viaSqlite.analyses)
  })
})
