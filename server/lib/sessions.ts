import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { SessionUser } from '../../shared/api.ts'
import type { UserRecord } from '../types.ts'
import type { UserRepository } from '../repositories/ports.ts'
import { get, run, type Database } from '../db.ts'
import { errors } from './errors.ts'
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
 */

export const SESSION_COOKIE = 'signalmess_session'

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

/** Strip everything the API must never expose (email is user-private). */
export function toSessionUser(user: UserRecord): SessionUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl,
  }
}

/**
 * The local runtime issues its own sessions. This module also provides the
 * development sign-in identities: a fixed set of local accounts so an operator
 * can test isolation between two users without creating an external account.
 */
export interface DevIdentity {
  email: string
  name: string
}

export function parseCookieHeader(header: string | null): Record<string, string> {
  if (!header) return {}
  const result: Record<string, string> = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (key) result[key] = decodeURIComponent(value)
  }
  return result
}

export function buildSessionCookie(token: string, options: { maxAge: number; secure: boolean }): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${options.maxAge}`,
  ]
  if (options.secure) parts.push('Secure')
  return parts.join('; ')
}

export function buildClearSessionCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/** Constant-time comparison used by the CSRF token check. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * CSRF protection: state-changing requests must carry the same-origin marker
 * header. Combined with SameSite=Lax cookies this blocks cross-site form posts.
 */
export const CSRF_HEADER = 'x-signalmess-request'
export const CSRF_VALUE = '1'

export function requireSameOrigin(headers: Headers, appOrigin: string): void {
  const origin = headers.get('origin')
  if (origin && origin !== appOrigin) {
    throw errors.forbidden('Origem da requisição não permitida')
  }
  if (headers.get(CSRF_HEADER) !== CSRF_VALUE) {
    throw errors.forbidden('Requisição sem o cabeçalho de proteção CSRF')
  }
}

/** Derive a deterministic local user id from an email, for dev sign-in. */
export function devUserId(email: string): string {
  const normalized = email.trim().toLowerCase()
  return `usr_${createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`
}

/** HMAC used to sign nothing but the demo seed marker. Kept for symmetry. */
export function signValue(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url')
}

export function newUserId(): string {
  return createId('usr')
}
