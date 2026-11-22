import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { registerActionRoutes, createActionTools } from '../../server/http/action-routes.ts'
import { createActions, ownerOnly, selfScoped, requireVerifiedCaller } from '../../server/actions/index.ts'
import type { ActionContext, ActionToolsPort, ToolOutcome } from '../../server/actions/types.ts'
import type { AppEnv } from '../../server/http/middleware.ts'
import type { RecordToolCaller, ToolResult } from '../../server/repositories/records/transport.ts'

/**
 * Server action surface.
 *
 * This is the only privileged entry point in the app, so the tests focus on
 * what protects it: a verified identity is required before dispatch, each action
 * enforces its own scope, and identity never comes from the request.
 *
 * ## The model these tests encode (v0.2.3)
 *
 * `migrateRecords` is **self-scoped**, not owner-only. Any verified caller may
 * migrate their own data; nobody may migrate anyone else's. The v0.2.2 tests
 * asserted the opposite (an authenticated member got 403), which locked every
 * non-owner account out of its own data — see `server/actions/index.ts`.
 */

const USER_A = 'user_a'
const USER_B = 'user_b'
/** The app owner, distinct from both data owners on purpose. */
const APP_OWNER = 'user_app_owner'

interface Call {
  method: string
  path: string
  headers?: Record<string, string>
  body?: unknown
}

/** Build an app with the action route and a scripted caller resolver. */
function buildActionApp(options: {
  resolveCaller: (request: Request) => Promise<string | null>
  ownerUserId?: string
  tools?: ActionToolsPort
}) {
  const app = new Hono<AppEnv>()
  registerActionRoutes(app, {
    resolveCaller: options.resolveCaller,
    environment: options.ownerUserId === undefined ? {} : { OWNER_USER_ID: options.ownerUserId },
    createTools: () => options.tools ?? fakeTools(),
  })
  return app
}

function fakeTools(): ActionToolsPort {
  return {
    async create(collection, _data, recordId) {
      return { success: true, data: { recordId: recordId ?? 'rec_new' } }
    },
    async update(_collection, recordId) {
      return { success: true, data: { recordId } }
    },
    async get(_collection, recordId) {
      return {
        success: false as const,
        error: `Record not found: ${recordId}`,
      }
    },
    async query() {
      return { success: true, data: { records: [], count: 0 } }
    },
    async deleteWhere() {
      return { success: true, data: { deleted: 0 } }
    },
  }
}

/**
 * Issue a request to the action route.
 *
 * The route requires an **explicit** bearer credential (v0.2.5), so a default
 * `Authorization` header is attached here: these tests are about authorization
 * policy, not about credential transport, and omitting it would turn every one
 * of them into the same 401. The bearer-specific tests build their own headers
 * and pass `bearer: false` when they need to omit or replace it.
 */
async function call(
  app: Hono<AppEnv>,
  request: Call & { bearer?: string | null },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(request.bearer === null ? {} : { authorization: `Bearer ${request.bearer ?? 'test-bearer-token'}` }),
    ...request.headers,
  }
  const response = await app.request(`http://localhost${request.path}`, {
    method: request.method,
    headers,
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
  })
  const text = await response.text()
  let parsed: Record<string, unknown> = {}
  try {
    parsed = JSON.parse(text) as Record<string, unknown>
  } catch {
    parsed = { raw: text }
  }
  return { status: response.status, body: parsed }
}

describe('action route requires a verified identity', () => {
  it('rejects an anonymous caller with 401', async () => {
    const app = buildActionApp({ resolveCaller: async () => null, ownerUserId: APP_OWNER })
    const result = await call(app, {
      method: 'POST',
      path: '/api/actions/migrateRecords',
      body: { ownerId: USER_A, rows: [], dryRun: true },
    })
    assert.equal(result.status, 401)
  })

  it('ignores identity headers supplied by the caller', async () => {
    // The resolver is the only source of identity; these headers must not be
    // consulted even when they look authoritative.
    const app = buildActionApp({ resolveCaller: async () => null, ownerUserId: APP_OWNER })
    const result = await call(app, {
      method: 'POST',
      path: '/api/actions/migrateRecords',
      headers: {
        'x-migration-owner': USER_A,
        'x-migration-app': 'app_forged',
        'x-user-id': USER_A,
        'x-app-action': 'true',
        'x-owner-user-id': APP_OWNER,
      },
      body: { ownerId: USER_A, rows: [], dryRun: true },
    })
    assert.equal(result.status, 401, 'headers do not authenticate')
  })

  it('returns 404 for an unknown action name', async () => {
    const app = buildActionApp({ resolveCaller: async () => USER_A, ownerUserId: APP_OWNER })
    const result = await call(app, {
      method: 'POST',
      path: '/api/actions/deleteEverything',
      body: {},
    })
    assert.equal(result.status, 404)
  })
})

