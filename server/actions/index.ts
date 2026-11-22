import type { ActionContext, ActionHandler, ToolOutcome } from './types.ts'
import { migrateRecords } from './migrate-records.ts'

/**
 * Server action registry and authorization policies.
 *
 * ## Who implements the route
 *
 * **This repository does.** `registerActionRoutes` in
 * `server/http/action-routes.ts` is a SIGNALMESH Hono route; the platform does
 * not mount `/api/actions/<name>` for the app. What the SDK supplies is the
 * contract — the `ActionHandler`/`ActionContext`/`ActionTools` types and the
 * `X-App-Action` transport semantics — not a server. The official
 * `create-deepspace` scaffold does the same thing: it registers
 * `app.post('/api/actions/:name')` itself, calls its own `resolveAuth`, and
 * builds its own `createActionTools(env, auth.userId, callerJwt)`.
 *
 * ## Where the trust boundary is
 *
 * The SDK states it plainly: *"This worker is the only authorization boundary.
 * `resolveAuth` establishes who is calling; everything after it runs with that
 * identity and no further checks."* `ActionTools` reach the record room with
 * `X-App-Action: true`, which turns **per-record RBAC off**, and the `userId`
 * those tools carry is *the identity they act as*, not a permission the room
 * enforces. An action that takes a record id from `params` and forwards it has
 * authorized nothing.
 *
 * ## The contradiction this module used to contain
 *
 * Until v0.2.2 every action was wrapped in `ownerOnly`, which required
 * `userId === OWNER_USER_ID`, while `migrateRecords` required
 * `ownerId === userId`. Together those two rules meant that **only the app
 * owner could ever migrate, and only the app owner's own rows** — so a second
 * account's data could never be migrated at all, by anyone. That is not a
 * security property, it is a dead end: the schema is multi-tenant (`ownerId`
 * on every domain collection, `userBound`, `immutable`, `permissions: 'own'`),
 * so data belonging to other accounts is expected to exist.
 *
 * The platform does not require it either. `OWNER_USER_ID` is used by the SDK
 * for exactly two things: making the app owner an admin of the RecordRoom
 * (`new RecordRoom(state, env, schemas, { ownerUserId })`) and, in the
 * scaffold, choosing `APP_OWNER_JWT` for developer-billed integrations. Neither
 * is a precondition for dispatching an action.
 *
 * ## The model that replaced it
 *
 * Two named policies, so the intent is visible at the registration site:
 *
 *  - **`selfScoped`** — a verified caller may act, but only on rows whose
 *    ownership column names *that caller*. Used by `migrateRecords`.
 *  - **`ownerOnly`** — the app owner alone may act. Reserved for operations
 *    that are genuinely app-wide (account-wide maintenance, billing-owner
 *    work) and therefore have no per-row scope to bind to. **Never** use it
 *    for an operation whose data belongs to individual accounts: it silently
 *    makes other accounts' data unreachable.
 *
 * Both fail closed when there is no verified identity. Neither reads an
 * identity from `params` or from any header.
 */

export interface ActionEnvironment {
  OWNER_USER_ID?: string
}

/**
 * True when the context carries a usable verified subject.
 *
 * A check, not a wrapper: wrapping the handler would run it, and a guard that
 * executes the work before deciding is not a guard. See `selfScoped`, which
 * performs every check first and only then invokes the handler.
 */
function hasVerifiedCaller(context: ActionContext): boolean {
  return typeof context.userId === 'string' && context.userId.trim() !== ''
}

/**
 * Refuse anything without a verified, non-empty subject, then run the handler.
 *
 * `context.userId` is supplied by the route from `resolveCaller`, i.e. from a
 * verified token — never from the request body or a header.
 */
export function requireVerifiedCaller(handler: ActionHandler): ActionHandler {
  return async (context: ActionContext): Promise<ToolOutcome<unknown>> => {
    if (!hasVerifiedCaller(context)) {
      return {
        success: false,
        code: 'forbidden',
        error: 'Forbidden: chamador não autenticado',
      }
    }
    return handler(context)
  }
}

/**
 * Per-caller authorization: act, but only on the caller's own data.
 *
 * `ownerParam` names the request field that *claims* whose data is being
 * touched. The gate refuses when that claim differs from the verified caller,
 * **before the handler runs**. The handler still re-checks each row: this gate
 * protects the *batch's* declared scope, the handler protects each individual
 * row, and neither alone is sufficient — a batch can legitimately declare
 * `ownerId: A` and still contain a forged row.
 *
 * This is the correct policy for operations over multi-tenant data. It does
 * **not** grant cross-account reach: `userBound` still stamps the caller's id
 * on every write, so even a handler that tried could not create a row for
 * someone else.
 */
export function selfScoped(
  handler: ActionHandler,
  options: { ownerParam: string },
): ActionHandler {
  return async (context: ActionContext): Promise<ToolOutcome<unknown>> => {
    // 1. Identity. Nothing runs without a verified subject.
    if (!hasVerifiedCaller(context)) {
      return {
        success: false,
        code: 'forbidden',
        error: 'Forbidden: chamador não autenticado',
      }
    }

    // 2. Declared scope. A malformed claim is a client error...
    const claimed = context.params[options.ownerParam]
    if (typeof claimed !== 'string' || claimed.trim() === '') {
      return {
        success: false,
        code: 'invalid',
        error: `${options.ownerParam} é obrigatório`,
      }
    }

    // ...and a claim naming someone else is an authorization refusal.
    if (claimed !== context.userId) {
      // Deliberately explicit rather than a generic 403: the operator needs to
      // know the operation must be run per account, with that account's token.
      return {
        success: false,
        code: 'forbidden',
        error:
          `Operação limitada aos dados do próprio chamador ` +
          `(chamador ${context.userId}, destino ${claimed}). ` +
          'Cada proprietário deve executar a operação com a sua própria credencial.',
      }
    }

    // 3. Only now is the work performed.
    return handler(context)
  }
}

/**
 * App-owner-only policy.
 *
 * Keep this for operations with **no per-row scope**: they run once for the
 * whole app, so "the app owner" is the only meaningful principal. Applying it
 * to an operation over individual accounts' data is the v0.2.2 defect — it
 * makes that data permanently unreachable for everyone but the owner, who may
 * not own it at all.
 *
 * Fails closed when `OWNER_USER_ID` is absent: without the anchor there is no
 * way to distinguish an owner from a member.
 */
export function ownerOnly(
  handler: ActionHandler,
  env: ActionEnvironment,
): ActionHandler {
  return async (context: ActionContext): Promise<ToolOutcome<unknown>> => {
    const owner = env.OWNER_USER_ID?.trim()
    if (!owner) {
      return {
        success: false,
        code: 'forbidden',
        error: 'OWNER_USER_ID não configurado; operação administrativa indisponível',
      }
    }
    if (context.userId !== owner) {
      return { success: false, code: 'forbidden', error: 'Forbidden: owner only' }
    }
    return handler(context)
  }
}

/** Build the action map for a given environment. */
export function createActions(_env: ActionEnvironment): Record<string, ActionHandler> {
  return {
    // Per-account operation: every verified owner migrates their own data.
    // `userBound` makes the transport stamp the caller, so a row can only ever
    // land under the identity that ran the action.
    migrateRecords: selfScoped(migrateRecords, { ownerParam: 'ownerId' }),
  }
}
