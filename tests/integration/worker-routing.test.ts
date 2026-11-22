import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Worker routing contract.
 *
 * ## Why this suite reads the source
 *
 * The Worker cannot be instantiated here: `workerd` crashes with
 * `std::terminate()` on this machine (see docs/testing.md §4.19), and the Worker
 * imports `deepspace/worker`, which needs the platform runtime. There is no way
 * to *execute* `worker.ts`'s fetch handler in this environment without stubbing
 * the entire platform.
 *
 * So this suite does what it can honestly do: it asserts the **routing
 * decisions** in the source, and it executes the equivalent branching logic
 * against a fake ASSETS binding — which is what actually distinguishes "SPA
 * shell" from "404". It does not claim the Worker runs.
 *
 * The alternative — a test that mocks `deepspace/worker` wholesale — would
 * assert a stub, which is exactly the "mock presented as integration" failure
 * mode this project forbids.
 */

const ROOT = process.cwd()

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

describe('wrangler routing configuration', () => {
  const toml = read('wrangler.toml')

  it('sets not_found_handling = "none" so the Worker owns 404s', () => {
    assert.match(toml, /not_found_handling\s*=\s*"none"/)
  })

  /**
   * The SPA deep-link regression.
   *
   * `worker.ts` does `const asset = await env.ASSETS.fetch(request)` and returns
   * anything that is not a 404. Cloudflare's default `html_handling`
   * (`auto-trailing-slash`) turns a navigation for a path with no matching file
   * into `/index.html`, canonicalised to `/` with a **307**. That 307 satisfied
   * `!== 404`, so it was handed to the browser verbatim and the Worker's own SPA
   * fallback never ran: `/login`, `/history`, `/settings` all landed on `/`.
   *
   * `html_handling = "none"` makes the asset layer answer a real 404, which is
   * what the fallback expects.
   */
  it('sets html_handling = "none" so deep links are not 307-redirected by the asset layer', () => {
    assert.match(
      toml,
      /html_handling\s*=\s*"none"/,
      'without html_handling = "none" the asset layer answers a 307 for unknown paths',
    )
  })

  it('keeps every other [assets] setting intact', () => {
    // This change adds one key; it must not drop or alter the rest.
    assert.match(toml, /directory\s*=\s*"dist"/)
    assert.match(toml, /binding\s*=\s*"ASSETS"/)
    assert.match(toml, /not_found_handling\s*=\s*"none"/)
    assert.match(toml, /run_worker_first\s*=\s*\[/)
  })

  it('declares html_handling inside the [assets] block, not elsewhere', () => {
    const lines = toml.split('\n')
    const assetsAt = lines.findIndex((l) => l.trim() === '[assets]')
    assert.ok(assetsAt >= 0, '[assets] section not found')

    // Find the next section header after [assets]; the key must sit before it.
    const nextSection = lines.findIndex((l, i) => i > assetsAt && /^\s*\[/.test(l))
    const end = nextSection === -1 ? lines.length : nextSection

    const keyLine = lines.findIndex((l, i) => i > assetsAt && i < end && /^\s*html_handling\s*=/.test(l))
    assert.ok(keyLine > assetsAt && keyLine < end, 'html_handling must be declared inside [assets]')
  })

  it('uses a value wrangler accepts', () => {
    // wrangler's schema: auto-trailing-slash | force-trailing-slash |
    // drop-trailing-slash | none
    const match = /html_handling\s*=\s*"([^"]+)"/.exec(toml)
    assert.ok(match, 'html_handling not found')
    assert.ok(
      ['auto-trailing-slash', 'force-trailing-slash', 'drop-trailing-slash', 'none'].includes(match[1]!),
      `unsupported html_handling: ${match[1]}`,
    )
  })

  it('routes API and socket prefixes to the worker before the asset layer', () => {
    assert.match(toml, /run_worker_first\s*=\s*\[/)
    const line = toml.split('\n').find((l) => l.includes('run_worker_first')) ?? ''
    for (const prefix of ['/api/*', '/ws/*']) {
      assert.ok(line.includes(prefix), `${prefix} must run worker-first, or it can fall through to the SPA shell`)
    }
  })

  it('binds the built SPA directory', () => {
    assert.match(toml, /directory\s*=\s*"dist"/)
    assert.match(toml, /binding\s*=\s*"ASSETS"/)
  })
})

describe('worker fetch routing branches', () => {
  const source = read('worker.ts')

  it('claims /ws/* before anything else', () => {
    const wsIndex = source.indexOf("url.pathname.startsWith('/ws/')")
    const apiIndex = source.indexOf("url.pathname.startsWith('/api/')")
    const assetIndex = source.indexOf('env.ASSETS.fetch(request)')
    assert.ok(wsIndex > 0 && apiIndex > 0 && assetIndex > 0)
    assert.ok(wsIndex < apiIndex, '/ws/* must be decided before /api/*')
    assert.ok(apiIndex < assetIndex, '/api/* must be decided before the asset layer')
  })

  it('returns 404 for a missing file instead of the SPA shell', () => {
    // The guard: a path whose last segment contains a dot is a file request.
    assert.match(source, /last\.includes\('\.'\)/)
    assert.match(source, /status:\s*404/)
  })

  it('serves the SPA shell for a client route without a file extension', () => {
    assert.match(source, /shellUrl\.pathname\s*=\s*'\/index\.html'/)
  })

  it('never answers an /api/* request with the SPA shell', () => {
    // The asset fallback must sit lexically after the /api/ return.
    const apiReturn = source.indexOf("if (url.pathname.startsWith('/api/'))")
    const shell = source.indexOf("shellUrl.pathname = '/index.html'")
    assert.ok(apiReturn < shell)
    // And the /api/ branch must return, not fall through.
    const apiBlock = source.slice(apiReturn, source.indexOf('// Static assets and SPA fallback'))
    assert.match(apiBlock, /return app\.fetch/)
  })
})

/**
 * Execute the fallback decision with a fake ASSETS binding.
 *
 * This mirrors `worker.ts`'s tail exactly: ask ASSETS; if not 404, serve it; if
 * it *is* 404 and the path looks like a file, answer JSON 404; otherwise serve
 * the shell. It is a re-implementation, so it does not prove `worker.ts` is
 * correct — it proves the *rule* is correct, and the source assertions above
 * tie the rule to the code.
 *
 * `assetMode` models the two `html_handling` configurations, because that is
 * exactly what this fix changes:
 *
 *  - `none`  — an unknown path answers **404**, so the Worker's fallback runs.
 *  - `auto`  — Cloudflare's default: an unknown *navigation* is rewritten to
 *              `/index.html` and canonicalised to `/` with a **307**. The Worker's
 *              `!== 404` guard passes that through, so the fallback never runs.
 */
function decide(
  pathname: string,
  assets: Map<string, string>,
  assetMode: 'none' | 'auto' = 'none',
): { status: number; body: string; shell: boolean; redirected?: string } {
  const hit = assets.get(pathname)
  if (hit !== undefined) return { status: 200, body: hit, shell: false }

  // The asset layer's own normalisation, before the Worker's logic sees anything.
  if (assetMode === 'auto') {
    const last = pathname.slice(pathname.lastIndexOf('/') + 1)
    // A file-like path still 404s; a route-like path is redirected to `/`.
    if (!last.includes('.')) {
      return { status: 307, body: '', shell: false, redirected: '/' }
    }
    return { status: 404, body: JSON.stringify({ error: 'not_found' }), shell: false }
  }

  const last = pathname.slice(pathname.lastIndexOf('/') + 1)
  if (last.includes('.')) {
    return { status: 404, body: JSON.stringify({ error: 'not_found' }), shell: false }
  }

  const shell = assets.get('/index.html')
  if (shell === undefined) return { status: 404, body: '', shell: false }
  return { status: 200, body: shell, shell: true }
}

describe('SPA fallback rule (executed against a fake ASSETS binding)', () => {
  const assets = new Map<string, string>([
    ['/index.html', '<!doctype html><title>SignalMesh</title>'],
    ['/assets/app.js', 'console.log(1)'],
    ['/favicon.svg', '<svg/>'],
    ['/robots.txt', 'User-agent: *'],
  ])

  it('serves a deep client route after a refresh', () => {
    const result = decide('/investigations/inv_123/evidence', assets)
    assert.equal(result.status, 200)
    assert.equal(result.shell, true)
  })

  it('serves the root route', () => {
    assert.equal(decide('/', assets).shell, true)
  })

  it('404s an asset that does not exist', () => {
    const result = decide('/assets/deleted-chunk-abc123.js', assets)
    assert.equal(result.status, 404)
    assert.equal(result.shell, false)
  })

  it('404s a missing file at the root', () => {
    const result = decide('/missing.png', assets)
    assert.equal(result.status, 404)
    assert.equal(result.shell, false)
  })

  it('serves an existing asset unchanged', () => {
    const result = decide('/assets/app.js', assets)
    assert.equal(result.status, 200)
    assert.equal(result.body, 'console.log(1)')
    assert.equal(result.shell, false)
  })

  it('serves an existing root file unchanged', () => {
    assert.equal(decide('/robots.txt', assets).body, 'User-agent: *')
    assert.equal(decide('/favicon.svg', assets).body, '<svg/>')
  })

  it('does not treat a route with a dot in a segment as a file when it has none in the last segment', () => {
    // `/v1.2/investigations` — dot in an earlier segment, clean last segment.
    assert.equal(decide('/v1.2/investigations', assets).shell, true)
  })
})

/**
 * Regression: the deep-link 307.
 *
 * This is the test that would have caught the production defect. With the
 * Cloudflare default (`auto`), the asset layer answers **307 → /** for an
 * unknown route, and the Worker's `!== 404` guard passes it straight through. The
 * SPA shell is therefore never served on a hard load, and the user lands on the
 * landing page instead of the requested route.
 */
describe('deep links are not 307-redirected (html_handling = "none")', () => {
  const assets = new Map<string, string>([
    ['/index.html', '<!doctype html><title>SignalMesh</title>'],
    ['/assets/app.js', 'console.log(1)'],
  ])

  const ROUTES = ['/login', '/history', '/settings', '/dashboard', '/investigations', '/validation']

  it('every SPA route is served the shell, not a redirect', () => {
    for (const route of ROUTES) {
      const result = decide(route, assets, 'none')
      assert.equal(result.status, 200, `${route} must be served, not redirected`)
      assert.equal(result.shell, true, `${route} must get the SPA shell`)
      assert.equal(result.redirected, undefined, `${route} must not redirect`)
    }
  })

  it('the previous configuration would have redirected them (documents the defect)', () => {
    // With `auto` (the old behaviour) the same routes 307 to `/`. Asserted so the
    // regression is recorded, not merely described.
    for (const route of ROUTES) {
      const result = decide(route, assets, 'auto')
      assert.equal(result.status, 307, `${route} would have been redirected under auto-trailing-slash`)
      assert.equal(result.redirected, '/', `${route} would have been redirected to /`)
      assert.equal(result.shell, false)
    }
  })

  it('static files are still served unchanged in both modes', () => {
    for (const mode of ['none', 'auto'] as const) {
      const result = decide('/assets/app.js', assets, mode)
      assert.equal(result.status, 200, mode)
      assert.equal(result.body, 'console.log(1)', mode)
      assert.equal(result.shell, false, mode)
    }
  })

  it('a missing asset still 404s in both modes', () => {
    for (const mode of ['none', 'auto'] as const) {
      const result = decide('/assets/deleted-chunk-abc.js', assets, mode)
      assert.equal(result.status, 404, mode)
      assert.notEqual(result.status, 307, `${mode}: a missing file must not redirect`)
    }
  })

  it('the Worker never forwards a 307 for a route-shaped path', () => {
    // The guard under test: `if (asset.status !== 404) return asset`.
    // A 307 is "not 404", so it would be forwarded. `html_handling = "none"` is
    // what prevents the asset layer from producing one in the first place.
    const forwarded = decide('/login', assets, 'auto')
    assert.equal(forwarded.status, 307, 'auto mode produces a 307 that the Worker forwards')

    const fixed = decide('/login', assets, 'none')
    assert.equal(fixed.status, 200, 'none mode produces a 404 the Worker turns into the shell')
  })
})
