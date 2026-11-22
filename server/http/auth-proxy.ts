import { Hono } from 'hono'
import { authWorkerFetch } from 'deepspace/worker'
import type { AppEnv } from './middleware.ts'

/**
 * DeepSpace auth proxy.
 *
 * ## Why this route must exist
 *
 * The SDK's browser client does not talk to the auth worker directly; it talks
 * to **this app's origin**, and the app forwards. Concretely:
 *
 *  - `signIn.email()` / the OAuth buttons drive `better-auth` against the
 *    app origin (`authClient.baseURL = window.location.origin`).
 *  - `getAuthToken()` — used by `RecordProvider` and every SDK hook — calls
 *    `POST /api/auth/token` on the app origin with `credentials: 'include'` and
 *    expects `{ token }`, a JWT signed by the platform.
 *
 * Without this proxy those calls land on the app's own Hono routes, which know
 * nothing about `token`, and every authenticated surface fails: the browser
 * never obtains a JWT, so `resolveIdentity` sees no credential and `/api/*`
 * answers 401 to a signed-in user.
 *
 * ## Identity is never trusted from the client
 *
 * The proxy forwards method, headers and body unchanged, and copies the
 * response back. It does not mint, decode, or inspect a token; it also does not
 * accept identity from any header. The credential is the platform session
 * cookie, which the **auth worker** validates and exchanges for a JWT. That is
 * why a `Set-Cookie` returned by the auth worker is forwarded on the app's own
 * origin (with any `Domain` attribute stripped, so the cookie cannot be scoped
 * to another host).
 *
 * ## Scoping
 *
 * Only `/api/auth/*` is proxied — the prefix `worker.ts` already routes to the
 * worker before the asset layer. The app's own endpoints under that prefix
 * (`/config`, `/me`, `/login`, `/logout`) are registered **before** this
 * wildcard so they keep precedence; this mount is the fallback for everything
 * the platform owns (`/token`, `/sign-in/*`, `/sign-out`, `/social-redirect`,
 * `/oauth-complete`, `/session`, …).
 */

/**
 * Paths the app implements itself and must not forward to the auth worker.
 *
 * Exported because two layers need the same answer: this proxy (which must not
 * forward them) and the CSRF guard (which must keep guarding them). One list,
 * so the two cannot drift into a gap where a path is neither proxied nor
 * guarded.
 */
export const APP_OWNED_AUTH_PATHS = new Set([
  '/api/auth/config',
  '/api/auth/me',
  '/api/auth/login',
  '/api/auth/logout',
])

/**
 * Is this a path the app forwards to the platform auth worker?
 *
 * True only for `/api/auth/*` paths the app does not own. Those requests are
 * the SDK's own sign-in surface (`/token`, `/sign-in/*`, `/sign-out`, the OAuth
 * callbacks), and the auth worker applies its own CSRF and `trustedOrigins`
 * checks to them — it does not know this app's marker header.
 */
export function isPlatformAuthPath(path: string): boolean {
  return path.startsWith('/api/auth/') && !APP_OWNED_AUTH_PATHS.has(path)
}

export interface AuthProxyOptions {
  /** Platform auth-worker base URL, injected by the deploy as `AUTH_WORKER_URL`. */
  authWorkerUrl?: string
}

/**
 * Copy a proxied response, rewriting the session cookie for this origin.
 *
 * `Set-Cookie` is stripped of any `Domain=` attribute: the auth worker names its
 * own host, and a browser would reject (or wrongly scope) that cookie on the
 * app's domain. Everything else — status, headers, body — is passed through.
 */
function copyAuthResponse(response: Response): Response {
  const headers = new Headers(response.headers)
  const setCookie = headers.get('set-cookie')
  if (setCookie) {
    headers.set('set-cookie', setCookie.replace(/;\s*Domain=[^;]*/gi, ''))
  }
  return new Response(response.body, { status: response.status, headers })
}

export function createAuthProxyRoutes(options: AuthProxyOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // A catch-all is required, not a `*`: the platform's routes are nested
  // (`/sign-in/email`, `/sign-in/social`, `/sign-in/oauth2/callback`), and Hono's
  // `*` matches a single path segment. A single-segment pattern silently 404s
  // every multi-segment auth call — which is most of the sign-in surface.
  app.all('/:path{.*}', async (c) => {
    const url = new URL(c.req.url)

    // The app's own routes win. This is a fallback, not a replacement.
    if (!isPlatformAuthPath(url.pathname)) {
      return c.notFound()
    }

    const authWorkerUrl = options.authWorkerUrl
    if (!authWorkerUrl) {
      // Fail closed and explicitly: silently answering here would look like a
      // signed-out user instead of a misconfigured deployment.
      return c.json(
        {
          success: false as const,
          error: {
            code: 'auth_unavailable',
            message: 'O encaminhamento de autenticação não está configurado (AUTH_WORKER_URL ausente).',
            retryable: false,
          },
        },
        503,
      )
    }

    const method = c.req.method
    const hasBody = method !== 'GET' && method !== 'HEAD'

    // CORS preflight answers are the auth worker's to make; forwarding the
    // request verbatim keeps a single source of truth for allowed origins.
    const upstream = await authWorkerFetch({ AUTH_WORKER_URL: authWorkerUrl }, url.pathname + url.search, {
      method,
      headers: c.req.raw.headers,
      body: hasBody ? c.req.raw.body : undefined,
      // Redirects are returned to the browser, not followed here: the OAuth
      // flow depends on the browser performing the navigation.
      redirect: 'manual',
    })

    return copyAuthResponse(upstream)
  })

  return app
}
