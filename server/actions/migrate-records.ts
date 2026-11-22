import type { CollectionSchema } from 'deepspace/schema'
import { COLLECTIONS, schemas } from '../../src/schemas.ts'
import type { ActionContext, ActionToolsPort, ToolOutcome } from './types.ts'

/**
 * `migrateRecords` — the administrative import action.
 *
 * ## Why an action, and why not a bespoke HTTP endpoint
 *
 * The previous migration shipped a caller that POSTed to
 * `/api/internal/records/tools`, a route that was never implemented. The
 * mechanism used instead is the SDK's **server action contract**: a handler with
 * the `ActionHandler` signature, receiving `ActionTools` (RBAC off) and the
 * verified caller's id.
 *
 * Be precise about who provides what, because it matters for auditing:
 *
 *  - **SIGNALMESH provides the HTTP route** — `POST /api/actions/:name` is a
 *    Hono route in `server/http/action-routes.ts`, mounted by `worker.ts`. The
 *    platform does not mount it; the official `create-deepspace` scaffold
 *    registers the same route by hand.
 *  - **SIGNALMESH verifies the JWT** — `resolveCaller` calls `verifyJwt` with
 *    the platform-injected public key and issuer. The token is the only
 *    credential; no header is consulted.
 *  - **The SDK supplies the types and the transport** — `ActionTools` and
 *    `X-App-Action`, which disables per-record RBAC on the RecordRoom.
 *
 * Nothing here needs a bespoke endpoint, and nothing here assumes the platform
 * routes the call for us.
 *
 * ## Authorization
 *
 * Being signed in is not enough, and *being the app owner* is not the rule
 * either. The action is `selfScoped` (see `./index.ts`): a verified caller may
 * migrate, but only the data whose `ownerId` equals their own subject. The
 * refusal is explicit rather than a generic 403, because the operator needs to
 * know the operation must be run per account, with that account's token.
 *
 * ## Why the migration runs per owner
 *
 * `ownerId` is `userBound`, so the Durable Object stamps **the caller's** id on
 * every created row and ignores the payload. An action run by the app owner
 * therefore writes owner-owned rows correctly, but it cannot write rows for any
 * other account — the DO would reassign them.
 *
 * The migration consequently runs **once per owner, as that owner**: that is the
 * only configuration where `userBound` stamps the right identity. The action
 * accepts an explicit `ownerId` and refuses when it does not match the caller,
 * so a mismatch fails loudly instead of silently reattributing data.
 *
 * ## Upsert hazard
 *
 * `tools.create` with an existing `recordId` **merges** onto the existing row,
 * and under `X-App-Action` the DO does not run `canUpdate`. A blind import could
 * therefore overwrite another account's record by guessing its id. Every write
 * here re-reads the row first and refuses when it exists with a different owner.
 */

/** Collections the migration is allowed to touch, in dependency order. */
const MIGRATABLE = new Set<string>([
  COLLECTIONS.investigations,
  COLLECTIONS.evidence,
  COLLECTIONS.analyses,
  COLLECTIONS.validations,
  COLLECTIONS.activityLogs,
  COLLECTIONS.usageRecords,
])

/** Hard ceiling per call, so one request cannot run unbounded. */
const MAX_ROWS_PER_CALL = 100

/**
 * Column definitions, keyed by collection.
 *
 * Built from the same `schemas` the Durable Object is deployed with, so the
 * equality test cannot drift from what the storage will actually persist. If a
 * collection is missing here, `sameContent` falls back to a loose comparison
 * rather than guessing.
 */
const SCHEMAS_BY_NAME: ReadonlyMap<string, CollectionSchema> = new Map(
  schemas.map((schema) => [schema.name, schema]),
)

function schemaFor(collection: string): CollectionSchema | undefined {
  return SCHEMAS_BY_NAME.get(collection)
}

interface MigrateRow {
  collection: string
  id: string
  data: Record<string, unknown>
}

export interface MigrateParams {
  ownerId: string
  rows: MigrateRow[]
  dryRun: boolean
}

interface RowOutcome {
  collection: string
  id: string
  result: 'created' | 'updated' | 'unchanged' | 'skipped' | 'failed'
  error?: string
}

export interface MigrateResult {
  ownerId: string
  dryRun: boolean
  outcomes: RowOutcome[]
  counts: Record<string, number>
}

