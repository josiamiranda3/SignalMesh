
/**
 * Bearer token plumbing.
 *
 * The platform issues two different credentials:
 *
 * - Session token: opaque cookie used to renew the platform session.
 * - JWT: signed token returned by POST /api/auth/token.
 *
 * Protected API endpoints require the JWT in:
 *
 * Authorization: Bearer <jwt>
 *
 * The browser must therefore obtain the JWT through the SDK token provider.
 *
 * Concurrent requests share the same token exchange promise. This prevents
 * requests from being sent without Authorization while another request is
 * already obtaining the token.
 *
 * This module intentionally has no DOM dependencies.
 */

export type TokenProvider = () => Promise<string | null>

let tokenProvider: TokenProvider | null = null
let tokenPromise: Promise<string | null> | null = null
let resolveFailed = false
let providerGeneration = 0

/**
 * Paths that must never trigger a token exchange.
 *
 * The token endpoint itself must not request a token, otherwise the exchange
 * would recurse indefinitely.
 */
const TOKEN_EXEMPT_PATHS = [
  '/api/auth/token',
  '/api/auth/logout',
  '/api/auth/login',
  '/api/auth/config',
]

/** Check whether a path is exempt from bearer token resolution. */
export function isTokenExempt(path: string): boolean {
  return TOKEN_EXEMPT_PATHS.some(
    (exempt) => path === exempt || path.startsWith(`${exempt}?`),
  )
}

/**
 * Register or remove the token provider.
 *
 * Replacing the provider invalidates any previous in-flight exchange and
 * resets the failed state.
 */
export function setTokenProvider(provider: TokenProvider | null): void {
  providerGeneration += 1
  tokenProvider = provider
  tokenPromise = null
  resolveFailed = false
}

/**
 * Allow another token exchange after a previous failure.
 *
 * Called when the application confirms that a session is available again.
 */
export function resetTokenProviderState(): void {
  resolveFailed = false
}

/**
 * Obtain a bearer token for a protected request.
 *
 * Concurrent requests share one promise. If the exchange fails, the failure
 * is remembered until the provider is reset or replaced.
 *
 * This function never throws.
 */
export async function bearerFor(path: string): Promise<string | null> {
  if (!tokenProvider || isTokenExempt(path) || resolveFailed) {
    return null
  }

  // A token exchange is already running. Reuse its promise instead of
  // allowing this request to continue without a bearer.
  if (tokenPromise) {
    return tokenPromise
  }

  const provider = tokenProvider
  const generation = providerGeneration

  const pending = (async (): Promise<string | null> => {
    try {
      const token = await provider()

      // Do not reuse a token from a provider that has since been replaced.
      if (generation !== providerGeneration) {
        return null
      }

      if (!token) {
        resolveFailed = true
        return null
      }

      return token
    } catch {
      if (generation === providerGeneration) {
        resolveFailed = true
      }

      return null
    }
  })()

  tokenPromise = pending

  try {
    return await pending
  } finally {
    // Do not clear a newer promise installed by a replacement provider.
    if (tokenPromise === pending) {
      tokenPromise = null
    }
  }
}
