
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const ROOT = new URL('../../src/app/', import.meta.url)

function source(): string {
  return readFileSync(new URL('AuthProvider.tsx', ROOT), 'utf8')
}

describe('AuthProvider: token source lifecycle', () => {
  it('registers the token provider only for deepspace mode', () => {
    const code = source()

    assert.match(code, /config\.authMode === 'deepspace'/)
    assert.match(code, /setTokenProvider\(null\)/)
    assert.match(code, /setTokenProvider\(async \(\) => \{/)
  })

  it('obtains the JWT through the SDK getAuthToken', () => {
    const code = source()

    assert.match(code, /mod\.getAuthToken\(\)/)
    assert.ok(
      !/['"`]\/api\/auth\/token['"`]/.test(code),
      'the provider must not fetch the token endpoint',
    )
  })

  it('uses the SDK bearer for DeepSpace and cookie auth locally', () => {
    const code = source()

    assert.match(
      code,
      /authMode === 'deepspace'[\s\S]*?api\.get<SessionUser>\('\/api\/auth\/me'\)/,
    )
    assert.match(
      code,
      /api\.getAnonymous<SessionUser>\('\/api\/auth\/me'\)/,
    )
  })

  it('loads auth mode and installs provider before checking session', () => {
    const code = source()

    const configFetch = code.indexOf(
      ".get<AuthConfigResponse>('/api/auth/config')",
    )
    const providerInstall = code.indexOf('setTokenProvider(async () =>')
    const sessionCheck = code.indexOf('await checkSession(config.authMode)')

    assert.ok(
      configFetch >= 0 &&
      providerInstall > configFetch &&
      sessionCheck > providerInstall,
    )
  })

  it('logs out anonymously', () => {
    assert.match(
      source(),
      /api\.postAnonymous<\{ signedOut: boolean \}>\('\/api\/auth\/logout'\)/,
    )
  })

  it('clears the cached JWT on sign-out', () => {
    const code = source()

    assert.match(code, /mod\.clearAuthToken\(\)/)

    const logoutBlock = code.slice(code.indexOf('const signOut'))

    assert.match(logoutBlock, /finally \{/)
    assert.ok(
      logoutBlock.indexOf('clearAuthToken') <
      logoutBlock.indexOf("setStatus('anonymous')"),
    )
  })

  it('resets failed token exchange before every DeepSpace session check', () => {
    const code = source()

    const start = code.indexOf('const checkSession')
    const end = code.indexOf('const refresh', start)
    const checkSessionBlock = code.slice(start, end)

    assert.ok(checkSessionBlock.length > 0)
    assert.match(
      checkSessionBlock,
      /if \(authMode === 'deepspace'\) \{\s*resetTokenProviderState\(\)\s*\}/,
    )

    const reset = checkSessionBlock.indexOf('resetTokenProviderState()')
    const request = checkSessionBlock.indexOf(
      "api.get<SessionUser>('/api/auth/me')",
    )

    assert.ok(reset >= 0 && request > reset)
  })

  it('refresh delegates to checkSession', () => {
    const code = source()

    assert.match(
      code,
      /const refresh = useCallback\(async \(\) => \{\s*await checkSession\(mode\)/,
    )
  })

  it('tolerates the SDK failing to load', () => {
    const code = source()

    assert.match(code, /await import\('deepspace'\)/)
    assert.match(code, /catch \{/)
  })
})
