import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * DeepSpace migration manifest.
 *
 * The manifest is a **JSON string array** of advisory ids the app has actually
 * implemented — not an object, not a wish list. The CLI parses it with
 * `validateAppMigrationIds`, which requires an array of unique ids matching
 * `/^[a-z0-9][a-z0-9._-]{0,127}$/`.
 *
 * ## Why the not-applicable ones are asserted explicitly
 *
 * Six advisories ship with this SDK version and are deliberately **absent**.
 * Each describes a surface SignalMesh does not have (platform integrations, the
 * AI SDK, Composio billing, file routes, agent tools) or a decision this project
 * has not taken (public-page SEO). Encoding that absence here means adding one
 * later is a visible, reviewable change rather than a silent omission.
 */

const ROOT = process.cwd()
const MANIFEST = 'deepspace.migrations.json'

/** Advisory ids that ship with deepspace 0.44.2. */
const ALL_ADVISORIES = [
  '2026-08-worker-owned-not-found',
  '2026-08-secure-room-boundaries',
  '2026-08-action-tools-delete-where',
  '2026-08-build-injected-app-id',
  '2026-08-action-routes-bearer-guard',
  '2026-09-files-session-cookie-reads',
  '2026-09-ai-sdk-7',
  '2026-10-integrations-sign-in',
  '2026-10-agent-tool-context',
  '2026-10-public-page-seo',
  '2026-11-composio-user-billing',
  '2026-11-route-param-lookups',
]

/**
 * Advisories that do not apply, with the reason.
 *
 * Kept as data so the test message explains *why* rather than just failing.
 */
const NOT_APPLICABLE: Record<string, string> = {
  '2026-09-files-session-cookie-reads':
    'The app has no app-files route; `/files/*` is never mounted and `appFiles` is never imported.',
  '2026-09-ai-sdk-7': 'The app uses no AI SDK. Gemini is called directly over HTTP with its own key.',
  '2026-10-integrations-sign-in':
    'The app has no platform integrations surface: no `callIntegration`, no integrations registry.',
  '2026-10-agent-tool-context':
    'The app exposes no agent tools; `registerAgentToolRoutes` is never called.',
  '2026-10-public-page-seo':
    'Indexation strategy is an open product decision. The app stays private: no prerender, no sitemap, and private routes are `noindex`.',
  '2026-11-composio-user-billing': 'Composio is not used anywhere in the app.',
}

describe('deepspace.migrations.json', () => {
  const raw = readFileSync(join(ROOT, MANIFEST), 'utf8')

  it('is valid JSON', () => {
    assert.doesNotThrow(() => JSON.parse(raw))
  })

  it('is a string array, which is what the CLI validates', () => {
    const parsed: unknown = JSON.parse(raw)
    assert.ok(Array.isArray(parsed), 'the CLI requires an array, not an object')
    for (const entry of parsed) assert.equal(typeof entry, 'string')
  })

  it('uses ids matching the CLI format', () => {
    const parsed = JSON.parse(raw) as string[]
    const RE = /^[a-z0-9][a-z0-9._-]{0,127}$/
    for (const id of parsed) assert.match(id, RE, `malformed migration id: ${id}`)
  })

  it('contains no duplicates', () => {
    const parsed = JSON.parse(raw) as string[]
    assert.equal(new Set(parsed).size, parsed.length)
  })

  it('only lists advisories this SDK version actually ships', () => {
    const parsed = JSON.parse(raw) as string[]
    const unknown = parsed.filter((id) => !ALL_ADVISORIES.includes(id))
    assert.deepEqual(unknown, [], `unknown advisory ids: ${unknown.join(', ')}`)
  })

  it('lists every advisory that has been implemented', () => {
    const parsed = JSON.parse(raw) as string[]
    // These six are the ones this codebase satisfies; see the doc table.
    for (const id of [
      '2026-08-worker-owned-not-found',
      '2026-08-secure-room-boundaries',
      '2026-08-action-tools-delete-where',
      '2026-08-build-injected-app-id',
      '2026-08-action-routes-bearer-guard',
      '2026-11-route-param-lookups',
    ]) {
      assert.ok(parsed.includes(id), `${id} is implemented but not recorded`)
    }
  })

  it('omits every advisory that does not apply, and each omission is justified', () => {
    const parsed = JSON.parse(raw) as string[]
    const omitted = ALL_ADVISORIES.filter((id) => !parsed.includes(id))
    for (const id of omitted) {
      assert.ok(id in NOT_APPLICABLE, `${id} is omitted without a recorded reason`)
    }
    // No stale reasons: every justified id must actually be omitted.
    for (const id of Object.keys(NOT_APPLICABLE)) {
      assert.ok(!parsed.includes(id), `${id} is recorded as applied and as not-applicable`)
    }
  })

  it('every applied migration has evidence in the code', () => {
    const parsed = JSON.parse(raw) as string[]
    const evidence: Record<string, () => boolean> = {
      '2026-08-worker-owned-not-found': () => {
        const toml = readFileSync(join(ROOT, 'wrangler.toml'), 'utf8')
        const worker = readFileSync(join(ROOT, 'worker.ts'), 'utf8')
        return /not_found_handling\s*=\s*"none"/.test(toml) && /last\.includes\('\.'\)/.test(worker)
      },
      '2026-08-secure-room-boundaries': () => {
        const worker = readFileSync(join(ROOT, 'worker.ts'), 'utf8')
        // Verified identity forwarded via the SDK helper, never via the path.
        return /authenticatedRoomRequest\(/.test(worker) && !/token=\$\{/.test(worker)
      },
      '2026-08-action-tools-delete-where': () => {
        const routes = readFileSync(join(ROOT, 'server/http/action-routes.ts'), 'utf8')
        const types = readFileSync(join(ROOT, 'server/actions/types.ts'), 'utf8')
        return /async deleteWhere\(/.test(routes) && /deleteWhere\(/.test(types)
      },
      '2026-08-build-injected-app-id': () => {
        const vite = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8')
        const constants = readFileSync(join(ROOT, 'src/app/constants.ts'), 'utf8')
        // The platform plugin injects the define; the client validates it.
        return /deepspaceBuild\(/.test(vite) && /APP_ID_RE\.test\(candidate\)/.test(constants)
      },
      '2026-08-action-routes-bearer-guard': () => {
        const routes = readFileSync(join(ROOT, 'server/http/action-routes.ts'), 'utf8')
        const worker = readFileSync(join(ROOT, 'worker.ts'), 'utf8')
        return /bearerToken\(/.test(routes) && /resolveBearerIdentity/.test(worker)
      },
      '2026-11-route-param-lookups': () => {
        const routes = readFileSync(join(ROOT, 'server/http/action-routes.ts'), 'utf8')
        // The route must resolve through the own-property helper, never index.
        return /lookupOwnAction\(/.test(routes) && !/actions\[name\]/.test(routes)
      },
    }

    for (const id of parsed) {
      const checker = evidence[id]
      assert.ok(checker, `no evidence check defined for ${id}`)
      assert.equal(checker(), true, `${id} is recorded as applied but the code does not show it`)
    }
  })
})
