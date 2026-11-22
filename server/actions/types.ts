/**
 * Action tools port.
 *
 * The DeepSpace server-action surface (`ActionTools`) is exactly what an
 * administrative write needs: it reaches the RecordRoom with row RBAC off, so it
 * can perform cross-collection work. This interface is the subset the migration
 * uses, declared locally so the migration logic can be exercised against both
 * the real Durable Object and the test double without importing platform code
 * into the test.
 *
 * ## The hazard this port exists to contain
 *
 * `tools.create(collection, data, recordId)` is an **upsert**: if a record with
 * that id already exists, the incoming data is merged on top of it. Under
 * `X-App-Action` the SDK skips `canUpdate`, so a naive import could overwrite a
 * row belonging to someone else just by guessing its id.
 *
 * `userBound` does not save us there: on the *create* path it stamps the caller,
 * and on the *update* path it restores the stored owner — but the rest of the
 * merged fields still get written. So the migration must refuse to touch any row
 * that already exists and is not owned by the caller. That check lives in the
 * action, not in the tool.
 */

/**
 * Failure reason.
 *
 * `forbidden` is an authorization refusal, `invalid` a bad request. The route
 * maps these to status codes directly instead of pattern-matching the message,
 * so wording can change without silently turning a 403 into a 400.
 */
export type ActionFailureCode = 'forbidden' | 'invalid'

export type ToolOutcome<T> =
  | { success: true; data: T }
  | { success: false; error: string; code?: ActionFailureCode }

export interface ActionRecordRow {
  recordId: string
  data: Record<string, unknown>
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface ActionToolsPort {
  create(collection: string, data: Record<string, unknown>, recordId?: string): Promise<ToolOutcome<{ recordId: string }>>
  update(
    collection: string,
    recordId: string,
    data: Record<string, unknown>,
  ): Promise<ToolOutcome<{ recordId: string }>>
  get(collection: string, recordId: string): Promise<ToolOutcome<{ record: ActionRecordRow }>>
  query(
    collection: string,
    options?: { where?: Record<string, unknown>; limit?: number },
  ): Promise<ToolOutcome<{ records: ActionRecordRow[]; count: number }>>
  /**
   * Delete rows matching `where`, returning how many were removed.
   *
   * This mirrors the transport's `records.deleteWhere`, which already existed —
   * the port simply never exposed it, so no action could reach a capability the
   * persistence layer already had.
   *
   * Under `X-App-Action` the RecordRoom skips per-row RBAC, so the *caller of
   * this tool* is responsible for the filter. The guards below are deliberately
   * part of the tool rather than left to each action: an empty or malformed
   * filter would otherwise be an unbounded delete across a whole collection,
   * and a limit high enough to mean "everything" is the same thing spelled
   * differently.
   */
  deleteWhere(
    collection: string,
    where: Record<string, unknown>,
    limit?: number,
  ): Promise<ToolOutcome<{ deleted: number }>>
}

/**
 * Hard ceiling on a single `deleteWhere` call.
 *
 * The transport pages at 200 rows and the migration batches at 100, so 500 is
 * above any legitimate batch while still bounding the blast radius of one call.
 * A caller that needs more deletes loops, which makes the volume visible in the
 * audit trail instead of hiding it in one statement.
 */
export const DELETE_WHERE_MAX = 500

/**
 * Validate a `deleteWhere` request.
 *
 * Exported so the action adapter and its tests share one definition of "valid
 * filter" — a second copy of these rules would drift.
 */
export function validateDeleteWhere(input: {
  collection: unknown
  where: unknown
  limit: unknown
}): { ok: true; collection: string; where: Record<string, unknown>; limit: number } | { ok: false; error: string } {
  if (typeof input.collection !== 'string' || input.collection.trim() === '') {
    return { ok: false, error: 'collection é obrigatório' }
  }

  // An empty filter is an unrestricted delete. Refuse it outright rather than
  // relying on the caller to pass one that happens to be safe.
  if (typeof input.where !== 'object' || input.where === null || Array.isArray(input.where)) {
    return { ok: false, error: 'where deve ser um objeto de filtros' }
  }

  const keys = Object.keys(input.where as Record<string, unknown>)
  if (keys.length === 0) {
    return { ok: false, error: 'where não pode ser vazio (exclusão ilimitada)' }
  }

  // A filter naming the ownership column is the expected shape; anything else
  // is still allowed, but the value must be usable by the transport.
  for (const key of keys) {
    const value = (input.where as Record<string, unknown>)[key]
    const usable =
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null ||
      Array.isArray(value)
    if (!usable) {
      return { ok: false, error: `where.${key} tem tipo não suportado` }
    }
  }

  const rawLimit = input.limit
  if (rawLimit !== undefined && (typeof rawLimit !== 'number' || !Number.isFinite(rawLimit) || rawLimit < 1)) {
    return { ok: false, error: 'limit deve ser um inteiro positivo' }
  }
  const limit = rawLimit === undefined ? DELETE_WHERE_MAX : Math.floor(rawLimit as number)
  if (limit > DELETE_WHERE_MAX) {
    return { ok: false, error: `limit excede o máximo de ${DELETE_WHERE_MAX}` }
  }

  return { ok: true, collection: input.collection, where: input.where as Record<string, unknown>, limit }
}

/** One action handler: the caller is already verified before this runs. */
export interface ActionContext {
  /** Verified JWT subject. Never taken from the request body or a header. */
  userId: string
  params: Record<string, unknown>
  tools: ActionToolsPort
}

export type ActionHandler = (context: ActionContext) => Promise<ToolOutcome<unknown>>
