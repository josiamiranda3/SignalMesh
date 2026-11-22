import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { registerActionRoutes, createActionTools } from '../../server/http/action-routes.ts'
import { createActions } from '../../server/actions/index.ts'
import { lookupOwnAction } from '../../server/actions/resolve.ts'
import { DELETE_WHERE_MAX, validateDeleteWhere } from '../../server/actions/types.ts'
import type { ActionHandler, ActionToolsPort } from '../../server/actions/types.ts'
import type { AppEnv } from '../../server/http/middleware.ts'
import type { RecordToolCaller, ToolResult } from '../../server/repositories/records/transport.ts'

/**
 * Action surface hardening.
 *
 * Three properties, each of which failed before this suite existed:
 *
 *  1. **Explicit credential only.** `/api/actions/*` is mounted outside
 *     `createApp`, so it never sees `csrfGuard`. Accepting a session cookie let
 *     any page drive a privileged write with the victim's ambient credential.
 *  2. **`deleteWhere` reachable.** The transport had the operation; the port
 *     did not expose it, so no action could use it.
 *  3. **Own-property resolution.** `actions[name]` walks the prototype chain, so
 *     `constructor` / `__proto__` resolved to real functions.
 */

const USER_A = 'user_a'
const USER_B = 'user_b'
const APP_OWNER = 'user_app_owner'

interface Call {
  method: string
  path: string
  headers?: Record<string, string>
  body?: unknown
  /** `undefined` = default test bearer, `null` = omit the header entirely. */
  bearer?: string | null
}

function recordingTools(): ActionToolsPort {
  return {
    async create() {
      return { success: true, data: { recordId: 'rec_new' } }
    },
    async update() {
      return { success: true, data: { recordId: 'rec_new' } }
    },
    async get(_c, recordId) {
      return { success: false as const, error: `Record not found: ${recordId}` }
    },
    async query() {
      return { success: true, data: { records: [], count: 0 } }
    },
    async deleteWhere() {
      return { success: true, data: { deleted: 0 } }
    },
  }
}

function buildApp(options: {
  resolveCaller: (request: Request) => Promise<string | null>
  ownerUserId?: string
  tools?: ActionToolsPort
}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  registerActionRoutes(app, {
    resolveCaller: options.resolveCaller,
    environment: options.ownerUserId === undefined ? {} : { OWNER_USER_ID: options.ownerUserId },
    createTools: () => options.tools ?? recordingTools(),
  })
  return app
}

async function call(app: Hono<AppEnv>, request: Call): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...request.headers }
  if (request.bearer !== null) headers['authorization'] = `Bearer ${request.bearer ?? 'test-bearer-token'}`
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

// ---------------------------------------------------------------------------
// 3.1 Bearer-only authentication
// ---------------------------------------------------------------------------

