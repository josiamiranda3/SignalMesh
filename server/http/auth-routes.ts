import { Hono } from 'hono'
import { z } from 'zod'
import type { SessionUser } from '../../shared/api.ts'
import type { AppEnv } from './middleware.ts'
import { requireUser, toPublicUser } from './middleware.ts'
import { errors } from '../lib/errors.ts'
import { describeAuthMode } from '../lib/auth-resolver.ts'
import {
  buildClearSessionCookie,
  buildSessionCookie,
  devUserId,
  parseCookieHeader,
  SESSION_COOKIE,
} from '../lib/sessions.ts'
import { createId, nowIso } from '../lib/util.ts'

/**
 * Authentication routes.
 *
 * ## DeepSpace mode (production and `deepspace dev start`)
 *
 * Sign-in happens through the platform's own auth worker, driven in the browser
 * by `AuthOverlay` / `signIn()` from the SDK. The app therefore exposes only:
 *
 *   - `GET /config` — which adapter is active, for honest UI copy
 *   - `GET /me`     — the verified caller, read from a verified JWT
 *   - `POST /logout`— clears the platform session cookie and confirms
 *
 * `/login` returns 404 in this mode: there is no local credential endpoint to
 * call, and presenting one would invite a parallel auth system.
 *
 * ## Local mode (tests only)
 *
 * `/login` issues a session row used by the integration and browser suites. The
 * runtime refuses this adapter on the platform (`assertProductionSafety`), so it
 * cannot be reached from a deployed app.
 */

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Informe um e-mail válido').max(254),
  name: z.string().trim().min(1, 'Informe seu nome').max(80).optional(),
})

export function createAuthRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  /** Describe the active adapter so the UI can label itself honestly. */
  app.get('/config', (c) => {
    const services = c.get('services')
    return c.json({
      success: true as const,
      data: describeAuthMode(services.config.authMode, services.config.nodeEnv),
    })
  })

  app.get('/me', requireUser, (c) => {
    const user = c.get('user')
    const payload: SessionUser = toPublicUser(user)
    return c.json({ success: true as const, data: payload })
  })

  app.post('/login', async (c) => {
    const services = c.get('services')

    if (services.config.authMode !== 'local') {
      // DeepSpace apps authenticate through the platform. There is deliberately
      // no credential endpoint here to call.
      throw errors.notFound('Este ambiente usa a autenticação DeepSpace; entre pela plataforma.')
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

    // The session store only exists on the Node runtime.
    const sessions = (services as unknown as { sessions?: { issue(userId: string): Promise<{ token: string }> } })
      .sessions
    if (!sessions) {
      throw errors.notFound('Sessões locais não estão disponíveis neste runtime.')
    }

    const session = await sessions.issue(user.id)
    const secure = services.config.appOrigin.startsWith('https://')

    return new Response(JSON.stringify({ success: true, data: toPublicUser(user) }), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': buildSessionCookie(session.token, {
          maxAge: services.config.sessionTtlSeconds,
          secure,
        }),
      },
    })
  })

  /**
   * Sign out.
   *
   * In DeepSpace mode the platform owns the session, so this expires the app's
   * copy of the platform cookie and returns; the SDK's `signOut()` performs the
   * authoritative revocation against the auth worker. The handler does not call
   * the auth worker itself, which would need an outbound request per logout.
   */
  app.post('/logout', async (c) => {
    const services = c.get('services')
    const secure = services.config.appOrigin.startsWith('https://')

    if (services.config.authMode === 'local') {
      const cookies = parseCookieHeader(c.req.header('cookie') ?? null)
      const token = cookies[SESSION_COOKIE]
      const sessions = (services as unknown as { sessions?: { revoke(token: string): Promise<void> } }).sessions
      if (token && sessions) await sessions.revoke(token)
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json; charset=utf-8',
      'set-cookie': buildClearSessionCookie(secure),
    }
    if (services.config.authMode === 'deepspace') {
      // Expire the platform session cookie on this origin too, so a reload does
      // not silently re-authenticate from a cookie the user just signed out of.
      headers['set-cookie'] =
        `${buildClearSessionCookie(secure)}, __Secure-better-auth.session_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`
    }

    return new Response(JSON.stringify({ success: true, data: { signedOut: true } }), {
      status: 200,
      headers,
    })
  })

  return app
}
