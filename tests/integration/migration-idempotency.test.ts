import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  sameContent,
  deepEqual,
  migrateRecords,
} from '../../server/actions/migrate-records.ts'
import { FakeRecordRoom, createFakeCaller } from '../../server/repositories/records/fake-room.ts'
import { createActionTools } from '../../server/http/action-routes.ts'

/**
 * Idempotency semantics.
 *
 * The comparison decides whether a re-run rewrites a row. It must therefore be
 * driven by the *column definitions*, not by whatever keys the storage happens
 * to return — otherwise a storage that materialises optional columns as `null`
 * makes every run report `updated` forever, which is idempotent in name only.
 *
 * These tests are unit-level on purpose: they pin the rule for each column
 * interpretation without depending on the fake's storage format.
 *
 * ## Limitation, stated explicitly
 *
 * Passing here proves the comparison's own rules. It does **not** prove that the
 * real Durable Object returns values in the shapes assumed below: that requires
 * the platform runtime, which this environment cannot start (see
 * docs/testing.md §6.2 and §9). The fake room is a contract double, not the SDK.
 */

const OWNER = 'user_owner'

describe('sameContent: storage-generated columns', () => {
  it('ignores a storage timestamp present only in the stored row', () => {
    const stored = { ownerId: OWNER, title: 'T', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' }
    const incoming = { ownerId: OWNER, title: 'T' }
    assert.equal(sameContent('investigations', stored, incoming), true)
  })

  it('ignores envelope columns when the payload carries them unchanged', () => {
    const stored = { ownerId: OWNER, title: 'T', createdAt: '2026-01-01', _row_id: 'x' }
    const incoming = { ownerId: OWNER, title: 'T', createdAt: '2026-01-01' }
    assert.equal(sameContent('investigations', stored, incoming), true)
  })

  it('still notices a real domain change alongside a timestamp difference', () => {
    const stored = { ownerId: OWNER, title: 'A', updatedAt: 't2' }
    const incoming = { ownerId: OWNER, title: 'B' }
    assert.equal(sameContent('investigations', stored, incoming), false)
  })
})

describe('sameContent: optional columns the storage filled in', () => {
  it('does not treat a null the payload omitted as a change', () => {
    // A storage that materialises an optional column as null while the payload
    // omits it must not make every run an update.
    const stored = { ownerId: OWNER, title: 'T', description: null, topic: 'x' }
    const incoming = { ownerId: OWNER, title: 'T', topic: 'x' }
    assert.equal(sameContent('investigations', stored, incoming), true)
  })

  it('treats an explicit null in the payload as equal to a stored null', () => {
    const stored = { ownerId: OWNER, title: 'T', description: null }
    const incoming = { ownerId: OWNER, title: 'T', description: null }
    assert.equal(sameContent('investigations', stored, incoming), true)
  })

  it('notices when the payload asserts a value the stored row lacks', () => {
    const stored = { ownerId: OWNER, title: 'T', description: null }
    const incoming = { ownerId: OWNER, title: 'T', description: 'nova descrição' }
    assert.equal(sameContent('investigations', stored, incoming), false)
  })
})

describe('sameContent: JSON columns', () => {
  it('compares arrays by value, not by identity', () => {
    const stored = { ownerId: OWNER, title: 'T', keywords: ['a', 'b'] }
    const incoming = { ownerId: OWNER, title: 'T', keywords: ['a', 'b'] }
    assert.equal(sameContent('investigations', stored, incoming), true)
  })

  it('compares an object against its serialised form as equal', () => {
    // Some adapters round-trip a json column as text; that is not a change.
    const stored = { ownerId: OWNER, title: 'T', keywords: '["a","b"]' }
    const incoming = { ownerId: OWNER, title: 'T', keywords: ['a', 'b'] }
    assert.equal(sameContent('investigations', stored, incoming), true)
  })

  it('ignores object key order', () => {
    const stored = { ownerId: OWNER, title: 'T', keywords: [{ a: 1, b: 2 }] }
    const incoming = { ownerId: OWNER, title: 'T', keywords: [{ b: 2, a: 1 }] }
    assert.equal(sameContent('investigations', stored, incoming), true)
  })

  it('respects array order', () => {
    const stored = { ownerId: OWNER, title: 'T', keywords: ['a', 'b'] }
    const incoming = { ownerId: OWNER, title: 'T', keywords: ['b', 'a'] }
    assert.equal(sameContent('investigations', stored, incoming), false)
  })

  it('detects a changed element inside a nested structure', () => {
    const stored = {
      ownerId: OWNER,
      evidenceIds: ['e1'],
      findings: [{ statement: 'A', evidenceIds: ['e1'], confidence: 'high' }],
    }
    const incoming = {
      ownerId: OWNER,
      evidenceIds: ['e1'],
      findings: [{ statement: 'A', evidenceIds: ['e1'], confidence: 'low' }],
    }
    assert.equal(sameContent('analyses', stored, incoming), false)
  })

  it('does not confuse a plain string with malformed JSON', () => {
    const stored = { ownerId: OWNER, title: 'T', keywords: 'nao-e-json' }
    const incoming = { ownerId: OWNER, title: 'T', keywords: 'nao-e-json' }
    assert.equal(sameContent('investigations', stored, incoming), true)
  })
})

describe('sameContent: boolean and number columns', () => {
  it('treats 1/false and their serialisations as the same boolean', () => {
    const base = { ownerId: OWNER, evidenceIds: [], status: 'completed' }
    for (const [stored, incoming] of [
      [1, true],
      [0, false],
      ['1', true],
      ['true', true],
    ] as Array<[unknown, unknown]>) {
      assert.equal(
        sameContent('analyses', { ...base, insufficientEvidence: stored }, { ...base, insufficientEvidence: incoming }),
        true,
        `esperava ${String(stored)} == ${String(incoming)}`,
      )
    }
  })

  it('notices a boolean that actually flipped', () => {
    const base = { ownerId: OWNER, evidenceIds: [], status: 'completed' }
    assert.equal(
      sameContent('analyses', { ...base, insufficientEvidence: 0 }, { ...base, insufficientEvidence: true }),
      false,
    )
  })

  it('compares a numeric column numerically, not as text', () => {
    const base = { ownerId: OWNER, provider: 'exa', operation: 'research', status: 'success' }
    assert.equal(
      sameContent('usage_records', { ...base, quantity: '3' }, { ...base, quantity: 3 }),
      true,
    )
    assert.equal(
      sameContent('usage_records', { ...base, quantity: 3 }, { ...base, quantity: 4 }),
      false,
    )
  })

  it('compares a numeric-string column stored as number', () => {
    const base = { ownerId: OWNER, provider: 'exa', operation: 'research', status: 'success' }
    assert.equal(
      sameContent('usage_records', { ...base, quantity: 0 }, { ...base, quantity: 0 }),
      true,
    )
  })
})

describe('sameContent: unknown keys', () => {
  it('compares a key the schema does not know when both sides carry it', () => {
    const stored = { ownerId: OWNER, title: 'T', extra: 'a' }
    const incoming = { ownerId: OWNER, title: 'T', extra: 'b' }
    assert.equal(sameContent('investigations', stored, incoming), false)
  })

  it('ignores an unknown key only the storage has', () => {
    const stored = { ownerId: OWNER, title: 'T', storageOnly: 'x' }
    const incoming = { ownerId: OWNER, title: 'T' }
    assert.equal(sameContent('investigations', stored, incoming), true)
  })

  it('falls back to a loose comparison for an unregistered collection', () => {
    assert.equal(sameContent('colecao_inexistente', { a: 1 }, { a: 1 }), true)
    assert.equal(sameContent('colecao_inexistente', { a: 1 }, { a: 2 }), false)
  })
})

describe('deepEqual', () => {
  it('is not fooled by key order or nested arrays', () => {
    assert.equal(deepEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }), true)
    assert.equal(deepEqual({ a: [1, 2] }, { a: [2, 1] }), false)
  })

  it('treats null and undefined as distinct from a value', () => {
    assert.equal(deepEqual(null, undefined), false)
    assert.equal(deepEqual(null, null), true)
  })
})