describe('action route: bearer credential is mandatory', () => {
  const validBody = { ownerId: USER_A, rows: [], dryRun: true }

  it('rejects a request with no token at all', async () => {
    const app = buildApp({ resolveCaller: async () => USER_A, ownerUserId: APP_OWNER })
    const result = await call(app, {
      method: 'POST',
      path: '/api/actions/migrateRecords',
      body: validBody,
      bearer: null,
    })
    assert.equal(result.status, 401)
  })

  it('rejects a request authenticated only by a session cookie', async () => {
    // The resolver deliberately returns an identity here: without the header
    // guard in the route this request would have been authorized, which is the
    // CSRF hole. The cookie alone must never be enough.
    const app = buildApp({ resolveCaller: async () => USER_A, ownerUserId: APP_OWNER })
    const result = await call(app, {
      method: 'POST',
      path: '/api/actions/migrateRecords',
      headers: { cookie: 'better-auth.session_token=opaque-session-value' },
      body: validBody,
      bearer: null,
    })
    assert.equal(result.status, 401)
  })

  it('rejects the platform session cookie name too', async () => {
    const app = buildApp({ resolveCaller: async () => USER_A, ownerUserId: APP_OWNER })
    const result = await call(app, {
      method: 'POST',
      path: '/api/actions/migrateRecords',
      headers: { cookie: '__Secure-better-auth.session_token=opaque' },
      body: validBody,
      bearer: null,
    })
    assert.equal(result.status, 401)
  })

  it('rejects an invalid bearer token', async () => {
    // The resolver stands in for `verifyJwt`: an invalid token makes it return
    // null, and the route must answer 401 rather than trust the header's shape.
    const app = buildApp({ resolveCaller: async () => null, ownerUserId: APP_OWNER })
    const result = await call(app, {
      method: 'POST',
      path: '/api/actions/migrateRecords',
      body: validBody,
      bearer: 'not-a-valid-jwt',
    })
    assert.equal(result.status, 401)
  })

  it('rejects an empty bearer value', async () => {
    const app = buildApp({ resolveCaller: async () => USER_A, ownerUserId: APP_OWNER })
    const result = await call(app, {
      method: 'POST',
      path: '/api/actions/migrateRecords',
      body: validBody,
      bearer: '   ',
    })
    assert.equal(result.status, 401)
  })

  it('allows a valid bearer token', async () => {
    const app = buildApp({ resolveCaller: async () => USER_A, ownerUserId: APP_OWNER })
    const result = await call(app, {
      method: 'POST',
      path: '/api/actions/migrateRecords',
      body: validBody,
    })
    // Not 401/403: the bearer credential was accepted and the request reached
    // the action. The action itself may still reject the payload, which is a
    // different layer and asserted separately.
    assert.notEqual(result.status, 401)
    assert.notEqual(result.status, 403)
  })

  it('still refuses when the token is valid but the scope claim names another user', async () => {
    const app = buildApp({ resolveCaller: async () => USER_A, ownerUserId: APP_OWNER })
    const result = await call(app, {
      method: 'POST',
      path: '/api/actions/migrateRecords',
      body: { ownerId: USER_B, rows: [], dryRun: true },
    })
    assert.equal(result.status, 403)
  })

  it('does not accept identity from request headers', async () => {
    const app = buildApp({ resolveCaller: async () => null, ownerUserId: APP_OWNER })
    const result = await call(app, {
      method: 'POST',
      path: '/api/actions/migrateRecords',
      headers: {
        'x-user-id': USER_A,
        'x-authenticated-user': USER_A,
        'x-app-action': 'true',
      },
      body: { ownerId: USER_A, rows: [], dryRun: true },
    })
    assert.equal(result.status, 401)
  })

  it('does not accept identity from the body', async () => {
    // `userId` in the body is just a parameter; it cannot become the caller.
    const app = buildApp({ resolveCaller: async () => null, ownerUserId: APP_OWNER })
    const result = await call(app, {
      method: 'POST',
      path: '/api/actions/migrateRecords',
      body: { userId: USER_A, callerId: USER_A, ownerId: USER_A, rows: [], dryRun: true },
    })
    assert.equal(result.status, 401)
  })

  it('refuses cross-user access even with a valid token', async () => {
    const app = buildApp({ resolveCaller: async () => USER_A, ownerUserId: APP_OWNER })
    const result = await call(app, {
      method: 'POST',
      path: '/api/actions/migrateRecords',
      body: { ownerId: USER_B, rows: [], dryRun: true },
      bearer: 'valid-for-user-a',
    })
    assert.equal(result.status, 403)
  })
})

// ---------------------------------------------------------------------------
// 3.3 Own-property action resolution
// ---------------------------------------------------------------------------

describe('action name resolution never leaves the own-property surface', () => {
  const handlers = createActions({ OWNER_USER_ID: APP_OWNER })
  const allowed = new Set(['migrateRecords'])

  it('resolves a registered action', () => {
    const found = lookupOwnAction(handlers, 'migrateRecords', allowed)
    assert.equal(typeof found, 'function')
  })

  it('refuses "constructor"', () => {
    assert.equal(lookupOwnAction(handlers, 'constructor', allowed), undefined)
  })

  it('refuses "prototype"', () => {
    assert.equal(lookupOwnAction(handlers, 'prototype', allowed), undefined)
  })

  it('refuses "__proto__"', () => {
    assert.equal(lookupOwnAction(handlers, '__proto__', allowed), undefined)
  })

  it('refuses inherited Object methods', () => {
    for (const name of ['toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable']) {
      assert.equal(lookupOwnAction(handlers, name, allowed), undefined, name)
    }
  })

  it('refuses a name that is not in the allowlist even when present on the registry', () => {
    const hidden: ActionHandler = async () => ({ success: true, data: null })
    const registry = { ...handlers, hiddenAction: hidden }
    assert.equal(lookupOwnAction(registry, 'hiddenAction', allowed), undefined)
  })

  it('refuses an empty name', () => {
    assert.equal(lookupOwnAction(handlers, '', allowed), undefined)
    assert.equal(lookupOwnAction(handlers, '   ', allowed), undefined)
  })

  it('returns 404 (not 500) for a prototype name over HTTP', async () => {
    const app = buildApp({ resolveCaller: async () => USER_A, ownerUserId: APP_OWNER })
    for (const name of ['constructor', '__proto__', 'toString']) {
      const result = await call(app, {
        method: 'POST',
        path: `/api/actions/${name}`,
        body: { ownerId: USER_A },
      })
      assert.equal(result.status, 404, name)
    }
  })
})

