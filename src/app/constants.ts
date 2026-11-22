export const APP_NAME = 'SignalMesh'
export const APP_TAGLINE = 'Research & Evidence Intelligence'
export const APP_VERSION = '0.2.4.3'

/** Local development sentinel. Never a real platform id. */
const LOCAL_APP_ID = 'local-dev'

/**
 * Shape of a platform app id.
 *
 * Mirrors the SDK's own `APP_ID_RE` (`/^app_[0-9A-HJKMNP-TV-Z]{26}$/`): an
 * `app_` prefix and a 26-character Crockford base32 ULID. Duplicated rather than
 * imported because `deepspace/build` is a build-time module and this file ships
 * to the browser — importing it would pull `node:fs` into the bundle.
 */
const APP_ID_RE = /^app_[0-9A-HJKMNP-TV-Z]{26}$/

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
 *
 * ## Why the value is validated, not merely checked for emptiness
 *
 * The previous version accepted **any** non-empty string. `deepspaceBuild()`
 * rejects a malformed id before it ever reaches the define, so a platform build
 * was safe — but nothing in this module enforced that. Any other way of setting
 * the define (a hand-written `define` in `vite.config.ts`, a stray
 * `--define` flag) would have pointed the browser's RecordRooms at whatever
 * string was supplied, with no error. A syntactically invalid id now falls back
 * to the local sentinel, which disables the realtime providers instead of
 * silently subscribing to the wrong room.
 */
declare const __DEEPSPACE_APP_ID__: string | undefined

function resolveAppId(): string {
  try {
    // `typeof` is safe even when the identifier was never defined.
    if (typeof __DEEPSPACE_APP_ID__ === 'string') {
      const candidate = __DEEPSPACE_APP_ID__.trim()
      if (APP_ID_RE.test(candidate)) return candidate
    }
  } catch {
    /* not injected — local build */
  }
  return LOCAL_APP_ID
}

export const APP_ID = resolveAppId()
export const SCOPE_ID = `app:${APP_ID}`
/** True when the bundle carries a real platform app id, i.e. realtime data is live. */
export const HAS_PLATFORM_APP_ID = APP_ID !== LOCAL_APP_ID
