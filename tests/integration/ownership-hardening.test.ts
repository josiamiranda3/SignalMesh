import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { lintSchemas } from 'deepspace/worker'
import { schemas, COLLECTIONS } from '../../src/schemas.ts'
import { FakeRecordRoom, createFakeCaller, type FakeCaller } from '../../server/repositories/records/fake-room.ts'
import { createRecordStore, createTransport, RecordsError } from '../../server/repositories/records/transport.ts'

/**
 * Ownership hardening.
 *
 * These tests exist because of a specific failure mode the SDK documents:
 * an `ownerField` column that is not `userBound` lets a member create a row
 * carrying *someone else's* id, and the row then passes the `'own'` check for
 * that other person. The fix is `userBound: true` plus `immutable: true` on
 * `ownerId`, and this suite proves the fix holds at the storage layer.
 *
 * The fake room implements `userBound`/`immutable` with the same semantics as
 * `putRecord`, so a regression in the schema (removing either flag) fails here.
 * It is not a substitute for exercising the real Durable Object; see
 * docs/testing.md §9.
 */

const ALICE = 'user_alice'
const BOB = 'user_bob'

let room: FakeRecordRoom | null = null

afterEach(() => {
  room?.close()
  room = null
})

function makeRoom(): FakeRecordRoom {
  room = new FakeRecordRoom()
  return room
}

function storeFor(fake: FakeRecordRoom, caller: FakeCaller) {
  return createRecordStore(createTransport(createFakeCaller(fake, caller)))
}

function investigationRow(ownerId: string, overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString()
  return {
    ownerId,
    title: 'Investigação',
    description: '',
    objective: 'Objetivo válido para o teste de posse',
    topic: 'tema',
    keywords: [],
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

describe('schema ownership declarations', () => {
  it('the SDK lint reports no schema warnings', () => {
    const warnings = lintSchemas(schemas)
    assert.deepEqual(warnings, [], `avisos do SDK:\n${warnings.join('\n')}`)
  })

  it('every domain ownerId is userBound and immutable', () => {
    for (const schema of schemas) {
      if (schema.name === 'users') continue
      const ownerColumn = schema.columns.find((column) => column.name === schema.ownerField)
      assert.ok(ownerColumn, `${schema.name} não declara a coluna de posse`)
      assert.equal(ownerColumn.storage, 'text', `${schema.name}: userBound exige storage 'text'`)
      assert.equal(ownerColumn.userBound, true, `${schema.name}: ownerId precisa ser userBound`)
      assert.equal(ownerColumn.immutable, true, `${schema.name}: ownerId precisa ser immutable`)
    }
  })

  it('does not mark any non-owner column userBound', () => {
    for (const schema of schemas) {
      for (const column of schema.columns) {
        if (column.userBound && column.name !== schema.ownerField) {
          // A userBound column is stamped with the caller id; only the owner
          // column should ever mean that.
          assert.fail(`${schema.name}.${column.name} é userBound sem ser a coluna de posse`)
        }
      }
    }
  })
})

describe('owner spoofing is neutralised on create', () => {
  it('stamps the caller id even when the payload names another user', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })

    // Alice tries to create a row owned by Bob.
    const id = await alice.create(COLLECTIONS.investigations, investigationRow(BOB, { title: 'Forjada' }))

    const stored = await alice.get(COLLECTIONS.investigations, id)
    assert.ok(stored)
    assert.equal(
      stored.data['ownerId'],
      ALICE,
      'ownerId deve ser carimbado com a identidade do chamador, não com o valor do payload',
    )
  })

  it('leaves Bob unable to read a row Alice created while spoofing his id', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })
    const id = await alice.create(COLLECTIONS.investigations, investigationRow(BOB))

    const bob = storeFor(fake, { userId: BOB, appAction: false })
    assert.equal(await bob.get(COLLECTIONS.investigations, id), null)
    assert.equal((await bob.query(COLLECTIONS.investigations)).records.length, 0)
  })

  it('applies the same stamping to every domain collection', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })
    const now = new Date().toISOString()

    const rows: Array<[string, Record<string, unknown>]> = [
      [COLLECTIONS.evidence, {
        investigationId: 'inv_x',
        ownerId: BOB,
        title: 'Fonte',
        url: 'https://example.org/a',
        urlNormalized: 'https://example.org/a',
        domain: 'example.org',
        snippet: '',
        retrievedContent: null,
        publishedAt: null,
        author: null,
        collectedAt: now,
        source: 'exa',
        sourceMetadata: {},
        contentAvailability: [],
        relevanceScore: 0.5,
        relevanceBreakdown: null,
        validationStatus: 'pending',
        note: '',
        createdAt: now,
        updatedAt: now,
      }],
      [COLLECTIONS.validations, {
        investigationId: 'inv_x',
        evidenceId: 'evi_x',
        ownerId: BOB,
        status: 'accepted',
        previousStatus: 'pending',
        justification: 'x',
        createdAt: now,
      }],
      [COLLECTIONS.usageRecords, {
        ownerId: BOB,
        provider: 'exa',
        operation: 'research',
        status: 'success',
        quantity: 1,
        investigationId: null,
        errorCode: null,
        metadata: {},
        createdAt: now,
      }],
      [COLLECTIONS.appSettings, {
        ownerId: BOB,
        key: 'k',
        value: 'v',
      }],
    ]

    for (const [collection, data] of rows) {
      const id = await alice.create(collection, data)
      const stored = await alice.get(collection, id)
      assert.equal(
        stored?.data['ownerId'],
        ALICE,
        `${collection}: ownerId deveria ser carimbado com ${ALICE}`,
      )
    }
  })
})