export const migrateRecords = async ({ userId, params, tools }: ActionContext): Promise<ToolOutcome<MigrateResult>> => {
  const parsed = parseParams(params)
  if (!parsed.ok) return { success: false, error: parsed.error }

  const { ownerId, rows, dryRun } = parsed.value

  // `userId` is the verified caller. It is the only identity this action trusts.
  //
  // This repeats the `selfScoped` gate deliberately, as defence in depth: the
  // wrapper protects the batch's declared scope, this check protects the handler
  // if it is ever invoked through another path. `code: 'forbidden'` is required
  // so the route answers 403 rather than 400 — a scope mismatch is an
  // authorization refusal, not a malformed request.
  if (ownerId !== userId) {
    return {
      success: false,
      code: 'forbidden',
      error:
        `A migração deve ser executada pelo próprio proprietário dos dados (chamador ${userId}, ` +
        `destino ${ownerId}). Como ownerId é userBound, executar por outra conta reatribuiria as linhas.`,
    }
  }

  const outcomes: RowOutcome[] = []
  const counts: Record<string, number> = {
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
  }

  for (const row of rows) {
    const outcome = await writeRow({ tools, ownerId, row, dryRun })
    outcomes.push(outcome)
    counts[outcome.result] = (counts[outcome.result] ?? 0) + 1
  }

  return { success: true, data: { ownerId, dryRun, outcomes, counts } }
}

async function writeRow(input: {
  tools: ActionToolsPort
  ownerId: string
  row: MigrateRow
  dryRun: boolean
}): Promise<RowOutcome> {
  const { tools, ownerId, row, dryRun } = input
  const base = { collection: row.collection, id: row.id }

  if (!MIGRATABLE.has(row.collection)) {
    return { ...base, result: 'failed', error: `collection não migrável: ${row.collection}` }
  }

  const rowOwner = row.data['ownerId']
  if (typeof rowOwner === 'string' && rowOwner !== ownerId) {
    // Defence in depth. `userBound` would silently stamp the caller; refusing
    // here keeps the mismatch visible instead of quietly moving data.
    return { ...base, result: 'skipped', error: `linha pertence a ${rowOwner}` }
  }

  // Read before writing: `create` is an upsert, so an existing row must be
  // inspected rather than overwritten.
  const existing = await tools.get(row.collection, row.id)

  if (existing.success) {
    const stored = existing.data.record
    const storedOwner = stored.data['ownerId']

    if (typeof storedOwner === 'string' && storedOwner !== ownerId) {
      // Never touch another account's row, even with RBAC off.
      return { ...base, result: 'failed', error: 'registro existente pertence a outro proprietário' }
    }

    if (sameContent(row.collection, stored.data, row.data)) {
      return { ...base, result: 'unchanged' }
    }

    if (dryRun) return { ...base, result: 'updated' }

    const updated = await tools.update(row.collection, row.id, row.data)
    return updated.success
      ? { ...base, result: 'updated' }
      : { ...base, result: 'failed', error: updated.error }
  }

  if (dryRun) return { ...base, result: 'created' }

  const created = await tools.create(row.collection, row.data, row.id)
  return created.success
    ? { ...base, result: 'created' }
    : { ...base, result: 'failed', error: created.error }
}

/**
 * Structural comparison of a stored row against the imported one.
 *
 * JSON columns arrive already parsed, so a deep compare is the only reliable
 * idempotency test; comparing serialised forms would flag every re-run as a
 * change due to key ordering.
 *
 * ## Why the comparison is schema-driven
 *
 * The previous version unioned the keys of both sides. That made the equality
 * test depend on what the *storage* happened to return, which is the wrong
 * input for "did the data change?": a Durable Object that materialises a column
 * as `null` while the payload omits it, or that returns a boolean as `0`/`1`,
 * would report a difference on every run and the migration would rewrite rows
 * forever while calling itself idempotent.
 *
 * The comparison now walks the schema:
 *
 *  - a **storage-generated envelope** (`createdAt`/`updatedAt`-style bookkeeping
 *    written by the storage on insert/update) is skipped: it records the write,
 *    not the content, and would otherwise differ on every successful update;
 *  - an **optional column absent from the payload** is skipped: absence is not
 *    an assertion of a value, so it cannot express "changed to null". This is
 *    what keeps a second run from rewriting a row the storage filled in;
 *  - a column **present on both sides** is compared with the column's
 *    interpretation, so `0`/`false` and a JSON blob vs. its parsed form are
 *    equal when they mean the same thing;
 *  - a column **absent from the schema** is compared as loose scalars rather
 *    than silently treated as equal: an unknown key the storage returns is
 *    information, and ignoring it would hide a real divergence.
 *
 * The result is deliberately asymmetric: absent-from-payload never counts as a
 * change, present-on-both-sides always does. That is the behavior an idempotent
 * upsert needs — a re-run must converge, not oscillate.
 */

