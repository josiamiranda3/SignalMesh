import type { SessionUser } from '../../shared/api.ts'
import type { UserRecord } from '../types.ts'

/**
 * Cookie and CSRF primitives shared by both runtimes.
 *
 * ## Why this is separate from `sessions.ts`
 *
 * `sessions.ts` owns the local `SessionStore`, which reads and writes the local
 * SQLite database and therefore imports `node:sqlite` at module scope. The
 * primitives below are needed by the **Worker** as well: the CSRF guard parses
 * cookies, the auth routes build and clear the session cookie, and the platform
 * lane has to recognise a browser-carried cookie.
 *
 * While both lived in one module, importing a cookie helper pulled the Node-only
 * database adapter into the Worker bundle. DeepSpace runs on workerd, where
 * `node:sqlite` is not available at the app's compatibility date, so that single
 * import made the production build unbundleable. Keeping the pure helpers here
 * means the edge graph never reaches the SQLite runtime.
 *
 * Nothing in this module may import `node:*`, the database, or the repositories.
 */

/** Cookie name used by the local runtime's own sessions. */
export const SESSION_COOKIE = 'signalmess_session'

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

export function buildSessionCookie(
  token: string,
  options: { maxAge: number; secure: boolean },
): string {
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

/**
 * CSRF protection: state-changing requests must carry the same-origin marker
 * header. Combined with SameSite=Lax cookies this blocks cross-site form posts.
 */
export const CSRF_HEADER = 'x-signalmess-request'
export const CSRF_VALUE = '1'

/**
 * Derive a deterministic local user id from an email, for dev sign-in.
 *
 * Pure, and built on Web Crypto so it runs identically under Node and workerd
 * without importing `node:crypto` into the edge graph. This is an identifier,
 * not a credential: the digest only has to be stable and collision-resistant,
 * never secret.
 */
export async function devUserId(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase()
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized))
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return `usr_${hex.slice(0, 16)}`
}
