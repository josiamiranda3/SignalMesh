import type { Context, MiddlewareHandler } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { SessionUser } from '../../shared/api.ts'
import type { Services } from '../services/index.ts'
import type { UserRecord } from '../types.ts'
import { errors } from '../lib/errors.ts'
import { CSRF_HEADER, CSRF_VALUE, SESSION_COOKIE, parseCookieHeader } from '../lib/sessions.ts'

/**
 * Request context and auth middleware.
 *
 * `requireUser` resolves the session into a real user row. It re-checks the
 * database on every request rather than trusting a claim inside the token, so
 * a revoked session or deleted user stops working immediately.
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
  }
}

/** Attach services to the context for every request. */
export function withServices(services: Services): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    c.set('services', services)
    c.set('requestId', crypto.randomUUID())
    await next()
  })
}

/** Reject state-changing requests that do not carry the CSRF marker header. */
export function csrfGuard(services: Services): MiddlewareHandler<AppEnv> {
  return createMiddleware<AppEnv>(async (c, next) => {
    const method = c.req.method
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      await next()
      return
    }
    const origin = c.req.header('origin')
    const allowed = new Set([services.config.appOrigin])
    if (origin && !allowed.has(origin)) {
      throw errors.forbidden('Origem da requisição não é permitida')
    }
    if (c.req.header(CSRF_HEADER) !== CSRF_VALUE) {
      throw errors.forbidden('Cabeçalho de proteção ausente. Recarregue a página e tente novamente.')
    }
    await next()
  })
}

/** Require an authenticated, still-existing user. */
export const requireUser: MiddlewareHandler<AppEnv> = createMiddleware<AppEnv>(async (c, next) => {
  const services = c.get('services')
  const cookies = parseCookieHeader(c.req.header('cookie') ?? null)
  const token = cookies[SESSION_COOKIE]
  if (!token) throw errors.unauthorized('Faça login para acessar esta área.')

  const user = await services.sessions.resolve(token)
  if (!user) throw errors.unauthorized('Sessão expirada ou inválida. Faça login novamente.')

  c.set('user', user)
  await next()
})

export function currentUser(c: Context<AppEnv>): UserRecord {
  return c.get('user')
}

export function toPublicUser(user: UserRecord): SessionUser {
  return { id: user.id, name: user.name, email: user.email, avatarUrl: user.avatarUrl }
}
