import { DatabaseSync } from 'node:sqlite'
import type { CollectionSchema } from 'deepspace/schema'
import { schemas as SIGNALMESH_SCHEMAS } from '../../../src/schemas.ts'
import type { RecordToolCaller, ToolResult } from './transport.ts'

/**
 * Fake RecordRoom.
 *
 * A faithful, SQLite-backed re-implementation of the Durable Object's tools
 * endpoint, used by the test suite so the **real** Records adapter is exercised
 * end to end instead of being mocked at the repository boundary.
 *
 * It reproduces the SDK behaviour the adapter depends on:
 *
 *  - `X-User-Id` identity selection and `X-App-Action` RBAC bypass
 *  - `permissions.member.{read,update,delete} === 'own'` evaluated against
 *    `ownerField`, exactly as `isOwner()` does in the SDK
 *  - `uniqueOn` composite constraints producing Duplicate errors
 *  - `required` and `maxLength` column validation
 *  - `{ kind: 'json' }` and `{ kind: 'boolean' }` interpretation round-tripping
 *  - `records.query` paging with `limit` + `nextOffset`
 *  - `records.deleteWhere` with a bounded page size
 *  - "no record" errors for absent rows and denied updates
 *
 * What it deliberately does not reproduce: WebSockets, Yjs, presence, and the
 * realtime broadcast. The adapter does not use them.
 */

export interface FakeCaller {
  /** Verified user id, or null for an anonymous caller. */
  userId: string | null
  /** When true, acts as the app's server-side code with row RBAC disabled. */
  appAction: boolean
}

interface StoredRow {
  recordId: string
  createdBy: string
  createdAt: string
  updatedAt: string
  data: Record<string, unknown>
}

export class FakeRecordRoom {
  private readonly db: DatabaseSync
  private readonly schemas = new Map<string, CollectionSchema>()
  /** Every tool call, so tests can assert on the exact traffic. */
  readonly calls: Array<{ tool: string; params: Record<string, unknown>; caller: FakeCaller }> = []

  constructor(schemas: CollectionSchema[] = SIGNALMESH_SCHEMAS) {
    this.db = new DatabaseSync(':memory:')
    this.db.exec('PRAGMA foreign_keys = OFF')
    for (const schema of schemas) {
      this.schemas.set(schema.name, schema)
      this.createTable(schema)
    }
  }

  close(): void {
    this.db.close()
  }

  private tableName(collection: string): string {
    return `c_${collection.replace(/[^a-zA-Z0-9_]/g, '_')}`
  }

