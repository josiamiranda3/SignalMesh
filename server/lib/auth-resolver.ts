import type { SessionUser } from '../../shared/api.ts'
import type { UserRecord } from '../types.ts'
import type { AuthMode } from '../lib/auth-context.ts'
import { userRecordFromClaims } from '../lib/auth-context.ts'
import { bearerToken, localSessionToken } from '../http/middleware.ts'
import type { SessionStore } from '../lib/sessions.ts'
import type { UserRepository } from '../repositories/ports.ts'

/**
 * Identity resolution.
 *
 * The single place that answers "who is calling?". Everything else — services,
 * authorization, quotas, audit — receives a `UserRecord` and never learns how
 * it was established.
 *
 * ## DeepSpace mode
 *
 * Uses `verifyJwt` from `deepspace/worker` against the platform's public key
 * and issuer, which the runtime injects as bindings (`AUTH_JWT_PUBLIC_KEY`,
 * `AUTH_JWT_ISSUER`). The token is read from the `Authorization: Bearer`
 * header first (the SDK client attaches it) and falls back to the platform's
 * session cookie, which is what a same-origin browser navigation carries.
 *
 * The app never mints, signs, refreshes, or stores a JWT. There is no shared
 * secret here that could be used to forge one.
 *
 * ## Local mode (tests only)
 *
 * A session row created by the local adapter. It is refused when the runtime is
 * the DeepSpace platform, so a deployed app cannot be entered this way even if
 * a stale cookie is presented.
 */

export interface ResolvedIdentity {
  user: UserRecord
  mode: AuthMode
  claims: Record<string, unknown> | null
}

/** The subset of platform bindings this resolver needs. */
export interface JwtVerifierBindings {
  AUTH_JWT_PUBLIC_KEY?: string
  AUTH_JWT_ISSUER?: string
}

export interface AuthResolverOptions {
  mode: AuthMode
  sessions: SessionStore
  users: UserRepository
  /**
   * `verifyJwt` from `deepspace/worker`, injected so tests can supply one.
   *
   * The real implementation verifies the ES256 signature against the platform's
   * public key and enforces `iss`, `exp`, `nbf` and an expected `scope` when the
   * token carries one.
   */
  verifyJwt: (
    config: { publicKey: string; issuer: string; authorizedParties?: string[] },
    token: string | null | undefined,
  ) => Promise<{ result: unknown }>
  /** Platform bindings carrying the verification key and issuer. */
  bindings: () => JwtVerifierBindings
  /** Resolve a user row from verified claims (DeepSpace provisioning). */
  ensureUser: (user: UserRecord) => Promise<UserRecord>
  /**
   * Origins a platform token may be bound to (`azp`).
   *
   * Empty means "do not constrain": signature, issuer and expiry are still
   * verified, but a token minted for a different app would be accepted. Set this
   * to the app's own origins so a token issued for another app is refused even
   * though its signature is valid.
   */
  authorizedParties?: () => string[]
}

export class AuthResolver {
  constructor(private readonly options: AuthResolverOptions) {}

  get mode(): AuthMode {
    return this.options.mode
  }

  async resolve(request: Request): Promise<ResolvedIdentity | null> {
    if (this.options.mode === 'deepspace') return this.resolveDeepSpace(request)
    return this.resolveLocal(request)
  }

  // -------------------------------------------------------------------------

  private async resolveDeepSpace(request: Request): Promise<ResolvedIdentity | null> {
    const bindings = this.options.bindings()
    const publicKey = bindings.AUTH_JWT_PUBLIC_KEY
    const issuer = bindings.AUTH_JWT_ISSUER
    if (!publicKey || !issuer) {
      // No verifier configuration means no way to authenticate. Fail closed
      // rather than silently trusting a header.
      return null
    }

    const token = this.extractPlatformToken(request)
    if (!token) return null

    // `authorizedParties`, when configured, binds the token to this app's
    // origins: a session minted for another app is refused even though its
    // signature is valid. The platform passes `azp` on the token; the SDK
    // compares it with the patterns and *allows a missing azp* through, so this
    // is a narrowing, not the only control — signature, issuer and expiry are
    // still enforced inside `verifyJwt`.
    const verifierConfig: {
      publicKey: string
      issuer: string
      authorizedParties?: string[]
    } = { publicKey, issuer }
    const parties = this.options.authorizedParties?.() ?? []
    if (parties.length > 0) verifierConfig.authorizedParties = parties

    const outcome = await this.options.verifyJwt(verifierConfig, token)
    const verified = outcome.result as { userId?: string; claims?: Record<string, unknown> } | null
    if (!verified?.userId) return null

    const claims = verified.claims ?? {}
    const candidate = userRecordFromClaims({ userId: verified.userId, claims })

    // The users row is provisioned by the platform's connect flow. Deriving it
    // from verified claims keeps this path independent of that timing, and the
    // row (when present) is preferred because it carries the current name.
    const stored = await this.options.users.findById(verified.userId)
    const user = stored
      ? {
          ...stored,
          // Claims are fresher than a row written at first sign-in.
          name: candidate.name || stored.name,
          email: candidate.email || stored.email,
          avatarUrl: candidate.avatarUrl ?? stored.avatarUrl,
        }
      : await this.options.ensureUser(candidate)

    return { user, mode: 'deepspace', claims }
  }

  /**
   * Token sources, in order:
   *  1. `Authorization: Bearer` — what the SDK's `getAuthToken()` produces.
   *  2. The platform session cookie — what a document navigation carries.
   */
  private extractPlatformToken(request: Request): string | null {
    const bearer = bearerToken(request)
    if (bearer) return bearer

    const cookies = parseCookie(request.headers.get('cookie'))
    // The SDK's own cookie name; the value is the raw session token.
    return cookies['__Secure-better-auth.session_token'] ?? cookies['better-auth.session_token'] ?? null
  }

  // -------------------------------------------------------------------------

  private async resolveLocal(request: Request): Promise<ResolvedIdentity | null> {
    const token = localSessionToken(request)
    if (!token) return null
    const user = await this.options.sessions.resolve(token)
    if (!user) return null
    return { user, mode: 'local', claims: null }
  }
}

function parseCookie(header: string | null): Record<string, string> {
  if (!header) return {}
  const result: Record<string, string> = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    const key = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (key) {
      try {
        result[key] = decodeURIComponent(value)
      } catch {
        result[key] = value
      }
    }
  }
  return result
}

/** Convenience for the auth config endpoint. */
export function describeAuthMode(mode: AuthMode, environment: string): {
  authMode: AuthMode
  environment: string
  signInLabel: string
  providerLabel: string
  deepspaceAuthAvailable: boolean
} {
  if (mode === 'deepspace') {
    return {
      authMode: 'deepspace',
      environment,
      signInLabel: 'Entrar com DeepSpace',
      providerLabel: 'Autenticação DeepSpace',
      deepspaceAuthAvailable: true,
    }
  }
  return {
    authMode: 'local',
    environment,
    signInLabel: 'Entrar com e-mail (ambiente local)',
    providerLabel: 'Autenticação local de desenvolvimento',
    deepspaceAuthAvailable: false,
  }
}

/**
 * Session user shape used by the API responses.
 *
 * Re-declared here to keep the resolver independent of the HTTP layer.
 */
export type PublicUser = SessionUser
