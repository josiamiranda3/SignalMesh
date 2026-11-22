import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase, type Database } from '../../server/db.ts'
import { createSqliteRepositories } from '../../server/repositories/sqlite.ts'
import { FakeRecordRoom, createFakeCaller } from '../../server/repositories/records/fake-room.ts'
import { createActionTools } from '../../server/http/action-routes.ts'
import { migrateRecords } from '../../server/actions/migrate-records.ts'
import { collectMigrationRows, normalizeUrlForMigration } from '../../server/migration/collect.ts'
import type { ActionToolsPort } from '../../server/actions/types.ts'
import type { RecordToolCaller } from '../../server/repositories/records/transport.ts'

/**
 * Migration through the real action, against the record room double.
 *
 * The CLI no longer ships a caller for an unimplemented endpoint: it invokes
 * `migrateRecords`, which is the same handler the Worker dispatches. These tests
 * exercise that handler end to end — parameter validation, ownership refusal,
 * the upsert guard, dry-run, and idempotency — with tools bound exactly as the
 * Worker binds them.
 */

const OWNER = 'user_owner'
const OTHER = 'user_other'

let db: Database | null = null
let room: FakeRecordRoom | null = null

afterEach(() => {
  db?.close()
  db = null
  room?.close()
  room = null
})

/** Tools exactly as the Worker builds them: caller identity, app action on. */
function toolsFor(callerId: string): ActionToolsPort {
  const fake = new FakeRecordRoom()
  room = fake
  const caller: RecordToolCaller = createFakeCaller(fake, { userId: callerId, appAction: true })
  return createActionTools(caller)
}

async function seedSource() {
  const database = openDatabase(':memory:')
  db = database
  const repos = createSqliteRepositories(database)
  for (const id of [OWNER, OTHER]) {
    await repos.users.upsert({
      id,
      email: `${id}@example.com`,
      name: id,
      avatarUrl: null,
      createdAt: new Date().toISOString(),
    })
  }

  const now = new Date().toISOString()
  await repos.investigations.create({
    id: 'inv_1',
    ownerId: OWNER,
    title: 'Investigação a migrar',
    description: '',
    objective: 'Objetivo que precisa sobreviver íntegro à migração por server action',
    topic: 'migração',
    keywords: ['a', 'b'],
    status: 'active',
    createdAt: now,
    updatedAt: now,
  })
  await repos.evidence.create({
    id: 'evi_1',
    investigationId: 'inv_1',
    ownerId: OWNER,
    title: 'Fonte',
    url: 'https://example.org/fonte?utm_source=x',
    domain: 'example.org',
    snippet: 'trecho',
    retrievedContent: null,
    publishedAt: null,
    author: null,
    collectedAt: now,
    source: 'exa',
    sourceMetadata: { providerRequestId: 'req_1' },
    contentAvailability: ['snippet'],
    relevanceScore: 0.5,
    relevanceBreakdown: null,
    validationStatus: 'pending',
    note: '',
    createdAt: now,
    updatedAt: now,
  })

  return repos
}

describe('migration action: happy path', () => {
  it('imports the collected rows with ids and relations preserved', async () => {
    const repos = await seedSource()
    const collected = await collectMigrationRows({ source: repos, ownerId: OWNER })
    const tools = toolsFor(OWNER)

    const result = await migrateRecords({
      userId: OWNER,
      params: { ownerId: OWNER, rows: collected.rows, dryRun: false },
      tools,
    })

    assert.equal(result.success, true)
    if (!result.success) return
    assert.equal(result.data.counts['failed'], 0)
    assert.equal(result.data.counts['skipped'], 0)
    assert.ok(result.data.counts['created']! >= 2)

    const investigation = await tools.get('investigations', 'inv_1')
    assert.equal(investigation.success, true)
    if (!investigation.success) return
    assert.equal(investigation.data.record.data['title'], 'Investigação a migrar')
    assert.deepEqual(investigation.data.record.data['keywords'], ['a', 'b'])

    const evidence = await tools.get('evidence', 'evi_1')
    if (!evidence.success) return assert.fail('evidência deveria existir')
    assert.equal(evidence.data.record.data['investigationId'], 'inv_1', 'a relação sobrevive')
    // The URL was normalised on collection, so the target's uniqueOn matches.
    assert.equal(evidence.data.record.data['urlNormalized'], 'https://example.org/fonte')
  })

  it('preserves the original owner identity', async () => {
    const repos = await seedSource()
    const collected = await collectMigrationRows({ source: repos, ownerId: OWNER })
    const tools = toolsFor(OWNER)

    await migrateRecords({
      userId: OWNER,
      params: { ownerId: OWNER, rows: collected.rows, dryRun: false },
      tools,
    })

    for (const row of collected.rows) {
      const stored = await tools.get(row.collection, row.id)
      if (!stored.success) continue
      assert.equal(stored.data.record.data['ownerId'], OWNER, `${row.collection}/${row.id}`)
    }
  })
})