describe('a second run does not update anything', () => {
  let room: FakeRecordRoom | null = null
  afterEach(() => {
    room?.close()
    room = null
  })

  it('reports every row unchanged, including rows with JSON and booleans', async () => {
    const fake = new FakeRecordRoom()
    room = fake
    const tools = createActionTools(createFakeCaller(fake, { userId: OWNER, appAction: true }))

    const rows = [
      {
        collection: 'investigations',
        id: 'inv_1',
        data: {
          ownerId: OWNER,
          title: 'T',
          description: '',
          objective: 'Objetivo longo o suficiente para o schema',
          topic: 't',
          keywords: ['a', 'b'],
          status: 'active',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
      {
        collection: 'analyses',
        id: 'ana_1',
        data: {
          investigationId: 'inv_1',
          ownerId: OWNER,
          evidenceIds: ['e1'],
          status: 'completed',
          findings: [{ statement: 'A', evidenceIds: ['e1'], confidence: 'high' }],
          keyPoints: ['p'],
          contradictions: [],
          limitations: [],
          informationGaps: [],
          insufficientEvidence: false,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      },
    ]

    const first = await migrateRecords({
      userId: OWNER,
      params: { ownerId: OWNER, rows, dryRun: false },
      tools,
    })
    assert.equal(first.success, true)
    if (!first.success) return
    assert.equal(first.data.counts['created'], 2)

    const second = await migrateRecords({
      userId: OWNER,
      params: { ownerId: OWNER, rows, dryRun: false },
      tools,
    })
    assert.equal(second.success, true)
    if (!second.success) return
    assert.equal(second.data.counts['updated'], 0, 'nada deve ser reescrito')
    assert.equal(second.data.counts['created'], 0)
    assert.equal(second.data.counts['unchanged'], 2)

    // And a third run is stable too — the state converged.
    const third = await migrateRecords({
      userId: OWNER,
      params: { ownerId: OWNER, rows, dryRun: false },
      tools,
    })
    if (!third.success) return assert.fail('terceira execução deveria funcionar')
    assert.equal(third.data.counts['unchanged'], 2)
  })

  it('does update when content genuinely differs', async () => {
    const fake = new FakeRecordRoom()
    room = fake
    const tools = createActionTools(createFakeCaller(fake, { userId: OWNER, appAction: true }))

    const base = {
      ownerId: OWNER,
      title: 'T',
      description: '',
      objective: 'Objetivo longo o suficiente para o schema',
      topic: 't',
      keywords: ['a'],
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }

    await migrateRecords({
      userId: OWNER,
      params: { ownerId: OWNER, rows: [{ collection: 'investigations', id: 'inv_1', data: base }], dryRun: false },
      tools,
    })

    const changed = { ...base, title: 'Título alterado' }
    const second = await migrateRecords({
      userId: OWNER,
      params: {
        ownerId: OWNER,
        rows: [{ collection: 'investigations', id: 'inv_1', data: changed }],
        dryRun: false,
      },
      tools,
    })
    if (!second.success) return assert.fail('deveria funcionar')
    assert.equal(second.data.counts['updated'], 1)

    const stored = await tools.get('investigations', 'inv_1')
    if (!stored.success) return assert.fail('linha deveria existir')
    assert.equal(stored.data.record.data['title'], 'Título alterado')
  })
})
