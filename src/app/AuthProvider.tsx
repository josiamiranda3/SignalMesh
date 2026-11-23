
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

interface AuthState {
  status: 'loading' | 'authenticated' | 'anonymous'
  user: SessionUser | null
  error: string | null
  mode: AuthConfigResponse['authMode'] | null
  providerLabel: string
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
  const [providerLabel, setProviderLabel] = useState(() => t('login.providerFallback'))

  const checkSession = useCallback(async (authMode: AuthState['mode']) => {
    try {
      // A cada nova verificação DeepSpace, permite uma nova tentativa
      // de troca da sessão por JWT.
      if (authMode === 'deepspace') {
        resetTokenProviderState()
      }

      const sessionUser =
        authMode === 'deepspace'
          ? await api.get<SessionUser>('/api/auth/me')
          : await api.getAnonymous<SessionUser>('/api/auth/me')

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
      setError(caught instanceof Error ? caught.message : t('login.sessionCheckError'))
    }
  }, [t])

  const refresh = useCallback(async () => {
    await checkSession(mode)
  }, [checkSession, mode])

  useEffect(() => {
    let active = true

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
        setError(
          caught instanceof Error
            ? caught.message
            : t('login.sessionCheckError'),
        )
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
      await api.postAnonymous<{ signedOut: boolean }>('/api/auth/logout')
    } finally {
      try {
        const mod = await import('deepspace')
        mod.clearAuthToken()
      } catch {
        /* SDK ausente no modo local */
      }

      setUser(null)
      setStatus('anonymous')
    }
  }, [])

  const value = useMemo<AuthState>(
    () => ({
      status,
      user,
      error,
      mode,
      providerLabel,
      signIn,
      signOut,
      refresh,
    }),
    [status, user, error, mode, providerLabel, signIn, signOut, refresh],
  )

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext)

  if (!context) {
    throw new Error('useAuth precisa estar dentro de <AuthProvider>')
  }

  return context
}
