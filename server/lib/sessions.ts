import { createHash, randomBytes } from 'node:crypto'
import type { UserRecord } from '../types.ts'
import type { UserRepository } from '../repositories/ports.ts'
import { get, run, type Database } from '../db.ts'
import { createId, nowIso } from './util.ts'

/**
 * Session handling for the local runtime.
 *
 * DeepSpace Auth replaces this in the worker adapter: there, the caller's
 * identity comes from a verified JWT, and this module is not used. Locally we
 * need a real, persistent, revocable session so the authentication, isolation
 * and authorization rules can be exercised end to end.
 *
 * - The cookie carries a 256-bit random token; only its SHA-256 hash is stored.
 * - Session rows expire and are deleted on logout.
 * - The token is opaque (no claims), so revocation is immediate.
 *
 * ## Scope note
 *
 * Everything here touches the local SQLite database, so importing this module
 * from the Worker would drag `node:sqlite` into the edge bundle. The cookie and
 * CSRF primitives that both runtimes need live in `./session-cookies.ts`; they
 * are re-exported below so existing importers keep working, but **new worker
 * code must import them from `./session-cookies.ts`** to keep the Node-only
 * runtime out of the platform graph.
 */

export {
  SESSION_COOKIE,
  CSRF_HEADER,
  CSRF_VALUE,
  buildClearSessionCookie,
  buildSessionCookie,
  parseCookieHeader,
  toSessionUser,
  type DevIdentity,
} from './session-cookies.ts'

export interface SessionRecord {
  tokenHash: string
  userId: string
  createdAt: string
  expiresAt: string
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export class SessionStore {
  constructor(
    private readonly db: Database,
    private readonly users: UserRepository,
    private readonly ttlSeconds: number,
  ) {}

  /** Issue a new session token for a user. Returns the raw token once. */
  async issue(userId: string): Promise<{ token: string; expiresAt: string }> {
    const token = randomBytes(32).toString('base64url')
    const createdAt = nowIso()
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000).toISOString()
    run(
      this.db,
      'INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      [hashToken(token), userId, createdAt, expiresAt],
    )
    this.purgeExpired()
    return { token, expiresAt }
  }

  async resolve(token: string): Promise<UserRecord | null> {
    if (!token || token.length < 20) return null
    const row = get<{ user_id: string; expires_at: string }>(
      this.db,
      'SELECT user_id, expires_at FROM sessions WHERE token_hash = ?',
      [hashToken(token)],
    )
    if (!row) return null
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      run(this.db, 'DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)])
      return null
    }
    return this.users.findById(row.user_id)
  }

  async revoke(token: string): Promise<void> {
    if (!token) return
    run(this.db, 'DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)])
  }

  async revokeAllForUser(userId: string): Promise<void> {
    run(this.db, 'DELETE FROM sessions WHERE user_id = ?', [userId])
  }

  purgeExpired(): void {
    run(this.db, 'DELETE FROM sessions WHERE expires_at <= ?', [nowIso()])
  }
}

/** Derive a deterministic local user id from an email, for dev sign-in. */
export { devUserId } from './session-cookies.ts'

export function newUserId(): string {
  return createId('usr')
}
