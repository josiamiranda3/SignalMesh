
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
import {
  api,
  ApiError,
  resetTokenProviderState,
  setTokenProvider,
} from '@/lib/api'
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
  const [providerLabel, setProviderLabel] = useState(
    () => t('login.providerFallback'),
  )

  /**
   * Check the current session.
   *
   * In DeepSpace mode, the SDK supplies the JWT used by the API.
   * In local mode, the local session adapter is used.
   */
  const checkSession = useCallback(
    async (authMode: AuthState['mode']) => {
      try {
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
        setError(
          caught instanceof Error
            ? caught.message
            : t('login.sessionCheckError'),
        )
      }
    },
    [t],
  )

  const refresh = useCallback(async () => {
    await checkSession(mode)
  }, [checkSession, mode])

  /**
   * Load the active authentication mode and register the SDK token provider.
   */
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

  /**
   * Local-mode sign-in.
   *
   * DeepSpace mode uses the platform AuthOverlay instead.
   */
  const signIn = useCallback(
    async (input: { email: string; name?: string }) => {
      const sessionUser = await api.post<SessionUser>(
        '/api/auth/login',
        input,
      )

      setUser(sessionUser)
      setStatus('authenticated')
      setError(null)
    },
    [],
  )

  /**
   * Sign out.
   *
   * DeepSpace mode must revoke the platform session through the SDK's
   * official signOut() method. Clearing the cached JWT alone is insufficient.
   *
   * The app-owned logout endpoint then clears the app-origin cookie.
   * Both operations are attempted, even if one of them fails.
   */
  const signOut = useCallback(async () => {
    let signOutFailure: unknown = null

    try {
      if (mode === 'deepspace') {
        const mod = await import('deepspace')

        // Authoritative platform session revocation.
        const result: unknown = await mod.signOut()

        // Better Auth may report an error in its result instead of throwing.
        if (
          result &&
          typeof result === 'object' &&
          'error' in result &&
          result.error
        ) {
          throw new Error(
            'A plataforma não confirmou o encerramento da sessão.',
          )
        }

        // Remove the SDK's cached JWT after platform sign-out.
        mod.clearAuthToken()
      }
    } catch (caught) {
      signOutFailure = caught
    }

    try {
      // Clear the app-origin session cookie as well.
      await api.postAnonymous<{ signedOut: boolean }>('/api/auth/logout')
    } catch (caught) {
      if (!signOutFailure) {
        signOutFailure = caught
      }
    } finally {
      // Clear the cached token even if one of the logout requests failed.
      try {
        const mod = await import('deepspace')
        mod.clearAuthToken()
      } catch {
        // The SDK is not available in local mode.
      }

      resetTokenProviderState()
      setUser(null)
      setStatus('anonymous')
    }

    if (signOutFailure) {
      setError(
        signOutFailure instanceof Error
          ? signOutFailure.message
          : 'Não foi possível confirmar o encerramento da sessão.',
      )
    } else {
      setError(null)
    }
  }, [mode])

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
    [
      status,
      user,
      error,
      mode,
      providerLabel,
      signIn,
      signOut,
      refresh,
    ],
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
