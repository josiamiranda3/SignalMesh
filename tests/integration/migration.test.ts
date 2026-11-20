import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { openDatabase } from '../../server/db.ts'
import { createSqliteRepositories } from '../../server/repositories/sqlite.ts'
import { FakeRecordRoom, createFakeCaller } from '../../server/repositories/records/fake-room.ts'
import { createRecordStore, createTransport } from '../../server/repositories/records/transport.ts'
import { migrateToRecords, formatMigrationReport } from '../../server/migration/records.ts'
import type { Investigation } from '../../shared/domain.ts'

/**
 * Data migration.
 *
 * Verifies the properties an operator depends on before switching a real
 * account over: everything arrives, ids and relations survive, a re-run is
 * idempotent, a dry run writes nothing, and the source is never modified.
 */

const OWNER = 'user_migrate'

function seedInvestigation(overrides: Partial<Investigation> = {}): Investigation {
  const now = new Date().toISOString()
  return {
    id: 'inv_migrate_1',
    ownerId: OWNER,
    title: 'Investigação a migrar',
    description: 'Descrição',
    objective: 'Objetivo que precisa sobreviver à migração intacto',
    topic: 'tema de migração',
    keywords: ['um', 'dois'],
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

async function seedSource() {
  const db = openDatabase(':memory:')
  const repos = createSqliteRepositories(db)

  await repos.users.upsert({
    id: OWNER,
    email: 'migrate@example.com',
    name: 'Migração',
    avatarUrl: null,
    createdAt: new Date().toISOString(),
  })

  await repos.investigations.create(seedInvestigation())
  const now = new Date().toISOString()

  await repos.evidence.create({
    id: 'evi_migrate_1',
    investigationId: 'inv_migrate_1',
    ownerId: OWNER,
    title: 'Fonte migrada',
    url: 'https://example.org/fonte?utm_source=newsletter',
    domain: 'example.org',
    snippet: 'trecho',
    retrievedContent: 'conteúdo',
    publishedAt: '2024-05-01T00:00:00.000Z',
    author: 'Autor',
    collectedAt: now,
    source: 'exa',
    sourceMetadata: { providerRequestId: 'req_x' },
    contentAvailability: ['text'],
    relevanceScore: 0.64,
    relevanceBreakdown: {
      topical: 0.6,
      recency: 0.7,
      sourceQuality: 0.6,
      objectiveAlignment: 0.5,
      rationale: ['motivo'],
      weights: { topical: 0.4, recency: 0.25, sourceQuality: 0.25, objectiveAlignment: 0.1 },
      missing: [],
    },
    validationStatus: 'accepted',
    note: 'nota migrada',
    createdAt: now,
    updatedAt: now,
  })

  await repos.analyses.create({
    id: 'ana_migrate_1',
    investigationId: 'inv_migrate_1',
    ownerId: OWNER,
    evidenceIds: ['evi_migrate_1'],
    model: 'gemini-2.5-flash',
    status: 'completed',
    executiveSummary: 'Resumo migrado',
    findings: [{ statement: 'Descoberta', evidenceIds: ['evi_migrate_1'], confidence: 'medium' }],
    keyPoints: ['ponto'],
    supportedClaims: ['claim'],
    contradictions: [],
    limitations: ['limitação'],
    informationGaps: ['lacuna'],
    objectiveAlignment: 'alinhado',
    references: [
      { evidenceId: 'evi_migrate_1', title: 'Fonte migrada', url: 'https://example.org/fonte', domain: 'example.org' },
    ],
    insufficientEvidence: false,
    rawStructuredOutput: { ok: true },
    usage: { promptTokens: 10, candidateTokens: 5, totalTokens: 15 },
    errorMessage: null,
    createdAt: now,
  })

  await repos.validations.create({
    id: 'val_migrate_1',
    investigationId: 'inv_migrate_1',
    evidenceId: 'evi_migrate_1',
    ownerId: OWNER,
    status: 'accepted',
    previousStatus: 'pending',
    justification: 'justificativa migrada',
    createdAt: now,
  })

  await repos.activity.create({
    id: 'act_migrate_1',
    investigationId: 'inv_migrate_1',
    ownerId: OWNER,
    eventType: 'evidence.added',
    description: 'Evidência adicionada',
    metadata: { count: 1 },
    createdAt: now,
  })

  await repos.usage.create({
    id: 'use_migrate_1',
    ownerId: OWNER,
    provider: 'exa',
    operation: 'research',
    status: 'success',
    quantity: 1,
    investigationId: 'inv_migrate_1',
    errorCode: null,
    metadata: { query: 'x' },
    createdAt: now,
  })

  return { db, repos }
}

describe('migration to Records', () => {
  it('copies every collection, preserving ids and relations', async () => {
    const { db, repos } = await seedSource()
    const room = new FakeRecordRoom()
    // The migration writes as app code: it must be able to store rows on behalf
    // of their original owners. That is why it runs as an operator CLI and not
    // through a member transport.
    const store = createRecordStore(
      createTransport(createFakeCaller(room, { userId: OWNER, appAction: true })),
    )

    const report = await migrateToRecords({ source: repos, target: store, ownerId: OWNER })

    assert.equal(report.collections['investigations']!.created, 1)
    assert.equal(report.collections['evidence']!.created, 1)
    assert.equal(report.collections['analyses']!.created, 1)
    assert.equal(report.collections['validations']!.created, 1)
    assert.equal(report.collections['activity_logs']!.created, 1)
    assert.equal(report.collections['usage_records']!.created, 1)
    assert.equal(report.errors.length, 0)

    // The row is reachable by its original id.
    const investigation = await store.get('investigations', 'inv_migrate_1')
    assert.ok(investigation)
    assert.equal(investigation.data['title'], 'Investigação a migrar')
    assert.deepEqual(investigation.data['keywords'], ['um', 'dois'])
    assert.equal(investigation.data['ownerId'], OWNER)

    const evidence = await store.get('evidence', 'evi_migrate_1')
    assert.ok(evidence)
    assert.equal(evidence.data['investigationId'], 'inv_migrate_1')
    assert.equal(evidence.data['validationStatus'], 'accepted')
    assert.equal(evidence.data['note'], 'nota migrada')
    assert.deepEqual(evidence.data['contentAvailability'], ['text'])

    const analysis = await store.get('analyses', 'ana_migrate_1')
    assert.ok(analysis)
    assert.deepEqual(analysis.data['referenceIds'], ['evi_migrate_1'])
    assert.deepEqual(analysis.data['evidenceIds'], ['evi_migrate_1'])

    const validation = await store.get('validations', 'val_migrate_1')
    assert.equal(validation?.data['previousStatus'], 'pending')
    assert.equal(validation?.data['justification'], 'justificativa migrada')

    room.close()
    db.close()
  })

  it('normalises imported URLs so duplicate detection agrees afterwards', async () => {
    const { db, repos } = await seedSource()
    const room = new FakeRecordRoom()
    const store = createRecordStore(
      createTransport(createFakeCaller(room, { userId: OWNER, appAction: true })),
    )

    await migrateToRecords({ source: repos, target: store, ownerId: OWNER })

    const evidence = await store.get('evidence', 'evi_migrate_1')
    // The stored normalised URL has no tracking parameter, so a second add of the
    // same source with a different campaign tag is recognised as a duplicate.
    assert.equal(evidence?.data['urlNormalized'], 'https://example.org/fonte')

    room.close()
    db.close()
  })

  it('is idempotent: a second run changes nothing', async () => {
    const { db, repos } = await seedSource()
    const room = new FakeRecordRoom()
    const store = createRecordStore(
      createTransport(createFakeCaller(room, { userId: OWNER, appAction: true })),
    )

    await migrateToRecords({ source: repos, target: store, ownerId: OWNER })
    const roomRowsAfterFirst = room.rawCount('investigations')

    const second = await migrateToRecords({ source: repos, target: store, ownerId: OWNER })
    assert.equal(room.rawCount('investigations'), roomRowsAfterFirst, 'não deve duplicar')
    assert.equal(second.collections['investigations']!.created, 0)
    assert.equal(second.collections['investigations']!.unchanged, 1)

    room.close()
    db.close()
  })

  it('writes nothing in dry-run mode', async () => {
    const { db, repos } = await seedSource()
    const room = new FakeRecordRoom()
    const store = createRecordStore(
      createTransport(createFakeCaller(room, { userId: OWNER, appAction: true })),
    )

    const report = await migrateToRecords({ source: repos, target: store, ownerId: OWNER, dryRun: true })
    assert.equal(report.dryRun, true)
    assert.equal(report.collections['investigations']!.created, 1, 'o relatório deve prever a gravação')
    assert.equal(room.rawCount('investigations'), 0, 'nada pode ter sido gravado')

    room.close()
    db.close()
  })

  it('leaves the source database untouched', async () => {
    const { db, repos } = await seedSource()
    const room = new FakeRecordRoom()
    const store = createRecordStore(
      createTransport(createFakeCaller(room, { userId: OWNER, appAction: true })),
    )

    await migrateToRecords({ source: repos, target: store, ownerId: OWNER })

    const stillThere = await repos.investigations.findById('inv_migrate_1')
    assert.ok(stillThere, 'a origem não pode ser apagada pela migração')
    const stillEvidence = await repos.evidence.listByInvestigation('inv_migrate_1')
    assert.equal(stillEvidence.length, 1)

    room.close()
    db.close()
  })

  it('migrates only the requested owner', async () => {
    const { db, repos } = await seedSource()
    await repos.users.upsert({
      id: 'user_other_owner',
      email: 'other@example.com',
      name: 'Outro',
      avatarUrl: null,
      createdAt: new Date().toISOString(),
    })
    await repos.investigations.create(seedInvestigation({ id: 'inv_other', ownerId: 'user_other_owner' }))

    const room = new FakeRecordRoom()
    const store = createRecordStore(
      createTransport(createFakeCaller(room, { userId: OWNER, appAction: true })),
    )

    await migrateToRecords({ source: repos, target: store, ownerId: OWNER })

    assert.ok(await store.get('investigations', 'inv_migrate_1'))
    assert.equal(await store.get('investigations', 'inv_other'), null, 'não deve migrar outro dono')

    room.close()
    db.close()
  })

  it('produces a readable report', async () => {
    const { db, repos } = await seedSource()
    const room = new FakeRecordRoom()
    const store = createRecordStore(
      createTransport(createFakeCaller(room, { userId: OWNER, appAction: true })),
    )

    const report = await migrateToRecords({ source: repos, target: store, ownerId: OWNER })
    const text = formatMigrationReport(report)

    assert.match(text, /investigations/)
    assert.match(text, /Total:/)
    assert.ok(!text.includes('Falhas:'), 'não deve haver seção de falhas numa migração limpa')

    room.close()
    db.close()
  })
})
