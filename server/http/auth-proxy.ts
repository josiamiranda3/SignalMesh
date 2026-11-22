import { Hono, type Context } from 'hono'
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
  '/api/auth/oauth-complete',
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
    // Where the auth worker returns the browser with the one-time code.
    //
    // It must be our own completion route, not `/dashboard`: the code has to be
    // redeemed server-side (`oauth-complete` below), and the platform does not
    // implement that path. This mirrors the SDK's own `nativeAuthStart`, which
    // builds `<app origin>/api/auth/oauth-complete` as the `returnTo` — verified
    // live, including that the start page accepts an `/api/auth/*` returnTo.
    //
    // The origin is the **configured** one, never the request Host, so this
    // cannot become an open redirect.
    start.searchParams.set('returnTo', `${appOrigin.replace(/\/$/, '')}/api/auth/oauth-complete`)

    // A plain 302: the browser must perform this navigation so the auth worker's
    // Set-Cookie lands on *its* origin.
    return c.redirect(start.toString(), 302)
  })

  /**
   * `GET /api/auth/oauth-complete?code=…`
   *
   * ## Why this route exists (the third and current defect)
   *
   * After the provider handshake the auth worker sends the browser back to the
   * `returnTo` it was given, carrying a one-time `code`. The SDK names the
   * destination `/api/auth/oauth-complete` on the **app's** origin
   * (`nativeAuthStart` builds exactly that URL) — so this endpoint is
   * **app-owned**. The platform does not implement it: a live probe of
   * `auth.deep.space/api/auth/oauth-complete` returns 404, and so did our
   * production deployment, which is the 404 being reported.
   *
   * ## The official contract this follows
   *
   * The SDK's own `nativeAuthExchange` documents the whole chain, and this route
   * performs the same steps server-side:
   *
   *   1. `POST {AUTH_WORKER_URL}/api/auth/exchange-code` with `{ code }`
   *      → `{ sessionToken }` (the one-time code is consumed here; a reused or
   *        expired code answers 400/401).
   *   2. `POST {AUTH_WORKER_URL}/api/auth/token` with
   *      `Cookie: __Secure-better-auth.session_token=<sessionToken>`
   *      → `{ token }`, a platform-signed JWT.
   *
   * The session cookie is then set on **our** origin so the browser holds it,
   * and the browser is sent to the dashboard. `getAuthToken()` will call our
   * `/api/auth/token` (proxied) with that cookie and receive the JWT — the same
   * path every authenticated request already uses. `resolveIdentity` verifies it
   * with the platform public key, so issuer and `authorizedParties` are
   * untouched.
   *
   * ## What this route deliberately does not do
   *
   * It does not mint a session, sign a JWT, or validate OAuth state/PKCE itself
   * — state and PKCE are enforced by the auth worker before it ever issues a
   * code, and the code is only redeemable once. It does not trust any identity
   * from the query string: the `code` is an opaque one-time credential validated
   * upstream, and the only thing derived from it is the platform's own response.
   * No token is placed in a URL, a log, or the HTML.
   */
  app.get('/oauth-complete', async (c) => {
    const authWorkerUrl = options.authWorkerUrl
    const appOrigin = options.appOrigin

    if (!authWorkerUrl || !appOrigin) {
      return authFailure(c, 503, 'auth_unavailable', 'Autenticação não configurada.')
    }

    // The provider's redirect carries the one-time code. A missing or oversized
    // value is a bad request, not a server error.
    const code = c.req.query('code')
    if (typeof code !== 'string' || code.length === 0 || code.length > 4096) {
      return authFailure(c, 400, 'invalid_request', 'Código de autorização ausente ou inválido.')
    }

    // 1. Redeem the one-time code. This is where expiry and reuse are rejected.
    let exchange: Response
    try {
      exchange = await authWorkerFetch({ AUTH_WORKER_URL: authWorkerUrl }, '/api/auth/exchange-code', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
      })
    } catch {
      return authFailure(c, 502, 'provider_unavailable', 'Serviço de autenticação indisponível.', true)
    }

    if (!exchange.ok) {
      // 400/401 from the platform means the code is expired, already used, or
      // forged. Anything else is an availability problem.
      const definitive = exchange.status === 400 || exchange.status === 401
      return authFailure(
        c,
        definitive ? 401 : 502,
        definitive ? 'invalid_code' : 'provider_unavailable',
        definitive
          ? 'O código de autorização expirou. Tente entrar novamente.'
          : 'Serviço de autenticação indisponível.',
        !definitive,
      )
    }

    const exchanged = (await exchange.json().catch(() => null)) as { sessionToken?: unknown } | null
    if (!exchanged || typeof exchanged.sessionToken !== 'string' || exchanged.sessionToken.length < 16) {
      return authFailure(c, 502, 'invalid_provider_response', 'A autenticação não emitiu sessão.', true)
    }
    const sessionToken = exchanged.sessionToken

    // 2. Prove the session can obtain a JWT before redirecting anywhere. A
    //    dashboard redirect is only honest once authentication is confirmed.
    let tokenResponse: Response
    try {
      tokenResponse = await authWorkerFetch({ AUTH_WORKER_URL: authWorkerUrl }, '/api/auth/token', {
        method: 'POST',
        headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}` },
      })
    } catch {
      return authFailure(c, 502, 'provider_unavailable', 'Serviço de autenticação indisponível.', true)
    }

    if (!tokenResponse.ok) {
      return authFailure(
        c,
        tokenResponse.status === 401 ? 401 : 502,
        tokenResponse.status === 401 ? 'session_rejected' : 'provider_unavailable',
        'A sessão não pôde ser validada. Tente entrar novamente.',
        tokenResponse.status !== 401,
      )
    }

    const issued = (await tokenResponse.json().catch(() => null)) as { token?: unknown } | null
    if (!issued || typeof issued.token !== 'string') {
      return authFailure(c, 502, 'invalid_provider_response', 'A autenticação não emitiu token.', true)
    }

    // 3. Hand the browser the session cookie on our own origin, then go to the
    //    dashboard. The token itself stays out of the URL: the client obtains it
    //    through `/api/auth/token`, which is already proxied.
    const cookie = [
      `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}`,
      'Path=/',
      'HttpOnly',
      'Secure',
      'SameSite=Lax',
      'Max-Age=604800',
    ].join('; ')

    const destination = `${appOrigin.replace(/\/$/, '')}/dashboard`
    return new Response(null, {
      status: 302,
      headers: {
        location: destination,
        'set-cookie': cookie,
        'cache-control': 'no-store',
      },
    })
  })

  return app
}

/** Session cookie name the auth worker and this app must agree on. */
const SESSION_COOKIE = '__Secure-better-auth.session_token'

/**
 * Uniform JSON failure for the OAuth completion route.
 *
 * Never redirects on failure: sending an unauthenticated browser to the
 * dashboard would look like a login that silently did nothing.
 */
function authFailure(
  c: Context<AppEnv>,
  status: 400 | 401 | 502 | 503,
  code: string,
  message: string,
  retryable = false,
): Response {
  return c.json({ success: false as const, error: { code, message, retryable } }, status)
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