// ---------------------------------------------------------------------------
// 3.2 deleteWhere
// ---------------------------------------------------------------------------

describe('deleteWhere validation', () => {
  it('accepts a filter with a limit inside the ceiling', () => {
    const result = validateDeleteWhere({ collection: 'evidence', where: { ownerId: USER_A }, limit: 10 })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.limit, 10)
      assert.deepEqual(result.where, { ownerId: USER_A })
    }
  })

  it('defaults the limit to the ceiling', () => {
    const result = validateDeleteWhere({ collection: 'evidence', where: { ownerId: USER_A }, limit: undefined })
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.limit, DELETE_WHERE_MAX)
  })

  it('refuses an empty filter (unrestricted delete)', () => {
    const result = validateDeleteWhere({ collection: 'evidence', where: {}, limit: 10 })
    assert.equal(result.ok, false)
  })

  it('refuses a non-object filter', () => {
    for (const where of [null, 'ownerId', 42, ['ownerId']]) {
      assert.equal(validateDeleteWhere({ collection: 'evidence', where, limit: 10 }).ok, false, String(where))
    }
  })

  it('refuses a missing collection', () => {
    assert.equal(validateDeleteWhere({ collection: '', where: { ownerId: USER_A }, limit: 5 }).ok, false)
    assert.equal(validateDeleteWhere({ collection: undefined, where: { ownerId: USER_A }, limit: 5 }).ok, false)
  })

  it('refuses a limit above the ceiling', () => {
    const result = validateDeleteWhere({ collection: 'evidence', where: { ownerId: USER_A }, limit: DELETE_WHERE_MAX + 1 })
    assert.equal(result.ok, false)
  })

  it('refuses a non-positive or non-finite limit', () => {
    for (const limit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '5']) {
      assert.equal(
        validateDeleteWhere({ collection: 'evidence', where: { ownerId: USER_A }, limit }).ok,
        false,
        String(limit),
      )
    }
  })

  it('refuses an unsupported filter value type', () => {
    const result = validateDeleteWhere({
      collection: 'evidence',
      where: { ownerId: { nested: true } },
      limit: 5,
    })
    assert.equal(result.ok, false)
  })
})

describe('createActionTools exposes deleteWhere', () => {
  /** A tool caller that records what the adapter sent. */
  function callerSink(): { caller: RecordToolCaller; sent: Array<{ tool: string; params: Record<string, unknown> }> } {
    const sent: Array<{ tool: string; params: Record<string, unknown> }> = []
    const caller: RecordToolCaller = async (tool, params): Promise<ToolResult> => {
      sent.push({ tool, params })
      return { success: true, data: { deleted: 7 } }
    }
    return { caller, sent }
  }

  it('maps deleteWhere onto records.deleteWhere', async () => {
    const { caller, sent } = callerSink()
    const tools = createActionTools(caller)
    const result = await tools.deleteWhere('evidence', { ownerId: USER_A }, 10)
    assert.equal(result.success, true)
    assert.deepEqual(sent, [
      { tool: 'records.deleteWhere', params: { collection: 'evidence', where: { ownerId: USER_A }, limit: 10 } },
    ])
  })

  it('applies the ceiling when the caller omits a limit', async () => {
    const { caller, sent } = callerSink()
    const tools = createActionTools(caller)
    await tools.deleteWhere('evidence', { ownerId: USER_A })
    assert.equal(sent[0]?.params['limit'], DELETE_WHERE_MAX)
  })

  it('refuses an empty filter without reaching the transport', async () => {
    const { caller, sent } = callerSink()
    const tools = createActionTools(caller)
    const result = await tools.deleteWhere('evidence', {}, 10)
    assert.equal(result.success, false)
    assert.equal(sent.length, 0, 'the transport must not be called for an invalid filter')
  })

  it('refuses an oversized limit without reaching the transport', async () => {
    const { caller, sent } = callerSink()
    const tools = createActionTools(caller)
    const result = await tools.deleteWhere('evidence', { ownerId: USER_A }, DELETE_WHERE_MAX + 100)
    assert.equal(result.success, false)
    assert.equal(sent.length, 0)
  })

  it('returns the deleted count from the transport', async () => {
    const { caller } = callerSink()
    const tools = createActionTools(caller)
    const result = await tools.deleteWhere('evidence', { ownerId: USER_A }, 5)
    assert.equal(result.success, true)
    if (result.success) assert.deepEqual(result.data, { deleted: 7 })
  })
})
