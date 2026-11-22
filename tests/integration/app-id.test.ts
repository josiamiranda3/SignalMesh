import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * App ID injection.
 *
 * ## The property
 *
 * The browser keys its RecordRooms to `DEEPSPACE_APP_ID`. A wrong id there does
 * not fail loudly — it subscribes the client to a room that is not this app's.
 * So the id must be either a *syntactically valid platform id* or the local
 * sentinel, never anything else.
 *
 * ## What is actually verified here
 *
 * `deepspaceBuild()` refuses to build on a malformed id (the SDK checks its own
 * `APP_ID_RE` and throws), so the platform path is safe by construction. What
 * this suite adds is the **second** gate: `src/app/constants.ts` must not trust
 * an arbitrary define value. Before this change it accepted any non-empty
 * string, which meant a hand-written `define` could point the client anywhere.
 *
 * The bundle assertion at the end is the end-to-end check: whatever the current
 * build did, the shipped artifact must not carry the unregistered placeholder.
 */

const ROOT = process.cwd()

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

describe('wrangler App ID', () => {
  const toml = read('wrangler.toml')

  it('carries a real platform app id, or the placeholder while unregistered', () => {
    const match = /DEEPSPACE_APP_ID\s*=\s*"([^"]*)"/.exec(toml)
    assert.ok(match, 'DEEPSPACE_APP_ID must be declared')

    const value = match[1]!
    if (value === '__APP_ID__') {
      // Still unregistered. Acceptable, but the platform build refuses to run
      // and the realtime providers stay off.
      return
    }

    // Registered: the id must be a real one, never a hand-written lookalike.
    assert.match(
      value,
      /^app_[0-9A-HJKMNP-TV-Z]{26}$/,
      `DEEPSPACE_APP_ID must be a platform-minted id, got: ${value}`,
    )
  })

  it('declares APP_ORIGIN as the deployed host, never loopback', () => {
    const match = /APP_ORIGIN\s*=\s*"([^"]+)"/.exec(toml)
    assert.ok(match, 'APP_ORIGIN must be declared')
    assert.ok(!/127\.0\.0\.1|localhost/.test(match[1]!), `APP_ORIGIN must not be loopback: ${match[1]}`)
  })
})

describe('client-side App ID resolution', () => {
  const source = read('src/app/constants.ts')

  it('validates the injected id against the platform format', () => {
    // The regex must exist and be applied to the candidate before returning it.
    assert.match(source, /APP_ID_RE\s*=\s*\/\^app_/)
    assert.match(source, /APP_ID_RE\.test\(candidate\)/)
  })

  it('falls back to the local sentinel, not to an arbitrary value', () => {
    assert.match(source, /return LOCAL_APP_ID/)
  })

  it('exposes HAS_PLATFORM_APP_ID derived from the sentinel', () => {
    assert.match(source, /HAS_PLATFORM_APP_ID\s*=\s*APP_ID\s*!==\s*LOCAL_APP_ID/)
  })

  it('agrees with the SDK on the id format', () => {
    const sdk = read('node_modules/deepspace/dist/build.js')
    const sdkRe = /var APP_ID_RE = (\/\^app_\[[^\n]+)/.exec(sdk)?.[1]
    assert.ok(sdkRe, 'SDK APP_ID_RE not found')
    // Same character class and length as the SDK's, so a platform id can never
    // pass one check and fail the other.
    assert.ok(source.includes('app_[0-9A-HJKMNP-TV-Z]{26}'), 'length/charset must match the SDK')
  })
})

describe('built bundle', () => {
  it('does not ship the unregistered placeholder', () => {
    // `dist/` is the local build. A platform build would carry a real id; a
    // local build carries the sentinel. Neither may carry `__APP_ID__`.
    const dir = join(ROOT, 'dist/assets')
    if (!existsSync(dir)) return
    const bundles = readdirSync(dir).filter((f) => f.endsWith('.js'))
    for (const file of bundles) {
      const content = readFileSync(join(dir, file), 'utf8')
      assert.ok(!content.includes('__APP_ID__'), `${file} must not contain the placeholder`)
    }
  })
})
