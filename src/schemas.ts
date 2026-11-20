import type { CollectionSchema } from 'deepspace/schema'
import { USERS_COLUMNS } from 'deepspace/schema'

/**
 * DeepSpace Records collections.
 *
 * Every schema is declared here and baked into the worker at build time. The
 * business rules never see these definitions; they reach data through
 * `server/repositories/ports.ts`. This file is the DeepSpace-shaped
 * materialisation of the model documented in `docs/database.md`.
 *
 * Isolation model
 * ---------------
 * Each domain row carries an `ownerId` text column and declares
 * `ownerField: 'ownerId'` with `read/update/delete: 'own'`. That makes the
 * RecordRoom itself refuse cross-owner reads and writes, so isolation holds
 * even if a bug in the worker forgot a check. The worker checks ownership too
 * (and returns 404 rather than 403), but the database is the second lock.
 *
 * Why `ownerField` and not the default creator column: the local SQLite
 * repository already stores an explicit `ownerId`, and the domain types use it.
 * Declaring it keeps both adapters field-for-field identical.
 *
 * Column storage notes (from the installed `deepspace/schema` types):
 *   - `storage: 'text'` for strings, ids, ISO timestamps and JSON blobs
 *   - `storage: 'number'` for numbers, booleans (0/1) and sortable values
 *   - `{ kind: 'json' }` round-trips arrays/objects without manual stringify
 */

/** Every collection shares this permission block: owners only. */
const OWNER_ONLY = {
  viewer: { read: 'own', create: false, update: false, delete: false },
  member: { read: 'own', create: true, update: 'own', delete: 'own' },
  admin: { read: true, create: true, update: true, delete: true },
} as const

/**
 * Users collection.
 *
 * `USERS_COLUMNS` is required by the SDK: auth writes the user row through it
 * and the realtime hooks read from it. Never rename, replace or drop it.
 */
export const usersSchema: CollectionSchema = {
  name: 'users',
  columns: [...USERS_COLUMNS],
  permissions: {
    viewer: { read: 'own', create: false, update: 'own', delete: false },
    member: { read: 'own', create: false, update: 'own', delete: false },
    admin: { read: true, create: false, update: true, delete: true },
  },
}