describe('self-scoped authorization: two data owners, one app owner', () => {
  it('lets user A migrate their own data even though A is not the app owner', async () => {
    // The v0.2.2 defect: this used to be a 403, making A's data unreachable.
    const app = buildActionApp({ resolveCaller: async () => USER_A, ownerUserId: APP_OWNER })
    const result = await call(app, {
      method: 'POST',
      path: '/api/actions/migrateRecords',
      body: { ownerId: USER_A, rows: [], dryRun: true },
    })
    // Past authorization, an empty batch is a validation error — not an auth one.
    assert.equal(result.status, 400)
    assert.match(String(result.body['error']), /rows/i)
    assert.doesNotMatch(String(result.body['error']), /owner only|Forbidden/i)
  })

  it('lets user B migrate their own data', async () => {
    const app = buildActionApp({ resolveCaller: async () => USER_B, ownerUserId: APP_OWNER })
    const result = await call(app, {
      method: 'POST',
      path: '/api/actions/migrateRecords',
      body: { ownerId: USER_B, rows: [], dryRun: true },
    })
    assert.equal(result.status, 400)
    assert.doesNotMatch(String(result.body['error']), /owner only|Forbidden/i)
  })

  it('refuses user A migrating B\'s data, with 403', async () => {
    const app = buildActionApp({ resolveCaller: async () => USER_A, ownerUserId: APP_OWNER })
    const result = await call(app, {
      method: 'POST',
      path: '/api/actions/migrateRecords',
      body: {
        ownerId: USER_B,
        rows: [{ collection: 'investigations', id: 'inv_b1', data: { title: 'B' } }],
        dryRun: false,
      },
    })
    assert.equal(result.status, 403)
    assert.match(String(result.body['error']), /próprio chamador|própria credencial/i)
  })

  it('refuses user B migrating A\'s data, with 403', async () => {
    const app = buildActionApp({ resolveCaller: async () => USER_B, ownerUserId: APP_OWNER })
    const result = await call(app, {
      method: 'POST',
      path: '/api/actions/migrateRecords',
      body: {
        ownerId: USER_A,
        rows: [{ collection: 'investigations', id: 'inv_a1', data: { title: 'A' } }],
        dryRun: false,
      },
    })
    assert.equal(result.status, 403)
  })

  it('refuses an ownerId forged in the body when the caller is someone else', async () => {
    // `ownerId` is a claim about the data, never proof of identity.
    const app = buildActionApp({ resolveCaller: async () => USER_A, ownerUserId: APP_OWNER })
    const result = await call(app, {
      method: 'POST',
      path: '/api/actions/migrateRecords',
      headers: { 'x-user-id': USER_B },
      body: { ownerId: USER_B, rows: [{ collection: 'investigations', id: 'i1', data: {} }], dryRun: true },
    })
    assert.equal(result.status, 403)
  })

  it('still works when OWNER_USER_ID is absent', async () => {
    // A self-scoped action must not depend on the app-owner anchor at all:
    // that dependency was the contradiction. Only owner-only actions do.
    const app = buildActionApp({ resolveCaller: async () => USER_A, ownerUserId: undefined })
    const result = await call(app, {
      method: 'POST',
      path: '/api/actions/migrateRecords',
      body: { ownerId: USER_A, rows: [], dryRun: true },
    })
    assert.equal(result.status, 400, 'a ação auto-limitada não depende de OWNER_USER_ID')
  })
})

describe('ownerOnly is still available, and still strict', () => {
  const context = (userId: string): ActionContext => ({
    userId,
    params: {},
    tools: fakeTools(),
  })

  const handler = async (): Promise<ToolOutcome<unknown>> => ({ success: true, data: { ran: true } })

  it('runs for the app owner', async () => {
    const result = await ownerOnly(handler, { OWNER_USER_ID: APP_OWNER })(context(APP_OWNER))
    assert.equal(result.success, true)
  })

  it('refuses a non-owner, including a data owner', async () => {
    for (const caller of [USER_A, USER_B, 'user_member']) {
      const result = await ownerOnly(handler, { OWNER_USER_ID: APP_OWNER })(context(caller))
      assert.equal(result.success, false, `${caller} não é o dono do app`)
    }
  })

  it('refuses everyone when the owner anchor is unknown', async () => {
    for (const env of [{}, { OWNER_USER_ID: '' }, { OWNER_USER_ID: '   ' }]) {
      const result = await ownerOnly(handler, env)(context(APP_OWNER))
      assert.equal(result.success, false, `deveria recusar com env=${JSON.stringify(env)}`)
    }
  })

  it('never lets a userId claim in params elevate the caller', async () => {
    const spy = async (ctx: ActionContext): Promise<ToolOutcome<unknown>> => ({
      success: true,
      data: { sawUser: ctx.userId },
    })
    const withSpoof = { userId: USER_A, params: { userId: APP_OWNER, ownerId: APP_OWNER }, tools: fakeTools() }
    const result = await ownerOnly(spy, { OWNER_USER_ID: APP_OWNER })(withSpoof)
    assert.equal(result.success, false, 'o params não pode elevar o chamador a dono')
  })
})

