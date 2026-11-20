import type { SessionUser } from '../../shared/api.ts'
import type { UserRecord } from '../types.ts'

/**
 * Authentication boundaries.
 *
 * The app supports exactly two identity sources, and the Worker decides which
 * one is active — never the client:
 *
 *  - `deepspace` (production and `deepspace dev start`): the identity comes from
 *    a JWT verified with `verifyJwt` against the platform's public key. The
 *    app never mints, signs, or refreshes a token.
 *  - `local` (test-only): a session cookie issued by the local adapter. It is
 *    refused outright when the app runs on the DeepSpace runtime, so a deployed
 *    app cannot be entered through the development adapter.
 *
 * Both paths converge on a `UserRecord`, so every authorization check
 * downstream (`requireOwned`, RBAC, quotas) is identical regardless of origin.
 */

export type AuthMode = 'deepspace' | 'local'

export interface AuthContext {
  mode: AuthMode
  user: UserRecord
  /** Raw verified claims, for audit metadata. Never logged wholesale. */
  claims: Record<string, unknown> | null
}

/** Shape returned by `GET /api/auth/config` so the UI can label the screen. */
export interface AuthConfigResponse {
  authMode: AuthMode
  environment: string
  signInLabel: string
  providerLabel: string
  deepspaceAuthAvailable: boolean
}

/**
 * Build the public user derived from verified JWT claims.
 *
 * Email is included because the signed-in owner is allowed to see their own
 * address; it is never included in any cross-user payload.
 */
export function userRecordFromClaims(input: {
  userId: string
  claims: Record<string, unknown>
  fallbackName?: string
}): UserRecord {
  const email = typeof input.claims['email'] === 'string' ? input.claims['email'] : ''
  const name =
    (typeof input.claims['name'] === 'string' && input.claims['name']) ||
    (email ? email.split('@')[0] : '') ||
    input.fallbackName ||
    'Pesquisador'
  const image = typeof input.claims['image'] === 'string' ? input.claims['image'] : null

  return {
    id: input.userId,
    email,
    name,
    avatarUrl: image,
    createdAt: new Date(
      typeof input.claims['iat'] === 'number' ? input.claims['iat'] * 1000 : Date.now(),
    ).toISOString(),
  }
}

/** Strip everything the API must never expose. */
export function toSessionUser(user: UserRecord): SessionUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl,
  }
}
