/**
 * DeepSpace Records transport.
 *
 * A thin, typed wrapper over the RecordRoom Durable Object's tools endpoint.
 * Everything the repositories do goes through here, so there is exactly one
 * place that knows the wire shape and exactly one place to audit for RBAC
 * posture.
 *
 * ## Two transports, on purpose
 *
 * `user`  — sends `X-User-Id: <caller>` and does NOT send `X-App-Action`.
 *           The DO therefore evaluates the collection's `permissions` against
 *           the real caller role, so `read/update/delete: 'own'` is enforced by
 *           the database layer, not just by our service checks.
 *
 * `admin` — sends `X-App-Action: true`, which turns row RBAC off. The DO
 *           documents this as "the app's own server-side code, which is already
 *           the trust boundary".
 *
 * The admin transport exists for exactly one job: counting the platform-wide
 * daily consumption so the *global* cost ceiling still works. A member-scoped
 * transport cannot see other users' usage rows by design, and the global
 * counter must not become a hole through which one user reads another's
 * consumption. `UsageRepository` therefore uses `admin` only when `ownerId` is
 * null, and the only query it runs against it is an aggregate count. It is
 * never used to list, read, or mutate a user-facing collection.
 */

export interface RecordRow {
  recordId: string
  data: Record<string, unknown>
  createdBy: string
  createdAt: string
  updatedAt: string
}

export type ToolResult =
  | { success: true; data: unknown }
  | { success: false; error: string }

/** Error raised when the RecordRoom refuses an operation. */
export class RecordsError extends Error {
  readonly code: 'not_found' | 'denied' | 'duplicate' | 'invalid' | 'schema' | 'unknown'
  readonly tool: string
  readonly collection: string | null

  constructor(input: {
    message: string
    tool: string
    collection?: string | null
    code: RecordsError['code']
  }) {
    super(input.message)
    this.name = 'RecordsError'
    this.tool = input.tool
    this.collection = input.collection ?? null
    this.code = input.code
  }
}

/** Classify the DO's error strings so callers can react without string matching. */
function classify(tool: string, collection: string | null, error: string): RecordsError {
  const lower = error.toLowerCase()
  let code: RecordsError['code'] = 'unknown'
  if (lower.includes('denied')) code = 'denied'
  else if (lower.includes('duplicate')) code = 'duplicate'
  else if (lower.startsWith('schema not registered')) code = 'schema'
  else if (lower.includes('not found') || lower.includes('no record')) code = 'not_found'
  else if (
    lower.includes('required field') ||
    lower.includes('field error') ||
    lower.includes('invalid') ||
    lower.includes('must be text of at most') ||
    lower.includes('cannot modify immutable') ||
    lower.includes('is not a writable field') ||
    lower.includes('missing required param')
  ) {
    // Column-level refusals land here: over-long text, immutable fields,
    // physical-vs-logical column names, and missing tool params.
    code = 'invalid'
  }
  return new RecordsError({ message: error, tool, collection, code })
}

export interface RecordsTransport {
  execute(tool: string, params: Record<string, unknown>): Promise<unknown>
}

/** Build a transport from a callable that performs the actual DO request. */
export function createTransport(send: (tool: string, params: Record<string, unknown>) => Promise<ToolResult>): RecordsTransport {
  return {
    async execute(tool, params) {
      const result = await send(tool, params)
      if (!result.success) {
        const collection = typeof params['collection'] === 'string' ? params['collection'] : null
        throw classify(tool, collection, result.error)
      }
      return result.data
    },
  }
}

/**
 * Record store used by the repositories.
 *
 * This is the persistence-neutral surface: no repository above it knows whether
 * the rows came from a Durable Object or from SQLite.
 */