describe('migration action: dry run', () => {
  it('writes nothing while reporting what it would do', async () => {
    const repos = await seedSource()
    const collected = await collectMigrationRows({ source: repos, ownerId: OWNER })
    const fake = new FakeRecordRoom()
    room = fake
    const tools = createActionTools(createFakeCaller(fake, { userId: OWNER, appAction: true }))

    const result = await migrateRecords({
      userId: OWNER,
      params: { ownerId: OWNER, rows: collected.rows, dryRun: true },
      tools,
    })

    assert.equal(result.success, true)
    if (!result.success) return
    assert.equal(result.data.dryRun, true)
    assert.ok(result.data.counts['created']! >= 2, 'deve prever as gravações')

    // Decisive: the room is untouched.
    assert.equal(fake.rawCount('investigations'), 0)
    assert.equal(fake.rawCount('evidence'), 0)
  })
})

describe('migration action: idempotency', () => {
  it('a second run reports unchanged and writes nothing new', async () => {
    const repos = await seedSource()
    const collected = await collectMigrationRows({ source: repos, ownerId: OWNER })
    const fake = new FakeRecordRoom()
    room = fake
    const tools = createActionTools(createFakeCaller(fake, { userId: OWNER, appAction: true }))

    await migrateRecords({
      userId: OWNER,
      params: { ownerId: OWNER, rows: collected.rows, dryRun: false },
      tools,
    })
    const countAfterFirst = fake.rawCount('investigations')

    const second = await migrateRecords({
      userId: OWNER,
      params: { ownerId: OWNER, rows: collected.rows, dryRun: false },
      tools,
    })

    assert.equal(fake.rawCount('investigations'), countAfterFirst, 'não deve duplicar')
    if (!second.success) return assert.fail('segunda execução deveria funcionar')
    assert.equal(second.data.counts['created'], 0)
    assert.equal(second.data.counts['unchanged'], collected.rows.length)
  })
})

describe('migration action: refusals', () => {
  it('rejects a caller whose ownerId differs from the verified identity', async () => {
    const repos = await seedSource()
    const collected = await collectMigrationRows({ source: repos, ownerId: OWNER })
    const tools = toolsFor(OTHER)

    const result = await migrateRecords({
      userId: OTHER,
      params: { ownerId: OWNER, rows: collected.rows, dryRun: true },
      tools,
    })

    assert.equal(result.success, false)
    if (result.success) return
    assert.match(result.error, /próprio proprietário|userBound/i)
  })

  it('skips a row whose owner does not match', async () => {
    const repos = await seedSource()
    const collected = await collectMigrationRows({ source: repos, ownerId: OWNER })
    const tools = toolsFor(OWNER)

    const result = await migrateRecords({
      userId: OWNER,
      params: {
        ownerId: OWNER,
        rows: [
          ...collected.rows,
          { collection: 'investigations', id: 'inv_hijack', data: { ownerId: OTHER, title: 'x' } },
        ],
        dryRun: false,
      },
      tools,
    })

    assert.equal(result.success, true)
    if (!result.success) return
    assert.equal(result.data.counts['skipped'], 1)
    assert.equal(await tools.get('investigations', 'inv_hijack').then((r) => r.success), false)
  })

  it('rejects an unknown collection', async () => {
    const tools = toolsFor(OWNER)
    const result = await migrateRecords({
      userId: OWNER,
      params: {
        ownerId: OWNER,
        rows: [{ collection: 'users', id: 'u1', data: { ownerId: OWNER } }],
        dryRun: true,
      },
      tools,
    })
    assert.equal(result.success, false, 'users não é migrável')
  })

  it('rejects an oversized batch', async () => {
    const tools = toolsFor(OWNER)
    const rows = Array.from({ length: 101 }, (_, index) => ({
      collection: 'investigations',
      id: `inv_${index}`,
      data: { ownerId: OWNER },
    }))
    const result = await migrateRecords({
      userId: OWNER,
      params: { ownerId: OWNER, rows, dryRun: true },
      tools,
    })
    assert.equal(result.success, false)
  })

  it('rejects malformed rows before touching the room', async () => {
    const fake = new FakeRecordRoom()
    room = fake
    const tools = createActionTools(createFakeCaller(fake, { userId: OWNER, appAction: true }))

    for (const rows of [
      'not-an-array',
      [{ collection: 'investigations' }],
      [{ collection: 'investigations', id: '', data: {} }],
      [{ collection: 'investigations', id: 'x', data: [] }],
    ]) {
      const result = await migrateRecords({
        userId: OWNER,
        params: { ownerId: OWNER, rows, dryRun: true },
        tools,
      })
      assert.equal(result.success, false, `deveria recusar ${JSON.stringify(rows)}`)
    }
    assert.equal(fake.rawCount('investigations'), 0)
  })
})

