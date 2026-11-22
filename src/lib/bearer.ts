/**
 * Bearer token plumbing.
 *
 * ## Why the API client needs a token at all
 *
 * The platform issues **two** different credentials and they are not
 * interchangeable:
 *
 * | Credential | Produced by | Format | Consumed by |
 * | --- | --- | --- | --- |
 * | session token | `exchange-code` | opaque, no dots | `POST /api/auth/token`, as a cookie |
 * | JWT | `POST /api/auth/token` | three dot-separated segments | `verifyJwt`, via `Authorization: Bearer` |
 *
 * The browser holds the **session token** in `__Secure-better-auth.session_token`
 * — that is what makes renewal possible — while every protected endpoint
 * (`/api/auth/me` included) verifies a **JWT**. So the client must obtain the JWT
 * (the SDK's `getAuthToken()` exchanges the cookie for one) and send it as a
 * bearer.
 *
 * ## DOM-free on purpose
 *
 * This module is imported by `src/lib/api.ts`, which touches `document` and
 * `window` and therefore cannot be loaded under the server tsconfig. Keeping the
 * credential logic here lets server-side tests exercise it without dragging a DOM
 * library into the Node typecheck.
 *
 * ## Recursion guard
 *
 * `getAuthToken()` itself calls `POST /api/auth/token`. If that call also asked
 * for a bearer, obtaining a token would require a token — an infinite loop.
 * Requests to that endpoint skip the provider entirely and authenticate with the
 * cookie alone.
 *
 * ## Why the token is not persisted
 *
 * It lives only in the SDK's in-memory cache. `localStorage`/`sessionStorage`
 * would expose a bearer to any script on the page and outlive the session it
 * belongs to; the cookie is `HttpOnly`, so JavaScript cannot read it and the SDK
 * refreshes from it.
 */

export type TokenProvider = () => Promise<string | null>

let tokenProvider: TokenProvider | null = null
/** True while a token exchange is in flight, so exchanges cannot nest. */
let resolving = false
/** Set when the exchange failed, until the next explicit reset. */
let resolveFailed = false

/**
 * Paths that must never trigger a token exchange.
 *
 * `/api/auth/token` is the exchange endpoint itself. `/api/auth/login` and
 * `/api/auth/logout` manage the credential rather than use it. `/api/auth/config`
 * is public and is the first call the app makes, before any session exists.
 */
const TOKEN_EXEMPT_PATHS = [
  '/api/auth/token',
  '/api/auth/logout',
  '/api/auth/login',
  '/api/auth/config',
]

/** Is this a path that must authenticate without a bearer? */
export function isTokenExempt(path: string): boolean {
  return TOKEN_EXEMPT_PATHS.some((exempt) => path === exempt || path.startsWith(`${exempt}?`))
}

/**
 * Register how the client obtains a bearer token.
 *
 * `AuthProvider` installs the SDK-backed provider once the auth mode is known to
 * be `deepspace`. Passing `null` removes it (local mode, or after sign-out).
 */
export function setTokenProvider(provider: TokenProvider | null): void {
  tokenProvider = provider
  resolving = false
  resolveFailed = false
}

/**
 * Forget a failed exchange so the next request tries again.
 *
 * Called when a session is confirmed to exist again, so a transient token
 * failure does not leave the client permanently cookie-only.
 */
export function resetTokenProviderState(): void {
  resolveFailed = false
}

/**
 * Obtain a bearer token for one request, or null.
 *
 * Never throws and never retries: an unavailable token degrades to a
 * cookie-only request, which the server answers with 401 if it needs more. That
 * keeps a token outage from turning into an authentication loop.
 */
export async function bearerFor(path: string): Promise<string | null> {
  if (!tokenProvider || isTokenExempt(path) || resolving || resolveFailed) return null

  resolving = true
  try {
    const token = await tokenProvider()
    if (!token) resolveFailed = true
    return token ?? null
  } catch {
    resolveFailed = true
    return null
  } finally {
    resolving = false
  }
}
