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
 */
function decide(pathname: string, assets: Map<string, string>): { status: number; body: string; shell: boolean } {
  const hit = assets.get(pathname)
  if (hit !== undefined) return { status: 200, body: hit, shell: false }

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
