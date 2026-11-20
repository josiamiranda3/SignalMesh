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
import { api, ApiError } from '@/lib/api'

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
  const [status, setStatus] = useState<AuthState['status']>('loading')
  const [user, setUser] = useState<SessionUser | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<AuthState['mode']>(null)
  const [providerLabel, setProviderLabel] = useState('Autenticação')

  const refresh = useCallback(async () => {
    try {
      const sessionUser = await api.get<SessionUser>('/api/auth/me')
      setUser(sessionUser)
      setStatus('authenticated')
      setError(null)
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        setUser(null)
        setStatus('anonymous')
        setError(null)
        return
      }
      setUser(null)
      setStatus('anonymous')
      setError(caught instanceof Error ? caught.message : 'Falha ao verificar a sessão')
    }
  }, [])

  useEffect(() => {
    let active = true

    // Which adapter is active is a server fact, fetched once. Failure is not
    // fatal: the app stays usable, it just cannot label the sign-in surface.
    api
      .get<AuthConfigResponse>('/api/auth/config')
      .then((config) => {
        if (!active) return
        setMode(config.authMode)
        setProviderLabel(config.providerLabel)
      })
      .catch(() => {
        /* keep defaults */
      })

    // Session resolution is an external-system read; setting state from its
    // response is the point of the effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()

    return () => {
      active = false
    }
  }, [refresh])

  const signIn = useCallback(async (input: { email: string; name?: string }) => {
    const sessionUser = await api.post<SessionUser>('/api/auth/login', input)
    setUser(sessionUser)
    setStatus('authenticated')
    setError(null)
  }, [])

  const signOut = useCallback(async () => {
    try {
      await api.post<{ signedOut: boolean }>('/api/auth/logout')
    } finally {
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