export interface RecordStore {
  query(
    collection: string,
    options?: {
      where?: Record<string, unknown>
      orderBy?: string
      orderDir?: 'asc' | 'desc'
      limit?: number
      offset?: number
    },
  ): Promise<{ records: RecordRow[]; count: number; nextOffset?: number }>
  get(collection: string, recordId: string): Promise<RecordRow | null>
  create(collection: string, data: Record<string, unknown>, recordId?: string): Promise<string>
  update(collection: string, recordId: string, patch: Record<string, unknown>): Promise<void>
  remove(collection: string, recordId: string): Promise<void>
  /** Bounded batch delete; returns how many were removed. */
  deleteWhere(collection: string, where: Record<string, unknown>, limit?: number): Promise<number>
  /** Count rows matching a filter, paging until the collection is exhausted. */
  count(collection: string, where?: Record<string, unknown>): Promise<number>
}

/**
 * Page size for queries.
 *
 * `records.query` scans at most a bounded number of rows per call and returns
 * `nextOffset` when there is more; asking for a large page is therefore
 * cheaper than many small ones, but still bounded by the DO.
 */
const PAGE_SIZE = 200

export function createRecordStore(transport: RecordsTransport): RecordStore {
  return {
    async query(collection, options = {}) {
      const params: Record<string, unknown> = { collection }
      if (options.where) params['where'] = options.where
      if (options.orderBy) params['orderBy'] = options.orderBy
      if (options.orderDir) params['orderDir'] = options.orderDir
      params['limit'] = options.limit ?? PAGE_SIZE
      if (options.offset) params['offset'] = options.offset

      const data = (await transport.execute('records.query', params)) as {
        records?: RecordRow[]
        count?: number
        nextOffset?: number
      }
      return {
        records: data?.records ?? [],
        count: data?.count ?? data?.records?.length ?? 0,
        ...(data?.nextOffset === undefined ? {} : { nextOffset: data.nextOffset }),
      }
    },

    async get(collection, recordId) {
      try {
        const data = (await transport.execute('records.get', { collection, recordId })) as {
          record?: RecordRow
        }
        return data?.record ?? null
      } catch (error) {
        // A missing row is a normal answer, not an exception, for the services.
        if (error instanceof RecordsError && error.code === 'not_found') return null
        throw error
      }
    },

    async create(collection, data, recordId) {
      const params: Record<string, unknown> = { collection, data }
      if (recordId) params['recordId'] = recordId
      const result = (await transport.execute('records.create', params)) as { recordId?: string }
      if (!result?.recordId) {
        throw new RecordsError({
          message: `records.create did not return a recordId for ${collection}`,
          tool: 'records.create',
          collection,
          code: 'unknown',
        })
      }
      return result.recordId
    },

    async update(collection, recordId, patch) {
      await transport.execute('records.update', { collection, recordId, data: patch })
    },

    async remove(collection, recordId) {
      try {
        await transport.execute('records.delete', { collection, recordId })
      } catch (error) {
        // Deleting an already-absent row is idempotent for our callers.
        if (error instanceof RecordsError && error.code === 'not_found') return
        throw error
      }
    },

    async deleteWhere(collection, where, limit) {
      const data = (await transport.execute('records.deleteWhere', {
        collection,
        where,
        ...(limit === undefined ? {} : { limit }),
      })) as { deleted?: number }
      return data?.deleted ?? 0
    },

    async count(collection, where) {
      let total = 0
      let offset = 0
      for (;;) {
        const page = await this.query(collection, { where, limit: PAGE_SIZE, offset })
        total += page.records.length
        if (page.nextOffset === undefined || page.records.length === 0) return total
        offset = page.nextOffset
      }
    },
  }
}

/**
 * Callable shape of the tools endpoint.
 *
 * In the Worker this posts to the RecordRoom stub. In tests it is backed by a
 * fake DO that speaks the same contract, so the adapter is exercised for real
 * rather than mocked at the repository boundary.
 */
export interface RecordToolCaller {
  (tool: string, params: Record<string, unknown>): Promise<ToolResult>
}