describe('ownerId cannot be reassigned on update', () => {
  it('refuses an update that changes ownerId', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })
    const id = await alice.create(COLLECTIONS.investigations, investigationRow(ALICE))

    await assert.rejects(
      () => alice.update(COLLECTIONS.investigations, id, { ownerId: BOB }),
      (error: unknown) => {
        assert.ok(error instanceof RecordsError)
        assert.equal(error.code, 'invalid')
        assert.match(error.message, /immutable/i)
        return true
      },
    )

    const stored = await alice.get(COLLECTIONS.investigations, id)
    assert.equal(stored?.data['ownerId'], ALICE)
  })

  it('accepts an update that sends the same ownerId back', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })
    const id = await alice.create(COLLECTIONS.investigations, investigationRow(ALICE))

    // Idempotent re-send is not a change and must not be rejected.
    await alice.update(COLLECTIONS.investigations, id, { ownerId: ALICE, title: 'Renomeada' })
    const stored = await alice.get(COLLECTIONS.investigations, id)
    assert.equal(stored?.data['title'], 'Renomeada')
    assert.equal(stored?.data['ownerId'], ALICE)
  })

  it('a full record write from the adapter cannot move ownership', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })
    const id = await alice.create(COLLECTIONS.investigations, investigationRow(ALICE))

    // The repository always re-sends `ownerId` with the current value; it must
    // not be able to escalate even if the domain object were tampered with.
    await assert.rejects(
      () =>
        alice.update(COLLECTIONS.investigations, id, {
          title: 'Tentativa',
          ownerId: BOB,
          status: 'completed',
        }),
      (error: unknown) => error instanceof RecordsError,
    )
  })
})

describe('administrative path', () => {
  it('still stamps the administrative identity, not the payload', async () => {
    // Even with `X-App-Action`, `userBound` is not bypassed: the owner column is
    // stamped from the transport identity. The migration relies on this and
    // therefore runs once per owner, as its own identity.
    const fake = makeRoom()
    const admin = storeFor(fake, { userId: ALICE, appAction: true })

    const id = await admin.create(COLLECTIONS.investigations, investigationRow(BOB))
    const stored = await admin.get(COLLECTIONS.investigations, id)
    assert.equal(stored?.data['ownerId'], ALICE)
  })

  it('can read across owners (needed for the global usage aggregate)', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })
    const bob = storeFor(fake, { userId: BOB, appAction: false })
    const now = new Date().toISOString()
    const usage = {
      provider: 'exa',
      operation: 'research',
      status: 'success',
      quantity: 1,
      investigationId: null,
      errorCode: null,
      metadata: {},
      createdAt: now,
    }

    await alice.create(COLLECTIONS.usageRecords, { ...usage, ownerId: ALICE })
    await bob.create(COLLECTIONS.usageRecords, { ...usage, ownerId: BOB })

    const admin = storeFor(fake, { userId: 'owner_of_app', appAction: true })
    assert.equal((await admin.query(COLLECTIONS.usageRecords)).records.length, 2)

    // A member still sees only their own.
    assert.equal((await alice.query(COLLECTIONS.usageRecords)).records.length, 1)
    assert.equal((await bob.query(COLLECTIONS.usageRecords)).records.length, 1)
  })

  it('does not let a member use the admin path by claiming a header', async () => {
    // The transport selects `appAction` server-side; there is no request field a
    // client could set. This asserts the store built for a member never escalates.
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })
    const bob = storeFor(fake, { userId: BOB, appAction: false })

    await bob.create(COLLECTIONS.investigations, investigationRow(BOB))

    // Alice cannot enumerate Bob's rows through any store call.
    assert.equal((await alice.query(COLLECTIONS.investigations)).records.length, 0)
    assert.equal(await alice.count(COLLECTIONS.investigations), 0)
  })
})