describe('migration action: the upsert guard', () => {
  it('refuses to overwrite a row owned by someone else', async () => {
    const repos = await seedSource()
    const collected = await collectMigrationRows({ source: repos, ownerId: OWNER })
    const fake = new FakeRecordRoom()
    room = fake

    // Seed the target with another account's row under the same id. Without the
    // guard, `tools.create` (an upsert) would merge our data onto it.
    fake.seed('investigations', {
      recordId: 'inv_1',
      ownerId: OTHER,
      data: { title: 'Linha de outra conta', status: 'active' },
    })

    const tools = createActionTools(createFakeCaller(fake, { userId: OWNER, appAction: true }))
    const result = await migrateRecords({
      userId: OWNER,
      params: { ownerId: OWNER, rows: collected.rows, dryRun: false },
      tools,
    })

    assert.equal(result.success, true)
    if (!result.success) return
    assert.equal(result.data.counts['failed'], 1, 'a linha em conflito deve falhar')

    // The other account's row is untouched.
    const stored = await tools.get('investigations', 'inv_1')
    if (!stored.success) return assert.fail('linha deveria existir')
    assert.equal(stored.data.record.data['ownerId'], OTHER)
    assert.equal(stored.data.record.data['title'], 'Linha de outra conta')
  })
})

describe('migration collection', () => {
  it('collects every collection the domain persists', async () => {
    const repos = await seedSource()
    const now = new Date().toISOString()

    // Add a row in each remaining collection so the collector's coverage is
    // asserted rather than assumed.
    await repos.analyses.create({
      id: 'ana_1',
      investigationId: 'inv_1',
      ownerId: OWNER,
      evidenceIds: ['evi_1'],
      model: 'gemini-2.5-flash',
      status: 'completed',
      executiveSummary: 'Resumo',
      findings: [{ statement: 'D', evidenceIds: ['evi_1'], confidence: 'medium' }],
      keyPoints: ['p'],
      supportedClaims: ['c'],
      contradictions: [],
      limitations: ['l'],
      informationGaps: ['g'],
      objectiveAlignment: 'alinhado',
      references: [
        { evidenceId: 'evi_1', title: 'Fonte', url: 'https://example.org/fonte', domain: 'example.org' },
      ],
      insufficientEvidence: false,
      rawStructuredOutput: null,
      usage: null,
      errorMessage: null,
      createdAt: now,
    })
    await repos.validations.create({
      id: 'val_1',
      investigationId: 'inv_1',
      evidenceId: 'evi_1',
      ownerId: OWNER,
      status: 'accepted',
      previousStatus: 'pending',
      justification: 'ok',
      createdAt: now,
    })
    await repos.activity.create({
      id: 'act_1',
      investigationId: 'inv_1',
      ownerId: OWNER,
      eventType: 'evidence.added',
      description: 'adicionada',
      metadata: { count: 1 },
      createdAt: now,
    })
    await repos.usage.create({
      id: 'use_1',
      ownerId: OWNER,
      provider: 'exa',
      operation: 'research',
      status: 'success',
      quantity: 1,
      investigationId: 'inv_1',
      errorCode: null,
      metadata: {},
      createdAt: now,
    })

    const collected = await collectMigrationRows({ source: repos, ownerId: OWNER })
    const collections = new Set(collected.rows.map((row) => row.collection))

    for (const expected of [
      'investigations',
      'evidence',
      'analyses',
      'validations',
      'activity_logs',
      'usage_records',
    ]) {
      assert.ok(collections.has(expected), `a coleta deve incluir ${expected}`)
    }

    // And they all import cleanly.
    const tools = toolsFor(OWNER)
    const result = await migrateRecords({
      userId: OWNER,
      params: { ownerId: OWNER, rows: collected.rows, dryRun: false },
      tools,
    })
    assert.equal(result.success, true)
    if (!result.success) return
    assert.equal(result.data.counts['failed'], 0)
    assert.equal(result.data.counts['created'], collected.rows.length)
  })

  it('reads only the requested owner', async () => {
    const repos = await seedSource()
    await repos.investigations.create({
      id: 'inv_other',
      ownerId: OTHER,
      title: 'De outra conta',
      description: '',
      objective: 'Objetivo de outra conta que não deve aparecer na coleta',
      topic: 'x',
      keywords: [],
      status: 'draft',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    const collected = await collectMigrationRows({ source: repos, ownerId: OWNER })
    assert.ok(!collected.rows.some((row) => row.id === 'inv_other'))
    assert.ok(collected.rows.every((row) => row.data['ownerId'] === OWNER || row.collection === 'analyses'))
  })

  it('normalises URLs so the target uniqueness constraint matches', async () => {
    assert.equal(
      normalizeUrlForMigration('https://EXAMPLE.org/path/?utm_source=x&gclid=1#frag'),
      'https://example.org/path',
    )
  })

  it('never mutates the source', async () => {
    const repos = await seedSource()
    const before = await repos.investigations.findById('inv_1')
    await collectMigrationRows({ source: repos, ownerId: OWNER })
    const after = await repos.investigations.findById('inv_1')
    assert.deepEqual(after, before)
  })
})
