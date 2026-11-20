import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase } from '../../server/db.ts'
import { createSqliteRepositories } from '../../server/repositories/sqlite.ts'
import { FakeRecordRoom, createFakeCaller } from '../../server/repositories/records/fake-room.ts'
import { createRecordStore, createTransport } from '../../server/repositories/records/transport.ts'
import { migrateToRecords } from '../../server/migration/records.ts'
import type { Investigation } from '../../shared/domain.ts'

/**
 * Migration under `userBound` ownership.
 *
 * Once `ownerId` is `userBound`, the Durable Object stamps the *transport*
 * identity and ignores the payload. That makes a multi-owner dump impossible to
 * import faithfully in one pass: every row would be reattributed to whoever ran
 * the import.
 *
 * These tests pin the resulting contract, which is the safe behaviour rather
 * than the convenient one:
 *
 *  - a mismatch between the rows' owner and the transport identity is refused
 *    up front, so a wrong-owner import cannot start;
 *  - rows belonging to a different owner inside an otherwise valid run are
 *    skipped and reported, never silently reassigned;
 *  - running as the owning identity preserves ids and relations.
 */

const OWNER = 'user_owner'
const OTHER = 'user_other'

function investigation(overrides: Partial<Investigation> = {}): Investigation {
  const now = new Date().toISOString()
  return {
    id: 'inv_mig_1',
    ownerId: OWNER,
    title: 'Investigação a migrar',
    description: '',
    objective: 'Objetivo que precisa sobreviver à migração sem reatribuição de dono',
    topic: 'migração',
    keywords: ['a'],
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

async function seed() {
  const db = openDatabase(':memory:')
  const repos = createSqliteRepositories(db)
  for (const id of [OWNER, OTHER]) {
    await repos.users.upsert({
      id,
      email: `${id}@example.com`,
      name: id,
      avatarUrl: null,
      createdAt: new Date().toISOString(),
    })
  }
  return { db, repos }
}

function roomStore(callerId: string, appAction = false) {
  const room = new FakeRecordRoom()
  const store = createRecordStore(
    createTransport(createFakeCaller(room, { userId: callerId, appAction })),
  )
  return { room, store }
}

describe('migration refuses a wrong-owner transport', () => {
  it('throws when the transport identity differs from the rows’ owner', async () => {
    const { db, repos } = await seed()
    await repos.investigations.create(investigation())
    const { room, store } = roomStore(OTHER, true)

    await assert.rejects(
      () =>
        migrateToRecords({
          source: repos,
          target: store,
          ownerId: OWNER,
          transportOwnerId: OTHER,
        }),
      /carimbaria o proprietário errado|pertencem a|userBound/i,
    )

    assert.equal(room.rawCount('investigations'), 0, 'nada deve ser gravado antes da checagem')
    room.close()
    db.close()
  })

  it('proceeds when the transport identity matches', async () => {
    const { db, repos } = await seed()
    await repos.investigations.create(investigation())
    const { room, store } = roomStore(OWNER, true)

    const report = await migrateToRecords({
      source: repos,
      target: store,
      ownerId: OWNER,
      transportOwnerId: OWNER,
    })

    assert.equal(report.collections['investigations']!.created, 1)
    assert.equal(report.warnings.length, 0)
    room.close()
    db.close()
  })
})

describe('rows from another owner are never imported', () => {
  it('imports only the requested owner’s rows', async () => {
    const { db, repos } = await seed()
    await repos.investigations.create(investigation({ id: 'inv_mine', ownerId: OWNER }))
    await repos.investigations.create(investigation({ id: 'inv_foreign', ownerId: OTHER }))

    const { room, store } = roomStore(OWNER, true)
    const report = await migrateToRecords({ source: repos, target: store, ownerId: OWNER })

    // The source query is owner-scoped, so the foreign row is never even read —
    // the first line of defence. Nothing is written for it.
    assert.equal(report.collections['investigations']!.read, 1, 'deve ler apenas as linhas do dono')
    assert.ok(await store.get('investigations', 'inv_mine'))
    assert.equal(await store.get('investigations', 'inv_foreign'), null)

    room.close()
    db.close()
  })

  it('skips a row whose owner does not match, if one ever reaches the writer', async () => {
    // Defence in depth: `writeRow` refuses a mismatched owner so a buggy or
    // custom source adapter cannot smuggle another account's row into the import
    // (where `userBound` would silently reattribute it to the operator).
    const { db, repos } = await seed()
    await repos.investigations.create(investigation({ id: 'inv_mine', ownerId: OWNER }))

    const { room, store } = roomStore(OWNER, true)

    // A source adapter that returns a foreign row for this owner's query.
    const foreign = investigation({ id: 'inv_leaked', ownerId: OTHER })
    const leakySource = {
      ...repos,
      investigations: {
        ...repos.investigations,
        listByOwner: async (ownerId: string) =>
          ownerId === OWNER ? [investigation({ id: 'inv_mine', ownerId: OWNER }), foreign] : [],
      },
    }

    const report = await migrateToRecords({ source: leakySource, target: store, ownerId: OWNER })

    assert.equal(await store.get('investigations', 'inv_leaked'), null, 'linha estranha não pode entrar')
    assert.ok(await store.get('investigations', 'inv_mine'))
    assert.equal(report.collections['investigations']!.skipped, 1)
    assert.ok(
      report.warnings.some((warning) => warning.includes('inv_leaked')),
      'o aviso deve identificar a linha ignorada',
    )

    room.close()
    db.close()
  })

  it('never reattributes an imported row to the transport identity', async () => {
    const { db, repos } = await seed()
    await repos.investigations.create(investigation({ id: 'inv_mine', ownerId: OWNER }))

    // Run as the owner (the only accepted configuration) and confirm the stored
    // owner is that same owner.
    const { room, store } = roomStore(OWNER, true)
    await migrateToRecords({ source: repos, target: store, ownerId: OWNER })

    const stored = await store.get('investigations', 'inv_mine')
    assert.equal(stored?.data['ownerId'], OWNER)
    room.close()
    db.close()
  })
})

describe('migration still preserves ids and relations', () => {
  it('keeps the investigation id and its evidence association', async () => {
    const { db, repos } = await seed()
    await repos.investigations.create(investigation())
    const now = new Date().toISOString()
    await repos.evidence.create({
      id: 'evi_mig_1',
      investigationId: 'inv_mig_1',
      ownerId: OWNER,
      title: 'Fonte',
      url: 'https://example.org/x',
      domain: 'example.org',
      snippet: 'trecho',
      retrievedContent: null,
      publishedAt: null,
      author: null,
      collectedAt: now,
      source: 'exa',
      sourceMetadata: {},
      contentAvailability: ['snippet'],
      relevanceScore: 0.5,
      relevanceBreakdown: null,
      validationStatus: 'pending',
      note: '',
      createdAt: now,
      updatedAt: now,
    })

    const { room, store } = roomStore(OWNER, true)
    await migrateToRecords({ source: repos, target: store, ownerId: OWNER })

    const evidence = await store.get('evidence', 'evi_mig_1')
    assert.ok(evidence)
    assert.equal(evidence.data['investigationId'], 'inv_mig_1', 'a relação deve sobreviver')
    assert.equal(evidence.data['ownerId'], OWNER)
    room.close()
    db.close()
  })

  it('remains idempotent under the owner-bound contract', async () => {
    const { db, repos } = await seed()
    await repos.investigations.create(investigation())
    const { room, store } = roomStore(OWNER, true)

    await migrateToRecords({ source: repos, target: store, ownerId: OWNER })
    const second = await migrateToRecords({ source: repos, target: store, ownerId: OWNER })

    assert.equal(room.rawCount('investigations'), 1)
    assert.equal(second.collections['investigations']!.created, 0)
    assert.equal(second.collections['investigations']!.unchanged, 1)
    room.close()
    db.close()
  })
})