export const investigationsSchema: CollectionSchema = {
  name: 'investigations',
  columns: [
    { name: 'ownerId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'title', storage: 'text', interpretation: 'plain', required: true, maxLength: 160 },
    { name: 'description', storage: 'text', interpretation: 'plain', maxLength: 4000 },
    { name: 'objective', storage: 'text', interpretation: 'plain', required: true, maxLength: 2000 },
    { name: 'topic', storage: 'text', interpretation: 'plain', required: true, maxLength: 300 },
    { name: 'keywords', storage: 'text', interpretation: { kind: 'json' } },
    {
      name: 'status',
      storage: 'text',
      interpretation: { kind: 'select', options: ['draft', 'active', 'completed', 'archived'] },
      required: true,
    },
    { name: 'createdAt', storage: 'text', interpretation: 'plain' },
    { name: 'updatedAt', storage: 'text', interpretation: 'plain' },
  ],
  ownerField: 'ownerId',
  permissions: OWNER_ONLY,
}

export const evidenceSchema: CollectionSchema = {
  name: 'evidence',
  columns: [
    { name: 'investigationId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'ownerId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'title', storage: 'text', interpretation: 'plain', required: true, maxLength: 400 },
    { name: 'url', storage: 'text', interpretation: { kind: 'url' }, required: true, maxLength: 2048 },
    /**
     * Normalised URL used only for duplicate detection. It is a stored column
     * (not computed) so the uniqueness constraint can cover it: `uniqueOn` is
     * evaluated by the database, and the database cannot normalise for us.
     */
    { name: 'urlNormalized', storage: 'text', interpretation: 'plain', required: true, maxLength: 2048 },
    { name: 'domain', storage: 'text', interpretation: 'plain', maxLength: 255 },
    { name: 'snippet', storage: 'text', interpretation: 'plain', maxLength: 8000 },
    { name: 'retrievedContent', storage: 'text', interpretation: 'plain' },
    { name: 'publishedAt', storage: 'text', interpretation: 'plain' },
    { name: 'author', storage: 'text', interpretation: 'plain', maxLength: 300 },
    { name: 'collectedAt', storage: 'text', interpretation: 'plain', required: true },
    { name: 'source', storage: 'text', interpretation: 'plain' },
    { name: 'sourceMetadata', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'contentAvailability', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'relevanceScore', storage: 'number', interpretation: 'plain' },
    { name: 'relevanceBreakdown', storage: 'text', interpretation: { kind: 'json' } },
    {
      name: 'validationStatus',
      storage: 'text',
      interpretation: { kind: 'select', options: ['pending', 'accepted', 'rejected', 'needs_review'] },
      required: true,
    },
    { name: 'note', storage: 'text', interpretation: 'plain', maxLength: 4000 },
    { name: 'createdAt', storage: 'text', interpretation: 'plain' },
    { name: 'updatedAt', storage: 'text', interpretation: 'plain' },
  ],
  ownerField: 'ownerId',
  /**
   * Duplicate protection lives in the database, exactly as the SQLite
   * `UNIQUE (investigation_id, url_normalized)` constraint does. The service
   * still checks first so it can return the existing row with a friendly
   * "already added" answer instead of surfacing a constraint error.
   */
  uniqueOn: ['investigationId', 'urlNormalized'],
  permissions: OWNER_ONLY,
}

export const analysesSchema: CollectionSchema = {
  name: 'analyses',
  columns: [
    { name: 'investigationId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'ownerId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'evidenceIds', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'model', storage: 'text', interpretation: 'plain' },
    { name: 'status', storage: 'text', interpretation: { kind: 'select', options: ['completed', 'failed'] }, required: true },
    { name: 'executiveSummary', storage: 'text', interpretation: 'plain', maxLength: 6000 },
    { name: 'findings', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'keyPoints', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'supportedClaims', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'contradictions', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'limitations', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'informationGaps', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'objectiveAlignment', storage: 'text', interpretation: 'plain' },
    /** Only evidence ids — the titles/URLs are resolved from live evidence. */
    { name: 'referenceIds', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'insufficientEvidence', storage: 'number', interpretation: { kind: 'boolean' } },
    { name: 'rawStructuredOutput', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'usage', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'errorMessage', storage: 'text', interpretation: 'plain' },
    { name: 'createdAt', storage: 'text', interpretation: 'plain' },
  ],
  ownerField: 'ownerId',
  permissions: OWNER_ONLY,
}

export const validationsSchema: CollectionSchema = {
  name: 'validations',
  columns: [
    { name: 'investigationId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'evidenceId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'ownerId', storage: 'text', interpretation: 'plain', required: true },
    {
      name: 'status',
      storage: 'text',
      interpretation: { kind: 'select', options: ['pending', 'accepted', 'rejected', 'needs_review'] },
      required: true,
    },
    { name: 'previousStatus', storage: 'text', interpretation: 'plain' },
    { name: 'justification', storage: 'text', interpretation: 'plain', maxLength: 2000 },
    { name: 'createdAt', storage: 'text', interpretation: 'plain' },
  ],
  ownerField: 'ownerId',
  permissions: OWNER_ONLY,
}

export const activityLogsSchema: CollectionSchema = {
  name: 'activity_logs',
  columns: [
    /** Nullable: the "investigation deleted" event outlives the investigation. */
    { name: 'investigationId', storage: 'text', interpretation: 'plain' },
    { name: 'ownerId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'eventType', storage: 'text', interpretation: 'plain', required: true, maxLength: 64 },
    { name: 'description', storage: 'text', interpretation: 'plain', maxLength: 600 },
    { name: 'metadata', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'createdAt', storage: 'text', interpretation: 'plain' },
  ],
  ownerField: 'ownerId',
  /**
   * Members may append to their own trail but never rewrite or erase it — the
   * audit trail is the record of what happened, including a deletion.
   */
  permissions: {
    viewer: { read: 'own', create: false, update: false, delete: false },
    member: { read: 'own', create: true, update: false, delete: false },
    admin: { read: true, create: true, update: true, delete: true },
  },
}

export const usageRecordsSchema: CollectionSchema = {
  name: 'usage_records',
  columns: [
    { name: 'ownerId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'provider', storage: 'text', interpretation: { kind: 'select', options: ['exa', 'gemini'] }, required: true },
    { name: 'operation', storage: 'text', interpretation: { kind: 'select', options: ['research', 'analysis'] }, required: true },
    { name: 'status', storage: 'text', interpretation: { kind: 'select', options: ['success', 'error', 'blocked'] }, required: true },
    { name: 'quantity', storage: 'number', interpretation: 'plain' },
    { name: 'investigationId', storage: 'text', interpretation: 'plain' },
    { name: 'errorCode', storage: 'text', interpretation: 'plain' },
    { name: 'metadata', storage: 'text', interpretation: { kind: 'json' } },
    { name: 'createdAt', storage: 'text', interpretation: 'plain' },
  ],
  ownerField: 'ownerId',
  /**
   * The consumption ledger is append-only for members: a spent allowance must
   * not be erasable by the account it constrains.
   */
  permissions: {
    viewer: { read: 'own', create: false, update: false, delete: false },
    member: { read: 'own', create: true, update: false, delete: false },
    admin: { read: true, create: true, update: true, delete: true },
  },
}

export const researchQueriesSchema: CollectionSchema = {
  name: 'research_queries',
  columns: [
    { name: 'investigationId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'ownerId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'queryHash', storage: 'text', interpretation: 'plain', required: true },
    { name: 'query', storage: 'text', interpretation: 'plain', maxLength: 400 },
    { name: 'resultCount', storage: 'number', interpretation: 'plain' },
    { name: 'providerRequest', storage: 'text', interpretation: 'plain' },
    { name: 'createdAt', storage: 'text', interpretation: 'plain' },
  ],
  ownerField: 'ownerId',
  permissions: OWNER_ONLY,
}

export const appSettingsSchema: CollectionSchema = {
  name: 'app_settings',
  columns: [
    { name: 'ownerId', storage: 'text', interpretation: 'plain', required: true },
    { name: 'key', storage: 'text', interpretation: 'plain', required: true, maxLength: 120 },
    { name: 'value', storage: 'text', interpretation: 'plain', maxLength: 4000 },
  ],
  ownerField: 'ownerId',
  uniqueOn: ['ownerId', 'key'],
  permissions: OWNER_ONLY,
}

/**
 * The complete list, imported by `worker.ts` and baked into the deploy.
 *
 * `users` is required by the SDK and must come first; the rest are the
 * SignalMesh domain collections.
 */
export const schemas: CollectionSchema[] = [
  usersSchema,
  investigationsSchema,
  evidenceSchema,
  analysesSchema,
  validationsSchema,
  activityLogsSchema,
  usageRecordsSchema,
  researchQueriesSchema,
  appSettingsSchema,
]

/** Collection names, so the adapter and the tests cannot drift from the schemas. */
export const COLLECTIONS = {
  users: 'users',
  investigations: 'investigations',
  evidence: 'evidence',
  analyses: 'analyses',
  validations: 'validations',
  activityLogs: 'activity_logs',
  usageRecords: 'usage_records',
  researchQueries: 'research_queries',
  appSettings: 'app_settings',
} as const

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS]