describe('selfScoped and requireVerifiedCaller', () => {
  const tools = fakeTools()

  it('refuses an empty subject', async () => {
    for (const subject of ['', '   ']) {
      const result = await requireVerifiedCaller(async () => ({ success: true, data: {} }))({
        userId: subject,
        params: {},
        tools,
      })
      assert.equal(result.success, false)
    }
  })

  it('requires the owner param to be present', async () => {
    const result = await selfScoped(async () => ({ success: true, data: {} }), { ownerParam: 'ownerId' })({
      userId: USER_A,
      params: {},
      tools,
    })
    assert.equal(result.success, false)
    if (result.success) return
    assert.equal(result.code, 'invalid')
  })

  it('refuses a non-string owner param', async () => {
    const result = await selfScoped(async () => ({ success: true, data: {} }), { ownerParam: 'ownerId' })({
      userId: USER_A,
      params: { ownerId: 123 },
      tools,
    })
    assert.equal(result.success, false)
  })

  it('passes through when the claim equals the caller', async () => {
    const result = await selfScoped(async () => ({ success: true, data: { ran: true } }), {
      ownerParam: 'ownerId',
    })({ userId: USER_A, params: { ownerId: USER_A }, tools })
    assert.equal(result.success, true)
  })

  it('marks a scope mismatch as forbidden, not invalid', async () => {
    const result = await selfScoped(async () => ({ success: true, data: {} }), { ownerParam: 'ownerId' })({
      userId: USER_A,
      params: { ownerId: USER_B },
      tools,
    })
    assert.equal(result.success, false)
    if (result.success) return
    assert.equal(result.code, 'forbidden', 'o mapeamento de status depende deste código')
  })
})

describe('action registry', () => {
  it('exposes only migrateRecords, self-scoped', async () => {
    const actions = createActions({ OWNER_USER_ID: APP_OWNER })
    assert.deepEqual(Object.keys(actions), ['migrateRecords'])

    // A data owner calling the registry directly is authorized for their own data.
    const own = await actions['migrateRecords']!({
      userId: USER_A,
      params: { ownerId: USER_A, rows: [], dryRun: true },
      tools: fakeTools(),
    })
    assert.equal(own.success, false)
    if (own.success) return
    // Refused for the empty batch, not for identity.
    assert.match(own.error, /rows/i)

    // But not for someone else's.
    const cross = await actions['migrateRecords']!({
      userId: USER_A,
      params: { ownerId: USER_B, rows: [{ collection: 'investigations', id: 'i1', data: {} }], dryRun: true },
      tools: fakeTools(),
    })
    assert.equal(cross.success, false)
    if (cross.success) return
    assert.equal(cross.code, 'forbidden')
  })
})

describe('createActionTools maps to the documented tool names', () => {
  it('builds records.create/update/get/query with the right params', async () => {
    const calls: Array<{ tool: string; params: Record<string, unknown> }> = []
    const caller: RecordToolCaller = async (tool, params) => {
      calls.push({ tool, params })
      if (tool === 'records.get') return { success: false, error: 'Record not found: x' } as ToolResult
      return { success: true, data: { recordId: 'rec_1', records: [], count: 0 } } as ToolResult
    }

    const tools = createActionTools(caller)
    await tools.create('investigations', { title: 'x' }, 'inv_1')
    await tools.update('investigations', 'inv_1', { title: 'y' })
    await tools.get('investigations', 'inv_1')
    await tools.query('investigations', { where: { ownerId: USER_A }, limit: 5 })

    assert.deepEqual(
      calls.map((entry) => entry.tool),
      ['records.create', 'records.update', 'records.get', 'records.query'],
    )
    assert.equal(calls[0]!.params['recordId'], 'inv_1')
    assert.deepEqual(calls[1]!.params['data'], { title: 'y' })
    assert.deepEqual(calls[3]!.params['where'], { ownerId: USER_A })
    assert.equal(calls[3]!.params['limit'], 5)
  })

  it('omits recordId on create when none is supplied', async () => {
    const calls: Array<Record<string, unknown>> = []
    const tools = createActionTools(async (_tool, params) => {
      calls.push(params)
      return { success: true, data: { recordId: 'generated' } } as ToolResult
    })
    await tools.create('investigations', { title: 'x' })
    assert.ok(!('recordId' in calls[0]!))
  })
})

describe('migration action refuses a caller whose ownerId differs', () => {
  it('does not accept an ownerId claim that is not the verified caller', async () => {
    const app = buildActionApp({ resolveCaller: async () => USER_A, ownerUserId: APP_OWNER })
    const result = await call(app, {
      method: 'POST',
      path: '/api/actions/migrateRecords',
      body: {
        // The caller is A but claims to migrate B's data.
        ownerId: USER_B,
        rows: [{ collection: 'investigations', id: 'i1', data: { ownerId: USER_B } }],
        dryRun: true,
      },
    })
    assert.equal(result.status, 403)
    assert.match(String(result.body['error']), /próprio chamador|userBound|própria credencial/i)
  })
})
