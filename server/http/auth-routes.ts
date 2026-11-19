import { Hono } from 'hono'
import { z } from 'zod'
import type { SessionUser } from '../../shared/api.ts'
import type { AppEnv } from './middleware.ts'
import { requireUser, toPublicUser } from './middleware.ts'
import { errors } from '../lib/errors.ts'
import {
  buildClearSessionCookie,
  buildSessionCookie,
  devUserId,
  parseCookieHeader,
  SESSION_COOKIE,
} from '../lib/sessions.ts'
import { createId, nowIso } from '../lib/util.ts'

/**
 * Local authentication adapter.
 *
 * DeepSpace Auth is the production mechanism and is wired in the worker
 * adapter (a verified JWT arrives from the platform). The local runtime needs a
 * real, persistent, revocable session to exercise the app end to end, so this
 * adapter issues its own session through the same `sessions` table and the same
 * `requireUser` middleware the rest of the API uses.
 *
 * This is explicitly a development identity provider: it trusts the email the
 * operator types, which is acceptable only on a machine the operator controls.
 * The UI labels it accordingly and the server refuses it in production.
 */

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Informe um e-mail válido').max(254),
  name: z.string().trim().min(1, 'Informe seu nome').max(80).optional(),
})

export function createAuthRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  /** Describe which auth adapter is active so the UI can label it honestly. */
  app.get('/config', (c) => {
    const services = c.get('services')
    return c.json({
      success: true as const,
      data: {
        authMode: 'local' as const,
        environment: services.config.nodeEnv,
        signInLabel: 'Entrar com e-mail (ambiente local)',
        providerLabel: 'Autenticação local de desenvolvimento',
        deepspaceAuthAvailable: false,
      },
    })
  })

  app.get('/me', requireUser, (c) => {
    const user = c.get('user')
    const payload: SessionUser = toPublicUser(user)
    return c.json({ success: true as const, data: payload })
  })

  app.post('/login', async (c) => {
    const services = c.get('services')
    if (services.config.nodeEnv === 'production') {
      // Production must use DeepSpace Auth; the local adapter is not a
      // substitute for a real identity provider.
      throw errors.forbidden(
        'A autenticação local está desativada em produção. Configure o DeepSpace Auth.',
      )
    }

    const body = await c.req.json().catch(() => null)
    const parsed = loginSchema.safeParse(body)
    if (!parsed.success) {
      throw errors.invalid(
        'Dados de acesso inválidos',
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.') || '(raiz)',
          message: issue.message,
        })),
      )
    }

    const email = parsed.data.email
    const name = parsed.data.name?.trim() || email.split('@')[0] || 'Pesquisador'
    const existing = await services.repos.users.findByEmail(email)
    const user =
      existing ??
      (await services.repos.users.upsert({
        id: devUserId(email) || createId('usr'),
        email,
        name,
        avatarUrl: null,
        createdAt: nowIso(),
      }))

    const session = await services.sessions.issue(user.id)
    const secure = services.config.appOrigin.startsWith('https://')

    return new Response(
      JSON.stringify({ success: true, data: toPublicUser(user) }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'set-cookie': buildSessionCookie(session.token, {
            maxAge: services.config.sessionTtlSeconds,
            secure,
          }),
        },
      },
    )
  })

  app.post('/logout', async (c) => {
    const services = c.get('services')
    const cookies = parseCookieHeader(c.req.header('cookie') ?? null)
    const token = cookies[SESSION_COOKIE]
    if (token) await services.sessions.revoke(token)
    const secure = services.config.appOrigin.startsWith('https://')
    return new Response(JSON.stringify({ success: true, data: { signedOut: true } }), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': buildClearSessionCookie(secure),
      },
    })
  })

  return app
}
