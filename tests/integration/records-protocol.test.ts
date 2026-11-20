import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRecordStore, createTransport, RecordsError, type ToolResult } from '../../server/repositories/records/transport.ts'

/**
 * RecordRoom wire contract.
 *
 * The adapter talks to the Durable Object through `POST /api/tools/execute`
 * with `{ tool, params }`. These tests pin the exact requests it builds, so a
 * change to a tool name, a parameter, or a header cannot slip through unnoticed.
 *
 * What this suite can prove: the *client* side of the contract matches the
 * documented tool surface. What it cannot prove: that the real Durable Object
 * accepts it. That requires the platform runtime (docs/testing.md §9).
 */

interface Captured {
  tool: string
  params: Record<string, unknown>
}

function recordingTransport(response?: (tool: string, params: Record<string, unknown>) => ToolResult) {
  const calls: Captured[] = []
  const transport = createTransport(async (tool, params) => {
    calls.push({ tool, params })
    if (response) return response(tool, params)
    // Default: a plausible success per tool.
    if (tool === 'records.query') return { success: true, data: { records: [], count: 0 } }
    if (tool === 'records.get') return { success: true, data: { record: null } }
    if (tool === 'records.create') return { success: true, data: { recordId: 'rec_1' } }
    if (tool === 'records.update') return { success: true, data: { recordId: 'rec_1' } }
    if (tool === 'records.delete') return { success: true, data: { recordId: 'rec_1' } }
    if (tool === 'records.deleteWhere') return { success: true, data: { deleted: 3 } }
    return { success: false, error: `Unknown tool: ${tool}` }
  })
  return { calls, store: createRecordStore(transport) }
}

describe('tool names match the documented surface', () => {
  it('uses records.query for reads', async () => {
    const { calls, store } = recordingTransport()
    await store.query('investigations', { where: { ownerId: 'u1' }, limit: 10 })
    assert.equal(calls[0]!.tool, 'records.query')
  })

  it('uses records.get for a single record', async () => {
    const { calls, store } = recordingTransport()
    await store.get('investigations', 'inv_1')
    assert.equal(calls[0]!.tool, 'records.get')
    assert.equal(calls[0]!.params['recordId'], 'inv_1')
  })

  it('uses records.create with an explicit recordId when given', async () => {
    const { calls, store } = recordingTransport()
    await store.create('investigations', { title: 'x' }, 'inv_fixed')
    assert.equal(calls[0]!.tool, 'records.create')
    assert.equal(calls[0]!.params['recordId'], 'inv_fixed')
    assert.deepEqual(calls[0]!.params['data'], { title: 'x' })
  })

  it('omits recordId on create when the server should mint one', async () => {
    const { calls, store } = recordingTransport()
    await store.create('investigations', { title: 'x' })
    assert.ok(!('recordId' in calls[0]!.params), 'sem recordId o DO gera o id')
  })

  it('uses records.update with data (not patch)', async () => {
    const { calls, store } = recordingTransport()
    await store.update('investigations', 'inv_1', { title: 'novo' })
    assert.equal(calls[0]!.tool, 'records.update')
    // The DO reads `params.data`; sending `patch` would be silently ignored.
    assert.deepEqual(calls[0]!.params['data'], { title: 'novo' })
    assert.ok(!('patch' in calls[0]!.params))
  })

  it('uses records.delete with recordId', async () => {
    const { calls, store } = recordingTransport()
    await store.remove('investigations', 'inv_1')
    assert.equal(calls[0]!.tool, 'records.delete')
    assert.equal(calls[0]!.params['recordId'], 'inv_1')
  })

  it('uses records.deleteWhere with where and limit', async () => {
    const { calls, store } = recordingTransport()
    const deleted = await store.deleteWhere('analyses', { investigationId: 'inv_1' }, 100)
    assert.equal(calls[0]!.tool, 'records.deleteWhere')
    assert.deepEqual(calls[0]!.params['where'], { investigationId: 'inv_1' })
    assert.equal(calls[0]!.params['limit'], 100)
    assert.equal(deleted, 3)
  })

  it('never issues a tool the SDK does not expose', async () => {
    const { calls, store } = recordingTransport()
    // `count` must be implemented by paging `records.query` — the SDK has no
    // `records.count` tool.
    await store.count('usage_records', { ownerId: 'u1' })
    for (const call of calls) {
      assert.equal(call.tool, 'records.query', `ferramenta inesperada: ${call.tool}`)
    }
  })
})

