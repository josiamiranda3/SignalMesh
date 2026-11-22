import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * AuthProvider wiring for the credential fix.
 *
 * The provider owns the lifecycle: it installs the SDK-backed token source only
 * when the platform owns identity, and it drops the cached token on sign-out.
 *
 * These are source assertions. The behaviour they guard — bearer attachment,
 * recursion avoidance, failure handling — is exercised against the real client
 * in `tests/unit/api-bearer.test.ts`; rendering the provider would need a DOM and
 * would not tell us more than these invariants do.
 */

const ROOT = new URL('../../src/app/', import.meta.url)

function source(): string {
  return readFileSync(new URL('AuthProvider.tsx', ROOT), 'utf8')
}

describe('AuthProvider: token source lifecycle', () => {
  it('registers the token provider only for deepspace mode', () => {
    const code = source()
    // The install is guarded by the mode check; local mode clears it.
    assert.match(code, /config\.authMode !== 'deepspace'/)
    assert.match(code, /setTokenProvider\(null\)/)
    assert.match(code, /setTokenProvider\(async \(\) => \{/)
  })

  it('obtains the JWT through the SDK getAuthToken, not by hand-rolling a fetch', () => {
    const code = source()
    assert.match(code, /mod\.getAuthToken\(\)/)
    // It must not call the token endpoint itself.
    assert.ok(!/['"`]\/api\/auth\/token['"`]/.test(code), 'the provider must not fetch the token endpoint')
  })

  it('decides session existence with an anonymous call', () => {
    // `/api/auth/me` answers "is there a session?" — a stale bearer there would
    // report an identity the user already signed out of.
    assert.match(source(), /api\.getAnonymous<SessionUser>\('\/api\/auth\/me'\)/)
  })

  it('logs out anonymously so the call does not need the token being revoked', () => {
    assert.match(source(), /api\.postAnonymous<\{ signedOut: boolean \}>\('\/api\/auth\/logout'\)/)
  })

  it('clears the cached JWT on sign-out', () => {
    const code = source()
    assert.match(code, /mod\.clearAuthToken\(\)/)
    // And does so in a `finally`, so a failed logout still drops the token.
    const logoutBlock = code.slice(code.indexOf('const signOut'))
    assert.match(logoutBlock, /finally \{/)
    assert.ok(
      logoutBlock.indexOf('clearAuthToken') < logoutBlock.indexOf("setStatus('anonymous')"),
      'the token is cleared before the state flips',
    )
  })

  it('re-enables the exchange once a session is confirmed again', () => {
    // After a successful /me, a previously failed exchange must be retryable.
    const code = source()
    const start = code.indexOf('const refresh = useCallback')
    const end = code.indexOf('}, [t])', start)
    const refreshBlock = code.slice(start, end)
    assert.ok(refreshBlock.length > 0, 'refresh block not found')
    assert.match(refreshBlock, /resetTokenProviderState\(\)/)
  })

  it('tolerates the SDK failing to load', () => {
    // A dynamic import that throws must degrade to cookie-only requests rather
    // than breaking every API call or the sign-in surface.
    const code = source()
    assert.match(code, /await import\('deepspace'\)/)
    assert.match(code, /catch \{/)
  })
})
