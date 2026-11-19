import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { SessionUser } from '@shared/api'
import { api, ApiError } from '@/lib/api'

/**
 * Session context.
 *
 * The server is the source of truth: on mount we ask `/api/auth/me`, and a 401
 * means signed out. Nothing about the user is cached in localStorage, so a
 * revoked session or a deleted account cannot survive a refresh.
 */

interface AuthState {
  status: 'loading' | 'authenticated' | 'anonymous'
  user: SessionUser | null
  error: string | null
  signIn: (input: { email: string; name?: string }) => Promise<void>
  signOut: () => Promise<void>
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthState['status']>('loading')
  const [user, setUser] = useState<SessionUser | null>(null)
  const [error, setError] = useState<string | null>(null)

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
    // The session check is an external-system read, so resolving it inside the
    // effect (asynchronously) and setting state from the response is correct:
    // React is being told about external state, not deriving state from props.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
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
    () => ({ status, user, error, signIn, signOut, refresh }),
    [status, user, error, signIn, signOut, refresh],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth precisa estar dentro de <AuthProvider>')
  return context
}