describe('query parameters', () => {
  it('maps orderBy / orderDir / limit / offset literally', async () => {
    const { calls, store } = recordingTransport()
    await store.query('investigations', {
      where: { status: 'active' },
      orderBy: 'updatedAt',
      orderDir: 'desc',
      limit: 25,
      offset: 50,
    })

    const params = calls[0]!.params
    assert.equal(params['orderBy'], 'updatedAt')
    assert.equal(params['orderDir'], 'desc')
    assert.equal(params['limit'], 25)
    assert.equal(params['offset'], 50)
    assert.deepEqual(params['where'], { status: 'active' })
  })

  it('never sends `patch` or `data` on a query', async () => {
    const { calls, store } = recordingTransport()
    await store.query('investigations', { limit: 5 })
    assert.ok(!('data' in calls[0]!.params))
    assert.ok(!('patch' in calls[0]!.params))
  })

  it('uses the documented page size when no limit is given', async () => {
    const { calls, store } = recordingTransport()
    await store.query('investigations')
    const limit = calls[0]!.params['limit']
    assert.equal(typeof limit, 'number')
    assert.ok(
      typeof limit === 'number' && limit > 0 && limit <= 500,
      `limite fora de faixa: ${String(limit)}`,
    )
  })

  it('follows nextOffset until the collection is exhausted', async () => {
    let page = 0
    const { calls, store } = recordingTransport(() => {
      page += 1
      if (page === 1) {
        return {
          success: true,
          data: {
            records: [
              { recordId: 'a', data: { ownerId: 'u1' }, createdBy: 'u1', createdAt: 'x', updatedAt: 'x' },
              { recordId: 'b', data: { ownerId: 'u1' }, createdBy: 'u1', createdAt: 'x', updatedAt: 'x' },
            ],
            count: 2,
            nextOffset: 2,
          },
        }
      }
      return {
        success: true,
        data: {
          records: [{ recordId: 'c', data: { ownerId: 'u1' }, createdBy: 'u1', createdAt: 'x', updatedAt: 'x' }],
          count: 1,
        },
      }
    })

    const total = await store.count('usage_records', { ownerId: 'u1' })
    assert.equal(total, 3, 'deve somar todas as páginas')
    assert.equal(calls.length, 2)
    assert.equal(calls[1]!.params['offset'], 2, 'a segunda página usa nextOffset como offset')
  })
})

describe('error mapping', () => {
  const cases: Array<{ error: string; code: RecordsError['code'] }> = [
    { error: 'Record not found: inv_1', code: 'not_found' },
    { error: 'records.update: no record "inv_1" in investigations — updates never create', code: 'not_found' },
    { error: 'UPDATE DENIED: role=member, collection=investigations', code: 'denied' },
    { error: 'DELETE DENIED: role=member, collection=evidence', code: 'denied' },
    { error: 'CREATE DENIED: role=viewer, collection=analyses', code: 'denied' },
    { error: 'Duplicate: a record with investigationId=inv_1, urlNormalized=https://x already exists', code: 'duplicate' },
    { error: 'Schema not registered for collection: nope', code: 'schema' },
    { error: "Required field 'title' is missing", code: 'invalid' },
    { error: "Field 'title' must be text of at most 160 characters", code: 'invalid' },
    { error: "Cannot modify immutable field 'ownerId'", code: 'invalid' },
    { error: 'Missing required param: collection', code: 'invalid' },
  ]

  for (const testCase of cases) {
    it(`maps "${testCase.error.slice(0, 48)}…" to ${testCase.code}`, async () => {
      const { store } = recordingTransport(() => ({ success: false, error: testCase.error }))
      await assert.rejects(
        () => store.update('investigations', 'inv_1', {}),
        (error: unknown) => {
          assert.ok(error instanceof RecordsError)
          assert.equal(error.code, testCase.code)
          assert.equal(error.tool, 'records.update')
          assert.equal(error.collection, 'investigations')
          return true
        },
      )
    })
  }

  it('treats a missing record as null on get, not an exception', async () => {
    const { store } = recordingTransport(() => ({ success: false, error: 'Record not found: x' }))
    assert.equal(await store.get('investigations', 'x'), null)
  })

  it('treats deleting an absent row as a no-op', async () => {
    const { store } = recordingTransport(() => ({ success: false, error: 'Record not found: x' }))
    await store.remove('investigations', 'x')
  })

  it('preserves the original message for diagnostics', async () => {
    const { store } = recordingTransport(() => ({ success: false, error: 'UPDATE DENIED: role=member' }))
    await assert.rejects(
      () => store.update('investigations', 'inv_1', {}),
      (error: unknown) => {
        assert.match((error as Error).message, /UPDATE DENIED/)
        return true
      },
    )
  })
})

describe('request shape', () => {
  it('sends exactly { tool, params } and nothing else', async () => {
    const captured: unknown[] = []
    const store = createRecordStore(
      createTransport(async (tool, params) => {
        captured.push({ tool, params })
        return { success: true, data: { records: [], count: 0 } }
      }),
    )
    await store.query('investigations', { limit: 1 })

    const payload = captured[0] as Record<string, unknown>
    assert.deepEqual(Object.keys(payload).sort(), ['params', 'tool'])
  })

  it('strips undefined options rather than sending them', async () => {
    const { calls, store } = recordingTransport()
    await store.query('investigations', { where: { ownerId: 'u1' } })
    const params = calls[0]!.params

    // `orderBy: undefined` would serialize as absent anyway, but the adapter
    // must not send empty strings or nulls the DO would reject.
    for (const [key, value] of Object.entries(params)) {
      assert.notEqual(value, undefined, `parâmetro ${key} não pode ser undefined`)
      assert.notEqual(value, null, `parâmetro ${key} não pode ser null`)
    }
  })
})
