import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { SessionUser } from '@shared/api'
import type { AuthConfigResponse } from '../../server/lib/auth-context'
import { api, ApiError, resetTokenProviderState, setTokenProvider } from '@/lib/api'
import { useI18n } from '@/i18n/I18nProvider'

/**
 * Session context.
 *
 * The UI reads identity through this hook and never through the SDK directly, so
 * a page does not need to know which adapter is active.
 *
 * Two modes, chosen by the server (`GET /api/auth/config`):
 *
 *  - `deepspace` — identity comes from the platform. `signIn` asks the caller to
 *    open the platform's own sign-in surface (mounted by the SDK's `AuthGate` /
 *    `AuthOverlay`); this provider never handles credentials.
 *  - `local` — the test/development adapter posts to `/api/auth/login`.
 *
 * The server is the source of truth in both cases: `/api/auth/me` decides
 * whether there is a session, so a revoked session dies on the next request
 * rather than living on in component state.
 *
 * ## Credential plumbing (deepspace only)
 *
 * The browser holds an opaque **session token** in an HttpOnly cookie. Protected
 * endpoints verify a **JWT**, not that token, so this provider registers a token
 * source with the API client: `getAuthToken()` from the SDK exchanges the cookie
 * for a JWT, and the client sends it as `Authorization: Bearer`.
 *
 * The token is never written to storage — the SDK caches it in memory and
 * `clearAuthToken()` drops it on sign-out. The cookie remains the durable
 * credential, which is what lets a page reload re-establish the session.
 */

interface AuthState {
  status: 'loading' | 'authenticated' | 'anonymous'
  user: SessionUser | null
  error: string | null
  mode: AuthConfigResponse['authMode'] | null
  providerLabel: string
  /** Local mode only: exchange an email for a session. */
  signIn: (input: { email: string; name?: string }) => Promise<void>
  signOut: () => Promise<void>
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const [status, setStatus] = useState<AuthState['status']>('loading')
  const [user, setUser] = useState<SessionUser | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<AuthState['mode']>(null)
  // Replaced by the adapter's own label once `/api/auth/config` responds; this is
  // only the pre-fetch fallback.
  const [providerLabel, setProviderLabel] = useState(() => t('login.providerFallback'))

  const checkSession = useCallback(async (authMode: AuthState['mode']) => {
    try {
      // DeepSpace stores an opaque session token in the HttpOnly cookie.
      // Exchange it through the SDK for a platform JWT before calling /me;
      // the Worker verifies that JWT, not the Better Auth session token.
      // Local mode has no platform JWT and continues to use its local cookie.
      const sessionUser =
        authMode === 'deepspace'
          ? await api.get<SessionUser>('/api/auth/me')
          : await api.getAnonymous<SessionUser>('/api/auth/me')

      setUser(sessionUser)
      setStatus('authenticated')
      setError(null)
      resetTokenProviderState()
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        setUser(null)
        setStatus('anonymous')
        setError(null)
        return
      }
      setUser(null)
      setStatus('anonymous')
      setError(caught instanceof Error ? caught.message : t('login.sessionCheckError'))
    }
  }, [t])

  const refresh = useCallback(async () => {
    await checkSession(mode)
  }, [checkSession, mode])

  useEffect(() => {
    let active = true

    // Load the auth mode first: in DeepSpace mode /me must carry a JWT obtained
    // through getAuthToken(), while local mode must remain cookie-only.
    api
      .get<AuthConfigResponse>('/api/auth/config')
      .then(async (config) => {
        if (!active) return
        setMode(config.authMode)
        setProviderLabel(config.providerLabel)

        if (config.authMode === 'deepspace') {
          setTokenProvider(async () => {
            const mod = await import('deepspace')
            return mod.getAuthToken()
          })
        } else {
          setTokenProvider(null)
        }

        await checkSession(config.authMode)
      })
      .catch((caught) => {
        if (!active) return
        setTokenProvider(null)
        setStatus('anonymous')
        setUser(null)
        setError(caught instanceof Error ? caught.message : t('login.sessionCheckError'))
      })

    return () => {
      active = false
    }
  }, [checkSession, t])

  const signIn = useCallback(async (input: { email: string; name?: string }) => {
    const sessionUser = await api.post<SessionUser>('/api/auth/login', input)
    setUser(sessionUser)
    setStatus('authenticated')
    setError(null)
  }, [])

  const signOut = useCallback(async () => {
    try {
      // Anonymous: the logout call must not depend on a token that is about to
      // be invalid, and must not trigger an exchange while signing out.
      await api.postAnonymous<{ signedOut: boolean }>('/api/auth/logout')
    } finally {
      // Drop the cached bearer before clearing state, so no in-flight request
      // keeps using a credential for the user who just left.
      try {
        const mod = await import('deepspace')
        mod.clearAuthToken()
      } catch {
        /* SDK absent (local mode): nothing cached to clear */
      }
      setUser(null)
      setStatus('anonymous')
    }
  }, [])

  const value = useMemo<AuthState>(
    () => ({ status, user, error, mode, providerLabel, signIn, signOut, refresh }),
    [status, user, error, mode, providerLabel, signIn, signOut, refresh],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth precisa estar dentro de <AuthProvider>')
  return context
}