/**
 * Columns the storage writes for its own bookkeeping, per collection.
 *
 * These are *not* content. They are listed explicitly rather than pattern-
 * matched so that adding one is a deliberate act, and so that a future column
 * whose name merely looks like a timestamp is not skipped by accident.
 *
 * `createdAt` is also a real domain column on several collections; it is
 * compared through `sameColumnValue` in that case, and only excluded here when
 * the payload omits it (see the "absent from payload" rule above).
 */
const STORAGE_MANAGED_COLUMNS = new Set(['createdAt', 'updatedAt', '_created_at', '_updated_at', '_created_by', '_row_id'])

/**
 * Compare one stored row against one incoming row.
 *
 * `collection` selects the schema; when it is not registered, every key present
 * on both sides is compared loosely, which is the conservative fallback.
 */
export function sameContent(
  collection: string,
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>,
): boolean {
  const schema = schemaFor(collection)

  if (!schema) {
    return sameContentLoose(stored, incoming)
  }

  for (const column of schema.columns) {
    const name = column.name
    const inStored = Object.hasOwn(stored, name)
    const inIncoming = Object.hasOwn(incoming, name)

    // Absent from the payload: not an assertion, so not a difference. Columns
    // the storage generated are skipped here for the same reason.
    if (!inIncoming) continue

    // Present in the payload but missing from the stored row is a real
    // difference: the write did not land as sent.
    if (!inStored) {
      if (isAbsent(incoming[name])) continue
      return false
    }

    if (!sameColumnValue(stored[name], incoming[name], column)) return false
  }

  // Any key the schema does not know about, present on both sides, still counts.
  // Keys only the storage has are ignored (it may add bookkeeping we do not own).
  const known = new Set(schema.columns.map((column) => column.name))
  for (const key of Object.keys(incoming)) {
    if (known.has(key) || STORAGE_MANAGED_COLUMNS.has(key)) continue
    if (!Object.hasOwn(stored, key)) continue
    if (!looseScalarEqual(stored[key], incoming[key])) return false
  }

  return true
}

/** Fallback when the collection has no registered schema. */
function sameContentLoose(stored: Record<string, unknown>, incoming: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(stored), ...Object.keys(incoming)])
  for (const key of keys) {
    if (STORAGE_MANAGED_COLUMNS.has(key)) continue
    const inStored = Object.hasOwn(stored, key)
    const inIncoming = Object.hasOwn(incoming, key)
    // Absence on either side is not a change, for the reason above.
    if (!inStored || !inIncoming) continue
    if (!looseScalarEqual(stored[key], incoming[key])) return false
  }
  return true
}

/** `null` and `undefined` both mean "no value". */
function isAbsent(value: unknown): boolean {
  return value === null || value === undefined
}

/**
 * Compare a stored value against an incoming one, honoring the column's
 * interpretation.
 *
 * The storage does not promise to hand back the exact JavaScript value that was
 * sent: a `boolean` column may return `0`/`1`, a `number` column may return
 * `"3"`, a `json` column may return a parsed value or a string depending on the
 * adapter. Equality here means "the same value once interpreted", which is the
 * only definition under which a re-run can be a no-op.
 */