  private createTable(schema: CollectionSchema): void {
    const table = this.tableName(schema.name)
    const columnDefs = schema.columns
      .map((column) => `"${column.name}" ${column.storage === 'number' ? 'REAL' : 'TEXT'}`)
      .join(', ')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS "${table}" (
        _row_id TEXT PRIMARY KEY,
        _created_by TEXT NOT NULL,
        _created_at TEXT NOT NULL,
        _updated_at TEXT NOT NULL,
        ${columnDefs}
      )
    `)
  }

  // -------------------------------------------------------------------------
  // Interpretation (mirrors ColumnInterpretation encode/decode)
  // -------------------------------------------------------------------------

  private encode(value: unknown, column: CollectionSchema['columns'][number]): unknown {
    if (value === undefined || value === null) return null
    const interpretation = column.interpretation
    const kind = typeof interpretation === 'string' ? interpretation : interpretation.kind

    switch (kind) {
      case 'json':
        // The SDK JSON-stringifies for storage; the wire keeps arrays/objects.
        return JSON.stringify(value)
      case 'boolean':
        return value === true || value === 1 || value === 'true' ? 1 : 0
      case 'number':
        return Number(value)
      default:
        if (column.storage === 'number') {
          if (typeof value === 'boolean') return value ? 1 : 0
          return Number(value)
        }
        return typeof value === 'string' ? value : String(value)
    }
  }

  private decode(value: unknown, column: CollectionSchema['columns'][number]): unknown {
    if (value === null || value === undefined) return null
    const interpretation = column.interpretation
    const kind = typeof interpretation === 'string' ? interpretation : interpretation.kind

    switch (kind) {
      case 'json':
        if (typeof value !== 'string') return value
        try {
          return JSON.parse(value)
        } catch {
          return null
        }
      case 'boolean':
        return value === 1 || value === 'true'
      case 'number':
        return typeof value === 'number' ? value : Number(value)
      default:
        if (column.storage === 'number') {
          return typeof value === 'number' ? value : Number(value)
        }
        return value
    }
  }

  // -------------------------------------------------------------------------
  // RBAC (mirrors isOwner / canRead / canUpdate / canDelete)
  // -------------------------------------------------------------------------

  private isOwner(schema: CollectionSchema, row: StoredRow, userId: string | null): boolean {
    if (!userId) return false
    if (schema.ownerField) return row.data[schema.ownerField] === userId
    return row.createdBy === userId
  }

  /** Role resolution matches the SDK: the app action path is admin-equivalent. */
  private roleFor(caller: FakeCaller): 'anonymous' | 'member' | 'admin' {
    if (caller.appAction) return 'admin'
    return caller.userId ? 'member' : 'anonymous'
  }

  private permissionFor(schema: CollectionSchema, caller: FakeCaller) {
    const role = this.roleFor(caller)
    const table = schema.permissions
    // `*` is the catch-all role in the SDK.
    return table[role] ?? table['*'] ?? null
  }

  private canRead(schema: CollectionSchema, row: StoredRow, caller: FakeCaller): boolean {
    if (caller.appAction) return true
    const permissions = this.permissionFor(schema, caller)
    if (!permissions) return false
    const level = permissions.read
    if (level === true) return true
    if (level === false) return false
    if (level === 'own') return this.isOwner(schema, row, caller.userId)
    if (level === 'unclaimed-or-own') {
      if (schema.ownerField) {
        const owner = row.data[schema.ownerField]
        if (!owner) return true
      }
      return this.isOwner(schema, row, caller.userId)
    }
    return this.isOwner(schema, row, caller.userId)
  }

  private canWrite(
    schema: CollectionSchema,
    row: StoredRow,
    caller: FakeCaller,
    action: 'update' | 'delete',
  ): boolean {
    if (caller.appAction) return true
    const permissions = this.permissionFor(schema, caller)
    if (!permissions) return false
    const level = permissions[action]
    if (level === true) return true
    if (level === false) return false
    return this.isOwner(schema, row, caller.userId)
  }

  private canCreate(schema: CollectionSchema, caller: FakeCaller): boolean {
    if (caller.appAction) return true
    const permissions = this.permissionFor(schema, caller)
    return permissions?.create === true
  }

  // -------------------------------------------------------------------------
  // Row helpers
  // -------------------------------------------------------------------------

  private schemaOrError(collection: string): CollectionSchema {
    const schema = this.schemas.get(collection)
    if (!schema) throw new Error(`Schema not registered for collection: ${collection}`)
    return schema
  }

  private toStoredRow(collection: string, raw: Record<string, unknown>): StoredRow {
    const schema = this.schemaOrError(collection)
    const data: Record<string, unknown> = {}
    for (const column of schema.columns) {
      data[column.name] = this.decode(raw[column.name], column)
    }
    return {
      recordId: String(raw['_row_id']),
      createdBy: String(raw['_created_by']),
      createdAt: String(raw['_created_at']),
      updatedAt: String(raw['_updated_at']),
      data,
    }
  }

  private selectAll(collection: string): StoredRow[] {
    const rows = this.db.prepare(`SELECT * FROM "${this.tableName(collection)}"`).all() as unknown as Array<
      Record<string, unknown>
    >
    return rows.map((row) => this.toStoredRow(collection, row))
  }

  // -------------------------------------------------------------------------
  // Tool dispatch
  // -------------------------------------------------------------------------

  async execute(tool: string, params: Record<string, unknown>, caller: FakeCaller): Promise<ToolResult> {
    this.calls.push({ tool, params, caller })
    try {
      return this.dispatch(tool, params, caller)
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private dispatch(tool: string, params: Record<string, unknown>, caller: FakeCaller): ToolResult {
    const collection = typeof params['collection'] === 'string' ? params['collection'] : ''

    switch (tool) {
      case 'records.query':
        return this.query(collection, params, caller)
      case 'records.get':
        return this.get(collection, String(params['recordId'] ?? ''), caller)
      case 'records.create':
        return this.create(
          collection,
          (params['data'] ?? {}) as Record<string, unknown>,
          params['recordId'] ? String(params['recordId']) : undefined,
          caller,
        )
      case 'records.update':
        return this.update(
          collection,
          String(params['recordId'] ?? ''),
          (params['data'] ?? {}) as Record<string, unknown>,
          caller,
        )
      case 'records.delete':
        return this.remove(collection, String(params['recordId'] ?? ''), caller)
      case 'records.deleteWhere':
        return this.deleteWhere(
          collection,
          (params['where'] ?? {}) as Record<string, unknown>,
          typeof params['limit'] === 'number' ? params['limit'] : 100,
          caller,
        )
      case 'users.register': {
        // The SDK's privileged path for the users row.
        const userId = String(params['userId'] ?? caller.userId ?? '')
        const existing = this.dataFor('users', userId)
        if (!existing) {
          this.writeRow('users', {
            recordId: userId,
            createdBy: userId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            data: {
              email: params['email'] ?? '',
              name: params['name'] ?? '',
              imageUrl: params['imageUrl'] ?? null,
              role: params['isAdmin'] === true ? 'admin' : 'member',
            },
          })
        }
        return { success: true, data: { user: { id: userId } } }
      }
      default:
        return { success: false, error: `Unknown tool: ${tool}` }
    }
  }

  private dataFor(collection: string, recordId: string): Record<string, unknown> | null {
    const row = this.db
      .prepare(`SELECT * FROM "${this.tableName(collection)}" WHERE _row_id = ?`)
      .get(recordId) as Record<string, unknown> | undefined
    if (!row) return null
    return this.toStoredRow(collection, row).data
  }

  private query(collection: string, params: Record<string, unknown>, caller: FakeCaller): ToolResult {
    const schema = this.schemaOrError(collection)
    const where = (params['where'] ?? null) as Record<string, unknown> | null

    if (where) {
      for (const key of Object.keys(where)) {
        if (!schema.columns.some((column) => column.name === key)) {
          return { success: false, error: `Unknown field in where: ${key}` }
        }
      }
    }

    const orderBy = typeof params['orderBy'] === 'string' ? params['orderBy'] : null
    const orderDir = params['orderDir'] === 'asc' ? 'asc' : 'desc'
    const limit = typeof params['limit'] === 'number' ? params['limit'] : undefined
    const offset = typeof params['offset'] === 'number' ? params['offset'] : 0

    let rows = this.selectAll(collection)

    // RBAC-filter before paging, as the DO does.
    if (!caller.appAction) rows = rows.filter((row) => this.canRead(schema, row, caller))

    if (where) {
      rows = rows.filter((row) =>
        Object.entries(where).every(([key, value]) => {
          const actual = row.data[key]
          if (value === null) return actual === null || actual === undefined
          // JSON columns compare structurally.
          if (typeof value === 'object' && value !== null) {
            return JSON.stringify(actual) === JSON.stringify(value)
          }
          return actual === value || String(actual) === String(value)
        }),
      )
    }

    if (orderBy) {
      // Physical system columns are addressable too (`createdAt` is a data
      // column here; `_created_at` is the envelope one).
      rows.sort((a, b) => {
        const left = orderBy.startsWith('_') ? (a as unknown as Record<string, unknown>)[orderBy.slice(1)] : a.data[orderBy]
        const right = orderBy.startsWith('_') ? (b as unknown as Record<string, unknown>)[orderBy.slice(1)] : b.data[orderBy]
        const cmp = String(left ?? '').localeCompare(String(right ?? ''))
        return orderDir === 'asc' ? cmp : -cmp
      })
    }

    rows = rows.slice(offset)
    const more = limit !== undefined && rows.length > limit
    const page = limit !== undefined ? rows.slice(0, limit) : rows

    return {
      success: true,
      data: {
        records: page.map((row) => ({
          recordId: row.recordId,
          data: row.data,
          createdBy: row.createdBy,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
        count: page.length,
        offset,
        ...(more ? { nextOffset: offset + page.length } : {}),
      },
    }
  }

  private get(collection: string, recordId: string, caller: FakeCaller): ToolResult {
    const schema = this.schemaOrError(collection)
    const row = this.selectAll(collection).find((candidate) => candidate.recordId === recordId)
    if (!row) return { success: false, error: `Record not found: ${recordId}` }
    if (!this.canRead(schema, row, caller)) {
      // The SDK answers "not found" rather than leaking existence.
      return { success: false, error: `Record not found: ${recordId}` }
    }
    return {
      success: true,
      data: {
        record: {
          recordId: row.recordId,
          data: row.data,
          createdBy: row.createdBy,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        },
      },
    }
  }

  private create(
    collection: string,
    data: Record<string, unknown>,
    recordId: string | undefined,
    caller: FakeCaller,
  ): ToolResult {
    const schema = this.schemaOrError(collection)

    if (!this.canCreate(schema, caller)) {
      return { success: false, error: `CREATE DENIED: role=${this.roleFor(caller)}, collection=${collection}` }
    }

    const id = recordId ?? `rec_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    if (this.dataFor(collection, id)) {
      return { success: false, error: `Duplicate: record ${id} already exists in ${collection}` }
    }

    // Required + maxLength, as putRecord enforces on insert.
    for (const column of schema.columns) {
      const value = data[column.name]
      if (column.required && (value === undefined || value === null || value === '')) {
        return { success: false, error: `Required field '${column.name}' is missing` }
      }
      if (
        column.maxLength !== undefined &&
        typeof value === 'string' &&
        value.length > column.maxLength
      ) {
        return {
          success: false,
          error: `Field '${column.name}' must be text of at most ${column.maxLength} characters`,
        }
      }
    }

    // Composite uniqueness.
    if (schema.uniqueOn?.length) {
      const conflict = this.selectAll(collection).some((row) =>
        schema.uniqueOn!.every((field) => row.data[field] === data[field]),
      )
      if (conflict) {
        const fields = schema.uniqueOn.map((field) => `${field}=${data[field] ?? 'null'}`).join(', ')
        return { success: false, error: `Duplicate: a record with ${fields} already exists in ${collection}` }
      }
    }

    const now = new Date().toISOString()
    this.writeRow(collection, {
      recordId: id,
      createdBy: caller.userId ?? 'anon',
      createdAt: now,
      updatedAt: now,
      data,
    })

    return { success: true, data: { recordId: id } }
  }

