import type { AppConfig } from '../config.ts'
import { verifyJwt } from 'deepspace/worker'
import { createRecordsRepositories } from '../repositories/records/repositories.ts'
import {
  createRecordStore,
  createTransport,
  type RecordToolCaller,
  type RecordStore,
  type ToolResult,
} from '../repositories/records/transport.ts'
import type { UsageRecord } from '../../shared/domain.ts'
import type { UsageRepository } from '../repositories/ports.ts'
import { AuthResolver } from '../lib/auth-resolver.ts'
import { createServices, type Services } from './index.ts'

/**
 * Worker composition root.
 *
 * Wires DeepSpace Records plus verified-JWT identity. This is the only module
 * that knows the RecordRoom exists.
 *
 * ## Per-request construction
 *
 * Services are built inside the fetch handler, once per request, because the
 * transport carries the caller's identity. Nothing is shared between callers,
 * so there is no ambient "current user" to leak from one request into the next.
 *
 * ## Two transports, one exception
 *
 * Every read and write uses the **member** transport: it sends `X-User-Id` and
 * omits `X-App-Action`, so the Durable Object evaluates the collection's
 * `permissions` against the caller's real role. Row-level `'own'` scoping is
 * therefore enforced twice — by the service and by the storage layer.
 *
 * The **admin** transport (which sets `X-App-Action`) exists for a single query:
 * the platform-wide daily consumption total behind the global cost ceiling. A
 * member-scoped read cannot see other accounts' rows by design, so counting them
 * requires it. That transport returns only a number to its caller; no row ever
 * reaches a user-facing response. `createGlobalUsageReader` is the whole surface.
 */

/** The Durable Object namespace binding for the app's record room. */
export interface RecordRoomNamespace {
  idFromName(name: string): unknown
  get(id: unknown): { fetch(request: Request): Promise<Response> }
}

export interface WorkerBindings {
  RECORD_ROOMS: RecordRoomNamespace
  DEEPSPACE_APP_ID: string
  AUTH_JWT_PUBLIC_KEY?: string
  AUTH_JWT_ISSUER?: string
  OWNER_USER_ID?: string
  [key: string]: unknown
}

export interface WorkerServices extends Services {
  bindings: WorkerBindings
  close: () => void
}

/** Build a caller that posts one tool invocation to the RecordRoom. */
function createRoomCaller(input: {
  env: WorkerBindings
  userId: string
  appAction: boolean
}): RecordToolCaller {
  const { env, userId, appAction } = input
  const stub = env.RECORD_ROOMS.get(env.RECORD_ROOMS.idFromName(`app:${env.DEEPSPACE_APP_ID}`))

  return async (tool, params): Promise<ToolResult> => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-user-id': userId,
    }
    // Omitted for the member transport on purpose — see the module comment.
    if (appAction) headers['x-app-action'] = 'true'

    const response = await stub.fetch(
      new Request('https://internal/api/tools/execute', {
        method: 'POST',
        headers,
        body: JSON.stringify({ tool, params }),
      }),
    )

    try {
      return (await response.json()) as ToolResult
    } catch {
      return { success: false, error: `RecordRoom returned HTTP ${response.status}` }
    }
  }
}

/** The member-scoped store: full row RBAC enforced by the Durable Object. */
export function createMemberStore(env: WorkerBindings, userId: string): RecordStore {
  return createRecordStore(createTransport(createRoomCaller({ env, userId, appAction: false })))
}

/** The admin-scoped store. Used only by `createGlobalUsageReader`. */
export function createAdminStore(env: WorkerBindings, ownerUserId: string): RecordStore {
  return createRecordStore(createTransport(createRoomCaller({ env, userId: ownerUserId, appAction: true })))
}

/**
 * Cross-account usage totals.
 *
 * This is the *only* consumer of the admin transport. It answers one question —
 * "how many successful operations happened platform-wide since midnight?" — and
 * returns a number. It never lists, reads, or returns a row.
 */
export function createGlobalUsageReader(env: WorkerBindings, ownerUserId: string): {
  totalSince(operation: string, since: string): Promise<number>
} {
  const store = createAdminStore(env, ownerUserId)
  return {
    async totalSince(operation: string, since: string) {
      let offset = 0
      let total = 0
      for (;;) {
        const page = await store.query('usage_records', {
          where: { operation, status: 'success' },
          limit: 200,
          offset,
        })
        for (const row of page.records) {
          const createdAt = typeof row.data['createdAt'] === 'string' ? row.data['createdAt'] : row.createdAt
          if (createdAt < since) continue
          const quantity = typeof row.data['quantity'] === 'number' ? row.data['quantity'] : 0
          total += quantity
        }
        if (page.nextOffset === undefined || page.records.length === 0) return total
        offset = page.nextOffset
      }
    },
  }
}

/**
 * Wrap the usage repository so the `ownerId: null` case is answered by the
 * global reader instead of by a member-scoped scan.
 *
 * Keeping this at the repository boundary means `UsageService` needs no change
 * at all: it still asks "how much was used in this window?" and still gets a
 * number. How the platform answers that question is a persistence concern.
 */
function withGlobalUsage(base: UsageRepository, global: { totalSince(operation: string, since: string): Promise<number> }): UsageRepository {
  return {
    create: (input: UsageRecord) => base.create(input),
    listByOwner: (ownerId: string, limit: number) => base.listByOwner(ownerId, limit),
    countInWindow: (ownerId, operation, since) =>
      ownerId === null ? global.totalSince(operation, since) : base.countInWindow(ownerId, operation, since),
  }
}

export interface CreateWorkerServicesOptions {
  config: AppConfig
  bindings: WorkerBindings
  /** Verified caller id; the transport is bound to it for this request only. */
  userId: string
  /** Owner identity used by the admin transport. */
  ownerUserId: string
}

export function createWorkerServices(options: CreateWorkerServicesOptions): WorkerServices {
  const { config, bindings, userId, ownerUserId } = options

  const memberStore = createMemberStore(bindings, userId)
  const repos = createRecordsRepositories(memberStore)

  const globalUsage = createGlobalUsageReader(bindings, ownerUserId)
  const usageWithGlobal = withGlobalUsage(repos.usage, globalUsage)

  const auth = new AuthResolver({
    mode: 'deepspace',
    sessions: {
      resolve: async () => null,
      issue: async () => ({ token: '', expiresAt: '' }),
      revoke: async () => undefined,
      revokeAllForUser: async () => undefined,
      purgeExpired: () => undefined,
    } as never,
    users: repos.users,
    verifyJwt: verifyJwt as never,
    bindings: () => ({
      AUTH_JWT_PUBLIC_KEY: bindings.AUTH_JWT_PUBLIC_KEY,
      AUTH_JWT_ISSUER: bindings.AUTH_JWT_ISSUER,
    }),
    ensureUser: async (user) => user,
  })

  const services = createServices({
    config,
    repos: { ...repos, usage: usageWithGlobal },
    auth,
  })

  return {
    ...services,
    bindings,
    close: () => undefined,
  }
}