function sameColumnValue(
  stored: unknown,
  incoming: unknown,
  column: CollectionSchema['columns'][number],
): boolean {
  // Both empty is equal, regardless of interpretation.
  if (isAbsent(stored) && isAbsent(incoming)) return true
  if (isAbsent(stored) || isAbsent(incoming)) return false

  const interpretation = column.interpretation
  const kind = typeof interpretation === 'string' ? interpretation : interpretation.kind

  if (kind === 'json') return jsonEqual(stored, incoming)

  if (kind === 'boolean') {
    const left = asBoolean(stored)
    const right = asBoolean(incoming)
    if (left !== null && right !== null) return left === right
    return looseScalarEqual(stored, incoming)
  }

  if (kind === 'number') {
    const left = asNumber(stored)
    const right = asNumber(incoming)
    if (left !== null && right !== null) return left === right
    return looseScalarEqual(stored, incoming)
  }

  // `plain`, `select`, `url`, `date`: the stored form should be the string that
  // was sent. Compare as text so a driver returning a String object still matches.
  if (column.storage === 'number') {
    const left = asNumber(stored)
    const right = asNumber(incoming)
    if (left !== null && right !== null) return left === right
  }

  return looseScalarEqual(stored, incoming)
}

/** Interpret a value as a boolean, or `null` when it cannot be one. */
function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (value === 1 || value === 0) return value === 1
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  return null
}

/** Interpret a value as a number, or `null` when it cannot be one. */
function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value)
  }
  return null
}

/**
 * Compare two JSON values semantically.
 *
 * Parses a string side when the other is already a structure, so a `json` column
 * that round-trips as text still compares equal to the object that produced it.
 * Key order is irrelevant; array order is not.
 */
function jsonEqual(rawLeft: unknown, rawRight: unknown): boolean {
  const left = parseIfJsonString(rawLeft)
  const right = parseIfJsonString(rawRight)
  return deepEqual(left, right)
}

function parseIfJsonString(value: unknown): unknown {
  if (typeof value !== 'string') return value
  // Only attempt a parse when it looks like JSON; a plain text value that is not
  // JSON must compare as text, not as a parse failure.
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[') && trimmed !== 'null') return value
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return value
  }
}

/** Scalar equality that tolerates a String/Number wrapper. */
function looseScalarEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left instanceof Date || right instanceof Date) {
    return String(left) === String(right)
  }
  if (typeof left === 'object' || typeof right === 'object') {
    return deepEqual(parseIfJsonString(left), parseIfJsonString(right))
  }
  return false
}

export function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (left === null || right === null) return false
  if (typeof left !== typeof right) {
    // A number and its string form are not the same JSON value, but a JSON
    // column that came back as text has already been parsed above.
    return false
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false
    return left.every((value, index) => deepEqual(value, right[index]))
  }

  if (typeof left === 'object' && typeof right === 'object') {
    const leftObject = left as Record<string, unknown>
    const rightObject = right as Record<string, unknown>
    const keys = new Set([...Object.keys(leftObject), ...Object.keys(rightObject)])
    for (const key of keys) {
      if (!deepEqual(leftObject[key], rightObject[key])) return false
    }
    return true
  }

  return false
}

type Parsed =
  | { ok: true; value: MigrateParams }
  | { ok: false; error: string }

/** Strict parameter validation: this action is reachable by any signed-in user. */
function parseParams(params: Record<string, unknown>): Parsed {
  const ownerId = params['ownerId']
  if (typeof ownerId !== 'string' || ownerId.trim() === '') {
    return { ok: false, error: 'ownerId é obrigatório' }
  }

  const dryRun = params['dryRun'] === true

  const rawRows = params['rows']
  if (!Array.isArray(rawRows)) {
    return { ok: false, error: 'rows deve ser um array' }
  }
  if (rawRows.length === 0) {
    return { ok: false, error: 'rows está vazio' }
  }
  if (rawRows.length > MAX_ROWS_PER_CALL) {
    return { ok: false, error: `no máximo ${MAX_ROWS_PER_CALL} linhas por chamada` }
  }

  const rows: MigrateRow[] = []
  for (const [index, raw] of rawRows.entries()) {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: `rows[${index}] deve ser um objeto` }
    }
    const candidate = raw as Record<string, unknown>
    const collection = candidate['collection']
    const id = candidate['id']
    const data = candidate['data']

    if (typeof collection !== 'string' || !MIGRATABLE.has(collection)) {
      return { ok: false, error: `rows[${index}].collection inválida` }
    }
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: `rows[${index}].id é obrigatório` }
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, error: `rows[${index}].data deve ser um objeto` }
    }

    rows.push({ collection, id, data: data as Record<string, unknown> })
  }

  return { ok: true, value: { ownerId, rows, dryRun } }
}

/** Exported for the tests that assert the allow-list. */
export const MIGRATABLE_COLLECTIONS = [...MIGRATABLE]