  private update(
    collection: string,
    recordId: string,
    patch: Record<string, unknown>,
    caller: FakeCaller,
  ): ToolResult {
    const schema = this.schemaOrError(collection)
    const row = this.selectAll(collection).find((candidate) => candidate.recordId === recordId)
    if (!row) {
      return { success: false, error: `records.update: no record "${recordId}" in ${collection} — updates never create; use records.create.` }
    }
    if (!this.canWrite(schema, row, caller, 'update')) {
      return { success: false, error: `UPDATE DENIED: role=${this.roleFor(caller)}, collection=${collection}` }
    }

    const merged = { ...row.data, ...patch }

    for (const column of schema.columns) {
      if (
        column.maxLength !== undefined &&
        Object.hasOwn(patch, column.name) &&
        typeof merged[column.name] === 'string' &&
        String(merged[column.name]).length > column.maxLength
      ) {
        return {
          success: false,
          error: `Field '${column.name}' must be text of at most ${column.maxLength} characters`,
        }
      }
    }

    if (schema.uniqueOn?.length) {
      const conflict = this.selectAll(collection).some(
        (candidate) =>
          candidate.recordId !== recordId &&
          schema.uniqueOn!.every((field) => candidate.data[field] === merged[field]),
      )
      if (conflict) {
        const fields = schema.uniqueOn.map((field) => `${field}=${merged[field] ?? 'null'}`).join(', ')
        return { success: false, error: `Duplicate: a record with ${fields} already exists in ${collection}` }
      }
    }

    this.writeRow(collection, {
      recordId,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      updatedAt: new Date().toISOString(),
      data: merged,
    })
    return { success: true, data: { recordId } }
  }

