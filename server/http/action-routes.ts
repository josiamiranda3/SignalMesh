import type { Hono } from 'hono'
import type { AppEnv } from './middleware.ts'
import { bearerToken } from './middleware.ts'
import { createActions, type ActionEnvironment } from '../actions/index.ts'
import { lookupOwnAction } from '../actions/resolve.ts'
import { validateDeleteWhere } from '../actions/types.ts'
import type { ActionHandler, ActionToolsPort } from '../actions/types.ts'
import type { RecordToolCaller, ToolResult } from '../repositories/records/transport.ts'

/**
 * Server action route.
 *
 * ## This route is ours
 *
 * `POST /api/actions/:name` is implemented **here**, by SIGNALMESH. The platform
 * does not mount it for the app — the official `create-deepspace` scaffold
 * registers `app.post('/api/actions/:name')` by hand exactly as below. What the
 * SDK provides is the *contract*: the `ActionHandler` signature, the
 * `ActionTools` type, and the `X-App-Action` transport that disables per-record
 * RBAC on the RecordRoom. Anything about routing, authentication or
 * authorization on this path is this repository's responsibility.
 *
 * It is deliberately the **only** administrative surface this app exposes, and
 * it is built so that privilege cannot be reached anonymously:
 *
 *   1. A **bearer** credential is required before dispatch (`resolveCaller`).
 *      The value comes from `verifyJwt`; no header or body field is consulted.
 *   2. The action carries its own policy (`selfScoped` / `ownerOnly`), applied
 *      in the registry — so an authenticated but unauthorized caller is
 *      refused by the handler, not merely by the route.
 *   3. The tools it receives act as that verified caller. `X-App-Action` is set
 *      because the action needs cross-collection reach, and because the
 *      RecordRoom does no per-row RBAC under it, ownership is enforced by the
 *      action itself (`userBound` also stamps the caller on every write).
 *
 * ## Why bearer only (v0.2.5)
 *
 * This route is mounted on its **own** Hono instance, before the app that
 * carries `csrfGuard`. It therefore never passes through the CSRF middleware.
 * Accepting a session cookie here was a real hole: a cookie is an *ambient*
 * credential the browser attaches by itself, so any page on the internet could
 * cause a signed-in user's browser to POST to this privileged surface with the
 * cookie attached and no marker header — exactly the CSRF case the rest of the
 * app defends against.
 *
 * The route now requires the credential to be *explicit*: `Authorization:
 * Bearer <jwt>`. A cross-origin page cannot set that header without a preflight
 * this app never grants, and cannot read the token to set it. Requests carrying
 * only a cookie are refused with 401 before anything else runs.
 *
 * There is no `/api/internal/*` route, no client-supplied identity header, and
 * no migration endpoint reachable from the browser.
 */

export interface ActionRouteOptions {
  /**
   * Verify an explicit **bearer** credential. Returns the subject, or null.
   *
   * Implementations must read the token from the `Authorization` header only.
   * A cookie must never satisfy this: see the module comment.
   */
  resolveCaller: (request: Request) => Promise<string | null>
  /** Env bindings used for the owner gate. */
  environment: ActionEnvironment
  /** Build the tool surface bound to the verified caller. */
  createTools: (callerId: string) => ActionToolsPort
}

/**
 * Names allowed to be dispatched. Anything else is 404, not "unknown action".
 *
 * This is the outer gate; `lookupOwnAction` is the inner one. Both are needed:
 * the allowlist decides *what* is reachable, the own-property lookup decides
 * that resolving the name cannot walk into the object's prototype.
 */
const ALLOWED_ACTIONS = new Set(['migrateRecords'])

export function registerActionRoutes(app: Hono<AppEnv>, options: ActionRouteOptions): void {
  const actions = createActions(options.environment)

  app.post('/api/actions/:name', async (c) => {
    const name = c.req.param('name')

    // Unknown names are indistinguishable from a wrong path: an attacker learns
    // nothing about which actions exist. `lookupOwnAction` only ever returns a
    // handler registered as an **own** property, so `constructor`, `toString`,
    // `__proto__` and friends resolve to nothing even if the allowlist were
    // widened by mistake.
    const action = lookupOwnAction(actions, name, ALLOWED_ACTIONS) as ActionHandler | undefined
    if (!action) {
      return c.json({ success: false as const, error: 'Action not found' }, 404)
    }

    // Explicit credential required. `bearerToken` reads only the Authorization
    // header, so a cookie-only request cannot authenticate here.
    if (!bearerToken(c.req.raw)) {
      return c.json({ success: false as const, error: 'Unauthorized' }, 401)
    }

    // Identity is established before anything else happens.
    const callerId = await options.resolveCaller(c.req.raw)
    if (!callerId) {
      return c.json({ success: false as const, error: 'Unauthorized' }, 401)
    }

    let params: Record<string, unknown> = {}
    try {
      const body = await c.req.json()
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        params = body as Record<string, unknown>
      }
    } catch {
      return c.json({ success: false as const, error: 'Corpo da requisição deve ser JSON válido' }, 400)
    }

    const tools = options.createTools(callerId)
    const result = await action({ userId: callerId, params, tools })

    if (!result.success) {
      // The handler tags authorization refusals explicitly, so the status is
      // not inferred from wording.
      return c.json(
        { success: false as const, error: result.error },
        result.code === 'forbidden' ? 403 : 400,
      )
    }

    return c.json({ success: true as const, data: result.data })
  })
}

/**
 * Adapt the RecordRoom caller into the action tool port.
 *
 * The caller is the verified user id; `appAction` is true because that is what
 * the action surface is for. It does not widen *data* access beyond the caller,
 * because `userBound` still stamps that same caller.
 *
 * `deleteWhere` is exposed here because the port previously stopped short of
 * the transport: `RecordStore` had the operation, the transport could perform
 * it, but no action could reach it. Passing it through with the same guards the
 * transport applies keeps the two surfaces consistent instead of leaving a
 * capability that only looks absent.
 */
export function createActionTools(caller: RecordToolCaller): ActionToolsPort {
  async function invoke(tool: string, params: Record<string, unknown>): Promise<ToolResult> {
    return caller(tool, params)
  }

  return {
    async create(collection, data, recordId) {
      const params: Record<string, unknown> = { collection, data }
      if (recordId) params['recordId'] = recordId
      return invoke('records.create', params) as never
    },
    async update(collection, recordId, data) {
      return invoke('records.update', { collection, recordId, data }) as never
    },
    async get(collection, recordId) {
      return invoke('records.get', { collection, recordId }) as never
    },
    async query(collection, queryOptions) {
      const params: Record<string, unknown> = { collection }
      if (queryOptions?.where) params['where'] = queryOptions.where
      if (queryOptions?.limit !== undefined) params['limit'] = queryOptions.limit
      return invoke('records.query', params) as never
    },
    async deleteWhere(collection, where, limit) {
      // Validated in the tool, not left to each action: an empty filter or an
      // unbounded limit would be a whole-collection delete under `X-App-Action`,
      // where the RecordRoom applies no per-row RBAC.
      const checked = validateDeleteWhere({ collection, where, limit })
      if (!checked.ok) {
        return { success: false, error: checked.error, code: 'invalid' } as never
      }
      const params: Record<string, unknown> = {
        collection: checked.collection,
        where: checked.where,
        limit: checked.limit,
      }
      return invoke('records.deleteWhere', params) as never
    },
  }
}
