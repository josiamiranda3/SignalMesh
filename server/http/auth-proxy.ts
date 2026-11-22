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
 * (`/config`, `/me`, `/login`, `/logout`, `/social-redirect`) are registered
 * **before** this wildcard so they keep precedence; this mount is the fallback
 * for everything the platform owns (`/token`, `/sign-in/*`, `/sign-out`,
 * `/social-redirect`, `/oauth-complete`, `/session`, …).
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
  '/api/auth/social-redirect',
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
  /**
   * The app's public origin (`APP_ORIGIN`), e.g. `https://signalmess.app.space`.
   *
   * Used as the `callbackURL` when starting a social sign-in. It must be the
   * *configured* origin, not the `Host` of the incoming request: the platform
   * auth worker validates `callbackURL` against its trusted-origins list and
   * answers **403** for an origin it does not know. Deriving it from the request
   * would also make it caller-controllable, which is exactly what a redirect
   * target must never be.
   */
  appOrigin?: string
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

/**
 * Providers the social bridge will forward.
 *
 * An allowlist, not a passthrough: the value is interpolated into an upstream
 * request body, so an arbitrary string would let a caller probe the auth
 * worker's provider map. These two are what the SDK's `AuthOverlay` offers.
 */
const SOCIAL_PROVIDERS = new Set(['github', 'google'])

/** Exported so tests can assert the same list the route enforces. */
export function isSupportedSocialProvider(value: unknown): value is string {
  return typeof value === 'string' && SOCIAL_PROVIDERS.has(value)
}

/**
 * `GET /api/auth/social-redirect?provider=<google|github>`
 *
 * ## The defect this fixes (two rounds)
 *
 * **Round 1 (404).** The SDK's `AuthOverlay` starts a social sign-in with a
 * top-level browser navigation to `/api/auth/social-redirect?provider=…`
 * (`node_modules/deepspace/dist/index.js`, `handleSocial`). That path exists
 * **only** in the SDK's browser code — `deepspace/worker` and the platform auth
 * worker do not implement it — so the proxy forwarded it and the auth worker
 * answered 404.
 *
 * **Round 2 (state_mismatch).** The first fix made this route call
 * `POST https://auth.deep.space/api/auth/sign-in/social` server-to-server and
 * redirect to the `url` it returned. That produced
 * `/login/social/error?error=state_mismatch`, because the OAuth state lives in
 * a **cookie the browser must hold**:
 *
 *     set-cookie: __Secure-better-auth.state  Max-Age=300; Path=/; HttpOnly;
 *                                            Secure; SameSite=None
 *
 * The `__Secure-` prefix *forbids* a `Domain` attribute, so the cookie is
 * host-only to `auth.deep.space`. A server-to-server fetch receives that
 * `Set-Cookie` in a Response the browser never sees, and our origin
 * (`signalmess.app.space`) is not allowed to set a cookie for another host.
 * The state was created but never stored → the callback's state matched nothing.
 *
 * ## The officially supported mechanism
 *
 * The auth worker serves a **browser-navigable** page that performs the same
 * start *and* sets the state cookie on its own origin:
 *
 *     GET https://auth.deep.space/login/social?provider=google&returnTo=<app url>
 *       → 302 to the provider's authorize URL
 *       + set-cookie __Secure-better-auth.state   (host-only, secure)
 *       + set-cookie social_csrf_<uuid>           (Path=/login/social/complete)
 *
 * This is the same construction the SDK's own native bridge uses
 * (`nativeAuthStart` in `deepspace/worker`, which redirects to
 * `${AUTH_WORKER_URL}/login/social?provider=…&returnTo=…`). It is verified live
 * for both providers.
 *
 * So the route is now a **redirect, not a fetch**: the browser is sent to the
 * auth worker's page, which mints and stores the state in the only place it can
 * legally live. PKCE and state validation stay entirely on the platform — this
 * route never sees, computes, or validates either.
 *
 * ## What this route still refuses to do
 *
 * It does not build an OAuth URL, does not touch a client secret, does not read
 * or mint a token, does not set a cookie, and does not decide who the user is.
 * `returnTo` is the app's **configured** origin plus a fixed path, never the
 * request's Host and never a caller-supplied URL, so the route cannot become an
 * open redirect.
 */
export function createSocialRedirectRoutes(options: AuthProxyOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/social-redirect', async (c) => {
    const provider = c.req.query('provider')

    if (!isSupportedSocialProvider(provider)) {
      return c.json(
        {
          success: false as const,
          error: {
            code: 'unsupported_provider',
            message: 'Provider social não suportado.',
            retryable: false,
          },
        },
        400,
      )
    }

    const authWorkerUrl = options.authWorkerUrl
    if (!authWorkerUrl) {
      // Fail closed and explicitly, exactly like the proxy does.
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

    // Where the auth worker sends the browser after the provider handshake.
    //
    // The **configured** origin, not the request's Host: deriving it from the
    // request would make the return target caller-controlled, which is the open
    // redirect this route must never become. `appOrigin` comes from
    // `loadConfig` (`APP_ORIGIN`), the same value that feeds
    // `authorizedParties`.
    const appOrigin = options.appOrigin
    if (!appOrigin) {
      return c.json(
        {
          success: false as const,
          error: {
            code: 'auth_unavailable',
            message: 'APP_ORIGIN não configurado; autenticação social indisponível.',
            retryable: false,
          },
        },
        503,
      )
    }

    // Only an https origin may be produced, so a misconfigured worker cannot
    // send the browser to a plaintext or non-web scheme.
    let workerOrigin: URL
    try {
      workerOrigin = new URL(authWorkerUrl)
    } catch {
      return c.json(
        {
          success: false as const,
          error: {
            code: 'auth_unavailable',
            message: 'AUTH_WORKER_URL inválido; autenticação social indisponível.',
            retryable: false,
          },
        },
        503,
      )
    }
    if (workerOrigin.protocol !== 'https:') {
      return c.json(
        {
          success: false as const,
          error: {
            code: 'auth_unavailable',
            message: 'AUTH_WORKER_URL deve usar https.',
            retryable: false,
          },
        },
        503,
      )
    }

    const start = new URL('/login/social', workerOrigin)
    start.searchParams.set('provider', provider)
    // The auth worker validates this against its own trusted origins; it is the
    // app's configured origin plus a fixed path, never caller input.
    start.searchParams.set('returnTo', `${appOrigin.replace(/\/$/, '')}/dashboard`)

    // A plain 302: the browser must perform this navigation so the auth worker's
    // Set-Cookie lands on *its* origin.
    return c.redirect(start.toString(), 302)
  })

  return app
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