  private remove(collection: string, recordId: string, caller: FakeCaller): ToolResult {
    const schema = this.schemaOrError(collection)
    const row = this.selectAll(collection).find((candidate) => candidate.recordId === recordId)
    if (!row) return { success: false, error: `Record not found: ${recordId}` }
    if (!this.canWrite(schema, row, caller, 'delete')) {
      return { success: false, error: `DELETE DENIED: role=${this.roleFor(caller)}, collection=${collection}` }
    }
    this.db.prepare(`DELETE FROM "${this.tableName(collection)}" WHERE _row_id = ?`).run(recordId)
    return { success: true, data: { recordId } }
  }

  private deleteWhere(
    collection: string,
    where: Record<string, unknown>,
    limit: number,
    caller: FakeCaller,
  ): ToolResult {
    const schema = this.schemaOrError(collection)
    if (!where || Object.keys(where).length === 0) {
      return { success: false, error: 'deleteWhere requires a non-empty where clause' }
    }
    for (const key of Object.keys(where)) {
      if (!schema.columns.some((column) => column.name === key)) {
        return { success: false, error: `Unknown field in where: ${key}` }
      }
    }
    const pageSize = Math.min(Math.max(1, limit), 500)

    const matches = this.selectAll(collection)
      .filter((row) => Object.entries(where).every(([key, value]) => row.data[key] === value))
      .filter((row) => caller.appAction || this.canWrite(schema, row, caller, 'delete'))
      .slice(0, pageSize)

    for (const row of matches) {
      this.db.prepare(`DELETE FROM "${this.tableName(collection)}" WHERE _row_id = ?`).run(row.recordId)
    }
    return { success: true, data: { deleted: matches.length } }
  }

