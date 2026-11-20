import type { Context, MiddlewareHandler } from 'hono'
import type { SessionUser } from '../../shared/api.ts'
import type { Services } from '../services/index.ts'
import type { UserRecord } from '../types.ts'
import type { AuthMode } from '../lib/auth-context.ts'
import { errors } from '../lib/errors.ts'
import { CSRF_HEADER, CSRF_VALUE, SESSION_COOKIE, parseCookieHeader } from '../lib/sessions.ts'

/**
 * Request context and auth middleware.
 *
 * `requireUser` resolves the caller's identity through the adapter the runtime
 * selected, then loads (or derives) the `UserRecord`. It runs on every private
 * route, so there is no code path that reaches a service without a resolved
 * identity — the frontend's `<AuthGate>` is a convenience, not the boundary.
 */

export interface RequestContext {
  services: Services
  user: UserRecord | null
}

export type AppEnv = {
  Variables: {
    services: Services
    user: UserRecord
    requestId: string
    authMode: AuthMode
    authClaims: Record<string, unknown> | null
  }
}

/** Attach services to the context for every request. */
export function withServices(services: Services): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set('services', services)
    c.set('requestId', crypto.randomUUID())
    c.set('authMode', services.config.authMode)
    await next()
  }
}

/**
 * CSRF protection for state-changing requests.
 *
 * A mutating request must carry an explicit marker header, and its `Origin` must
 * be this app. "This app" is checked two ways:
 *
 *  1. the request's own origin — a same-origin form or fetch is always correct,
 *     which is what every call the app itself makes is;
 *  2. `APP_ORIGIN` / `ALLOWED_ORIGINS`, for a reverse proxy that terminates TLS
 *     or rewrites the host, where the request URL does not reflect the public
 *     origin.
 *
 * Accepting (1) is deliberate and not a loosening: an attacker cannot make the
 * browser report *their* origin and this app's origin at the same time, and the
 * marker header still cannot be set cross-origin without a preflight the app
 * never grants.
 */
export function csrfGuard(services: Services): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const method = c.req.method
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      await next()
      return
    }

    const origin = c.req.header('origin')
    if (origin) {
      const requestOrigin = new URL(c.req.url).origin
      const allowed = new Set([services.config.appOrigin, requestOrigin])
      for (const candidate of services.config.allowedOrigins) allowed.add(candidate)
      if (!allowed.has(origin)) {
        throw errors.forbidden('Origem da requisição não é permitida')
      }
    }

    if (c.req.header(CSRF_HEADER) !== CSRF_VALUE) {
      throw errors.forbidden('Cabeçalho de proteção ausente. Recarregue a página e tente novamente.')
    }

    await next()
  }
}

/**
 * Require an authenticated user.
 *
 * Delegates to `services.auth.resolve`, which is the single place that knows
 * whether identity comes from a verified platform JWT or the local adapter.
 */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const services = c.get('services')
  const resolved = await services.auth.resolve(c.req.raw)

  if (!resolved) {
    throw errors.unauthorized('Faça login para acessar esta área.')
  }

  c.set('user', resolved.user)
  c.set('authMode', resolved.mode)
  c.set('authClaims', resolved.claims)
  await next()
}

export function currentUser(c: Context<AppEnv>): UserRecord {
  return c.get('user')
}

export function toPublicUser(user: UserRecord): SessionUser {
  return { id: user.id, name: user.name, email: user.email, avatarUrl: user.avatarUrl }
}

/** Read the local session token from a cookie, if any. */
export function localSessionToken(request: Request): string | null {
  const cookies = parseCookieHeader(request.headers.get('cookie'))
  return cookies[SESSION_COOKIE] ?? null
}

/** Read a bearer token from the Authorization header, if any. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization')
  return header?.startsWith('Bearer ') ? header.slice(7).trim() || null : null
}
