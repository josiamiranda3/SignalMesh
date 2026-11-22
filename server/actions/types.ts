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
}

/** One action handler: the caller is already verified before this runs. */
export interface ActionContext {
  /** Verified JWT subject. Never taken from the request body or a header. */
  userId: string
  params: Record<string, unknown>
  tools: ActionToolsPort
}

export type ActionHandler = (context: ActionContext) => Promise<ToolOutcome<unknown>>