  private writeRow(collection: string, row: StoredRow): void {
    const schema = this.schemaOrError(collection)
    const table = this.tableName(collection)
    const columns = schema.columns.map((column) => column.name)
    const values = columns.map((name) => this.encode(row.data[name], schema.columns.find((c) => c.name === name)!))

    const placeholders = ['?', '?', '?', '?', ...columns.map(() => '?')].join(', ')
    const allColumns = ['_row_id', '_created_by', '_created_at', '_updated_at', ...columns.map((name) => `"${name}"`)]

    this.db
      .prepare(
        `INSERT INTO "${table}" (${allColumns.join(', ')}) VALUES (${placeholders})
         ON CONFLICT(_row_id) DO UPDATE SET
           _updated_at = excluded._updated_at,
           ${columns.map((name) => `"${name}" = excluded."${name}"`).join(', ')}`,
      )
      .run(row.recordId, row.createdBy, row.createdAt, row.updatedAt, ...(values as never[]))
  }

  // -------------------------------------------------------------------------
  // Test conveniences
  // -------------------------------------------------------------------------

  /** Insert a row directly, bypassing RBAC — for arranging fixtures. */
  seed(collection: string, row: { recordId: string; ownerId: string; data: Record<string, unknown> }): void {
    const now = new Date().toISOString()
    this.writeRow(collection, {
      recordId: row.recordId,
      createdBy: row.ownerId,
      createdAt: now,
      updatedAt: now,
      data: { ...row.data, ownerId: row.ownerId },
    })
  }

  /** Total rows in a collection, ignoring RBAC — for assertions. */
  rawCount(collection: string): number {
    return this.selectAll(collection).length
  }
}

/**
 * Build a `RecordToolCaller` bound to a caller identity.
 *
 * `appAction: false` is the user transport: the room enforces `'own'` RBAC.
 * `appAction: true` is the admin transport, used only for the global usage
 * aggregate.
 */
export function createFakeCaller(room: FakeRecordRoom, caller: FakeCaller): RecordToolCaller {
  return (tool, params) => room.execute(tool, params, caller)
}
