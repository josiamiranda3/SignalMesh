export const APP_NAME = 'SignalMesh'
export const APP_TAGLINE = 'Research & Evidence Intelligence'
export const APP_VERSION = '0.2.0'

/**
 * Record scope id.
 *
 * `deepspaceBuild()` injects `__DEEPSPACE_APP_ID__` at build time from the
 * wrangler config the build targets. Keying the scope to the immutable app id
 * (not the subdomain) is what makes a rename safe and keeps local, preview and
 * production data in distinct rooms.
 *
 * Under the local Node runtime the define is absent, so the scope falls back to
 * a fixed dev id — that runtime stores data in SQLite, not in a RecordRoom, so
 * the value is only used to satisfy the SDK provider tree.
 */
declare const __DEEPSPACE_APP_ID__: string | undefined

function resolveAppId(): string {
  try {
    // `typeof` is safe even when the identifier was never defined.
    if (typeof __DEEPSPACE_APP_ID__ === 'string' && __DEEPSPACE_APP_ID__) {
      return __DEEPSPACE_APP_ID__
    }
  } catch {
    /* not injected — local build */
  }
  return 'local-dev'
}

export const APP_ID = resolveAppId()
export const SCOPE_ID = `app:${APP_ID}`
/** True when the bundle carries a platform app id, i.e. realtime data is live. */
export const HAS_PLATFORM_APP_ID = APP_ID !== 'local-dev'