describe('ledger tampering', () => {
  it('members cannot update or delete usage records', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })
    const now = new Date().toISOString()

    const id = await alice.create(COLLECTIONS.usageRecords, {
      ownerId: ALICE,
      provider: 'exa',
      operation: 'research',
      status: 'success',
      quantity: 1,
      investigationId: null,
      errorCode: null,
      metadata: {},
      createdAt: now,
    })

    await assert.rejects(
      () => alice.update(COLLECTIONS.usageRecords, id, { status: 'blocked' }),
      (error: unknown) => error instanceof RecordsError && error.code === 'denied',
    )
    await assert.rejects(
      () => alice.remove(COLLECTIONS.usageRecords, id),
      (error: unknown) => error instanceof RecordsError && error.code === 'denied',
    )
  })

  it('members cannot update or delete activity entries', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })

    const id = await alice.create(COLLECTIONS.activityLogs, {
      investigationId: null,
      ownerId: ALICE,
      eventType: 'investigation.created',
      description: 'criada',
      metadata: {},
      createdAt: new Date().toISOString(),
    })

    await assert.rejects(
      () => alice.update(COLLECTIONS.activityLogs, id, { description: 'reescrito' }),
      (error: unknown) => error instanceof RecordsError && error.code === 'denied',
    )
    await assert.rejects(
      () => alice.remove(COLLECTIONS.activityLogs, id),
      (error: unknown) => error instanceof RecordsError && error.code === 'denied',
    )
  })
})

describe('pagination and errors', () => {
  it('pages deterministically without leaking other owners between pages', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })
    const bob = storeFor(fake, { userId: BOB, appAction: false })

    for (let index = 0; index < 5; index += 1) {
      await alice.create(COLLECTIONS.investigations, investigationRow(ALICE, { title: `A${index}` }))
      await bob.create(COLLECTIONS.investigations, investigationRow(BOB, { title: `B${index}` }))
    }

    const collected: string[] = []
    let offset = 0
    for (;;) {
      const page = await alice.query(COLLECTIONS.investigations, { limit: 2, offset })
      for (const record of page.records) {
        assert.equal(record.data['ownerId'], ALICE)
        collected.push(String(record.data['title']))
      }
      if (page.nextOffset === undefined) break
      offset = page.nextOffset
    }

    assert.equal(collected.length, 5, 'deve paginar por todas as linhas do dono, e só delas')
    assert.equal(new Set(collected).size, 5, 'nenhuma linha repetida entre páginas')
  })

  it('surfaces a not-found error for a missing record', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })

    // The store maps "not found" to null rather than throwing.
    assert.equal(await alice.get(COLLECTIONS.investigations, 'inv_inexistente'), null)

    await assert.rejects(
      () => alice.update(COLLECTIONS.investigations, 'inv_inexistente', { title: 'x' }),
      (error: unknown) => error instanceof RecordsError && error.code === 'not_found',
    )
  })

  it('rejects an unknown collection with a schema error', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })

    await assert.rejects(
      () => alice.query('colecao_inexistente'),
      (error: unknown) => error instanceof RecordsError && error.code === 'schema',
    )
  })

  it('rejects a where clause naming a field that does not exist', async () => {
    const fake = makeRoom()
    const alice = storeFor(fake, { userId: ALICE, appAction: false })

    await assert.rejects(
      () => alice.query(COLLECTIONS.investigations, { where: { campoFantasma: 1 } }),
      (error: unknown) => error instanceof RecordsError,
    )
  })
})
