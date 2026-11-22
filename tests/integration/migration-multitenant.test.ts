import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { migrateRecords } from '../../server/actions/migrate-records.ts'
import { createActions } from '../../server/actions/index.ts'
import { createActionTools } from '../../server/http/action-routes.ts'
import { FakeRecordRoom, createFakeCaller } from '../../server/repositories/records/fake-room.ts'
import type { ActionToolsPort } from '../../server/actions/types.ts'

/**
 * Multi-tenant authorization for the migration action (v0.2.3).
 *
 * Two data owners (A and B) and an app owner distinct from both. The suite
 * proves the property the v0.2.2 gate broke: **each owner can migrate their own
 * data, and only their own** — without being the app owner.
 *
 * Everything here runs against the `FakeRecordRoom`, which implements
 * `userBound`/`immutable` with the documented semantics. It is a contract
 * double, not the SDK binary; see docs/testing.md §9.
 */

const USER_A = 'user_a'
const USER_B = 'user_b'
const APP_OWNER = 'user_app_owner'

let room: FakeRecordRoom | null = null

afterEach(() => {
  room?.close()
  room = null
})

/** A fresh room bound to a caller, for tests that need a clean target. */
function freshTools(callerId: string): ActionToolsPort {
  room = new FakeRecordRoom()
  return createActionTools(createFakeCaller(room, { userId: callerId, appAction: true }))
}function investigationRow(id: string, ownerId: string, title: string) {
  return {
    collection: 'investigations',
    id,
    data: {
      ownerId,
      title,
      description: '',
      objective: 'Objetivo suficientemente longo para satisfazer o schema da coleção',
      topic: 'migração',
      keywords: ['a'],
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  }
}

describe('each owner migrates their own data', () => {
  it('A migrates A\'s rows and they land owned by A', async () => {
    const tools = freshTools(USER_A)
    const result = await migrateRecords({
      userId: USER_A,
      params: { ownerId: USER_A, rows: [investigationRow('inv_a1', USER_A, 'De A')], dryRun: false },
      tools,
    })

    assert.equal(result.success, true)
    if (!result.success) return
    assert.equal(result.data.counts['created'], 1)

    const stored = await tools.get('investigations', 'inv_a1')
    assert.equal(stored.success, true)
    if (!stored.success) return
    assert.equal(stored.data.record.data['ownerId'], USER_A)
  })

  it('B migrates B\'s rows in the same room, and A\'s row is untouched', async () => {
    // Same target room, two sequential owners — the real deployment shape.
    const toolsA = freshTools(USER_A)
    await migrateRecords({
      userId: USER_A,
      params: { ownerId: USER_A, rows: [investigationRow('inv_a1', USER_A, 'De A')], dryRun: false },
      tools: toolsA,
    })

    const toolsB = createActionTools(createFakeCaller(room!, { userId: USER_B, appAction: true }))
    const resultB = await migrateRecords({
      userId: USER_B,
      params: { ownerId: USER_B, rows: [investigationRow('inv_b1', USER_B, 'De B')], dryRun: false },
      tools: toolsB,
    })
    assert.equal(resultB.success, true)
    if (!resultB.success) return
    assert.equal(resultB.data.counts['created'], 1)

    // B's row exists and belongs to B.
    const storedB = await toolsB.get('investigations', 'inv_b1')
    if (!storedB.success) return assert.fail('a linha de B deveria existir')
    assert.equal(storedB.data.record.data['ownerId'], USER_B)

    // A's row is still A's, unchanged.
    const storedA = await toolsB.get('investigations', 'inv_a1')
    if (!storedA.success) return assert.fail('a linha de A deveria existir')
    assert.equal(storedA.data.record.data['ownerId'], USER_A)
    assert.equal(storedA.data.record.data['title'], 'De A')
  })

  it('works with OWNER_USER_ID absent — the action does not depend on it', async () => {
    // This is the contradiction: v0.2.2 required the app owner, so a deployment
    // without that anchor made migration impossible for everyone.
    const actions = createActions({})
    const tools = freshTools(USER_A)
    const result = await actions['migrateRecords']!({
      userId: USER_A,
      params: { ownerId: USER_A, rows: [investigationRow('inv_a1', USER_A, 'De A')], dryRun: true },
      tools,
    })
    assert.equal(result.success, true)
  })
})

describe('cross-account migration is refused', () => {
  it('A cannot migrate B\'s data', async () => {
    const tools = freshTools(USER_A)
    const result = await migrateRecords({
      userId: USER_A,
      params: { ownerId: USER_B, rows: [investigationRow('inv_b1', USER_B, 'De B')], dryRun: false },
      tools,
    })
    assert.equal(result.success, false)
    if (result.success) return
    assert.equal(result.code, 'forbidden')
  })

  it('B cannot migrate A\'s data', async () => {
    const tools = freshTools(USER_B)
    const result = await migrateRecords({
      userId: USER_B,
      params: { ownerId: USER_A, rows: [investigationRow('inv_a1', USER_A, 'De A')], dryRun: false },
      tools,
    })
    assert.equal(result.success, false)
    if (result.success) return
    assert.equal(result.code, 'forbidden')
  })

  it('the app owner cannot migrate another user\'s data either', async () => {
    // Being the app owner must not become a master key over user data.
    const tools = freshTools(APP_OWNER)
    const result = await migrateRecords({
      userId: APP_OWNER,
      params: { ownerId: USER_A, rows: [investigationRow('inv_a1', USER_A, 'De A')], dryRun: false },
      tools,
    })
    assert.equal(result.success, false)
    if (result.success) return
    assert.equal(result.code, 'forbidden')
  })

  it('a row whose payload names another owner is skipped, not written', async () => {
    // Batch declares ownerId A (matching the caller) but one row claims B.
    const tools = freshTools(USER_A)
    const result = await migrateRecords({
      userId: USER_A,
      params: {
        ownerId: USER_A,
        rows: [investigationRow('inv_a1', USER_A, 'De A'), investigationRow('inv_hijack', USER_B, 'Forjada')],
        dryRun: false,
      },
      tools,
    })
    assert.equal(result.success, true)
    if (!result.success) return
    assert.equal(result.data.counts['skipped'], 1)

    const hijack = await tools.get('investigations', 'inv_hijack')
    assert.equal(hijack.success, false, 'a linha forjada não pode ter sido gravada')
  })

  it('does not overwrite an existing row owned by someone else', async () => {
    const tools = freshTools(USER_A)
    // Seed the target with B's row under the id A is about to import.
    room!.seed('investigations', {
      recordId: 'inv_a1',
      ownerId: USER_B,
      data: { title: 'Linha de B', status: 'active' },
    })

    const result = await migrateRecords({
      userId: USER_A,
      params: { ownerId: USER_A, rows: [investigationRow('inv_a1', USER_A, 'De A')], dryRun: false },
      tools,
    })
    assert.equal(result.success, true)
    if (!result.success) return
    assert.equal(result.data.counts['failed'], 1)

    const stored = await tools.get('investigations', 'inv_a1')
    if (!stored.success) return assert.fail('a linha de B deveria existir')
    assert.equal(stored.data.record.data['ownerId'], USER_B)
    assert.equal(stored.data.record.data['title'], 'Linha de B')
  })
})

describe('userBound still governs the write identity', () => {
  it('cannot create a row owned by another account, even if the payload says so', async () => {
    // The action refuses first (see above), but `userBound` is the second lock:
    // this asserts the storage layer itself never honours a forged ownerId.
    const tools = freshTools(USER_A)
    const created = await tools.create('investigations', {
      ownerId: USER_B,
      title: 'Tentativa de posse forjada',
      objective: 'Objetivo suficientemente longo para satisfazer o schema da coleção',
      topic: 'x',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    assert.equal(created.success, true)
    if (!created.success) return
    const stored = await tools.get('investigations', created.data.recordId)
    if (!stored.success) return assert.fail('a linha deveria existir')
    assert.equal(stored.data.record.data['ownerId'], USER_A, 'userBound carimba o chamador, não o payload')
  })

  it('preserves the stored owner when the owner is sent unchanged', async () => {
    const tools = freshTools(USER_A)
    const created = await tools.create('investigations', {
      ownerId: USER_A,
      title: 'Original',
      objective: 'Objetivo suficientemente longo para satisfazer o schema da coleção',
      topic: 'x',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    if (!created.success) return assert.fail('criação deveria funcionar')

    // Re-sending the same owner is allowed (`immutable` refuses a *change*, not
    // a restatement), so an update can carry the full row like the migration does.
    await tools.update('investigations', created.data.recordId, {
      ownerId: USER_A,
      title: 'Alterado',
    })

    const stored = await tools.get('investigations', created.data.recordId)
    if (!stored.success) return assert.fail('a linha deveria existir')
    assert.equal(stored.data.record.data['ownerId'], USER_A)
    assert.equal(stored.data.record.data['title'], 'Alterado')
  })

  it('refuses an update that tries to change the owner', async () => {
    const tools = freshTools(USER_A)
    const created = await tools.create('investigations', {
      ownerId: USER_A,
      title: 'Original',
      objective: 'Objetivo suficientemente longo para satisfazer o schema da coleção',
      topic: 'x',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    if (!created.success) return assert.fail('criação deveria funcionar')

    const attempt = await tools.update('investigations', created.data.recordId, {
      ownerId: USER_B,
      title: 'Sequestrada',
    })
    // `immutable` rejects the whole update, so the title does not land either.
    assert.equal(attempt.success, false)
    if (attempt.success) return
    assert.match(attempt.error, /immutable|ownerId/i)

    const stored = await tools.get('investigations', created.data.recordId)
    if (!stored.success) return assert.fail('a linha deveria existir')
    assert.equal(stored.data.record.data['ownerId'], USER_A)
    assert.equal(stored.data.record.data['title'], 'Original', 'o update rejeitado não altera nada')
  })
})

describe('idempotency and dry-run survive the new authorization', () => {
  it('a second run by the same owner writes nothing', async () => {
    const tools = freshTools(USER_A)
    const rows = [investigationRow('inv_a1', USER_A, 'De A')]

    await migrateRecords({ userId: USER_A, params: { ownerId: USER_A, rows, dryRun: false }, tools })
    const second = await migrateRecords({ userId: USER_A, params: { ownerId: USER_A, rows, dryRun: false }, tools })

    assert.equal(second.success, true)
    if (!second.success) return
    assert.equal(second.data.counts['updated'], 0)
    assert.equal(second.data.counts['created'], 0)
    assert.equal(second.data.counts['unchanged'], 1)
  })

  it('dry-run writes nothing for an authorized owner', async () => {
    const tools = freshTools(USER_A)
    const result = await migrateRecords({
      userId: USER_A,
      params: { ownerId: USER_A, rows: [investigationRow('inv_a1', USER_A, 'De A')], dryRun: true },
      tools,
    })
    assert.equal(result.success, true)
    if (!result.success) return
    assert.equal(result.data.counts['created'], 1, 'deve prever')
    assert.equal(room!.rawCount('investigations'), 0, 'não deve gravar')
  })

  it('dry-run is refused for a cross-account attempt too, before anything is read', async () => {
    const tools = freshTools(USER_A)
    const result = await migrateRecords({
      userId: USER_A,
      params: { ownerId: USER_B, rows: [investigationRow('inv_b1', USER_B, 'De B')], dryRun: true },
      tools,
    })
    assert.equal(result.success, false)
    // Even in dry-run, the refusal happens before any tool call reaches the room.
    assert.equal(room!.rawCount('investigations'), 0)
  })
})
