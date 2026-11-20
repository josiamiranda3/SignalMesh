import { Suspense, lazy, useMemo, type ReactNode } from 'react'
import { HAS_PLATFORM_APP_ID, SCOPE_ID } from './constants'
import { schemas } from '../schemas'

/**
 * DeepSpace provider tree.
 *
 * Mounted only when the bundle carries a platform app id — that is, when the
 * build ran with `deepspaceBuild()` and the app has a real RecordRoom. Under the
 * local Node runtime the data comes from `/api/*`, so mounting the realtime
 * providers there would open a WebSocket to a room that does not exist.
 *
 * What each provider contributes:
 *
 *  - `DeepSpaceAuthProvider` — the platform session, and `getAuthToken()` for
 *    outbound API calls.
 *  - `RecordProvider` + `RecordScope` — the realtime record layer bound to the
 *    app's collections and the immutable app id.
 *
 * The business API in this app does **not** read records through these hooks:
 * every read and write goes through `/api/*`, where ownership is enforced. The
 * providers are here so the SDK's own surfaces (auth, presence, and any future
 * realtime view) work, and so the app is a first-class DeepSpace client.
 */

const DeepSpaceProviders = lazy(async () => {
  const mod = await import('deepspace')

  function Providers({ children }: { children: ReactNode }) {
    return (
      <mod.DeepSpaceAuthProvider>
        <mod.RecordProvider allowAnonymous>
          <mod.RecordScope roomId={SCOPE_ID} schemas={schemas}>
            {children}
          </mod.RecordScope>
        </mod.RecordProvider>
      </mod.DeepSpaceAuthProvider>
    )
  }

  return { default: Providers }
})

export function PlatformProviders({ children }: { children: ReactNode }) {
  const enabled = useMemo(() => HAS_PLATFORM_APP_ID, [])

  if (!enabled) return <>{children}</>

  return (
    <Suspense fallback={null}>
      <DeepSpaceProviders>{children}</DeepSpaceProviders>
    </Suspense>
  )
}
