
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Worker routing contract.
 *
 * This suite validates:
 * - Wrangler routing configuration.
 * - SPA route coverage.
 * - Existing platform route preservation.
 * - Worker fallback decisions.
 *
 * It does not claim to execute the actual Cloudflare Worker.
 * The real deployment routing must be validated in production.
 */

const ROOT = process.cwd()

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

/**
 * Extract run_worker_first from wrangler.toml.
 *
 * The array is multiline and contains quoted route patterns.
 */
function readRunWorkerFirst(toml: string): string[] {
  const match = /run_worker_first\s*=\s*\[([\s\S]*?)\]/m.exec(toml)

  if (!match) return []

  return [...match[1]!.matchAll(/"([^"]+)"/g)]
    .map((entry) => entry[1]!)
}

/**
 * Mirror of the route matcher used by this test.
 *
 * Both bare paths and wildcard paths are explicitly configured.
 * The wildcard matcher covers the base and its subroutes.
 */
function covered(pathname: string, rules: string[]): boolean {
  return rules.some((rule) => {
    if (!rule.endsWith('/*')) {
      return pathname === rule
    }

    const base = rule.slice(0, -2)

    return pathname === base || pathname.startsWith(`${base}/`)
  })
}

/**
 * Required SPA routes.
 *
 * Bare routes and subroutes are declared separately in the TOML
 * to avoid depending on wildcard base-path behavior.
 */
const SPA_ROUTES = [
  '/login',
  '/dashboard',
  '/investigations',
  '/validation',
  '/history',
  '/settings',
]

const SPA_SUBROUTES = [
  '/dashboard/*',
  '/investigations/*',
  '/validation/*',
  '/history/*',
  '/settings/*',
]

const PLATFORM_ROUTES = [
  '/api/*',
  '/ws/*',
  '/internal/*',
  '/v1/*',
  '/_deepspace/*',
  '/llms.txt',
  '/llms-full.txt',
  '/.well-known/mcp',
  '/.well-known/mcp.json',
  '/.well-known/mcp/*',
]

describe('wrangler routing configuration', () => {
  const toml = read('wrangler.toml')

  it('sets not_found_handling = "none" so the Worker owns missing paths', () => {
    assert.match(toml, /not_found_handling\s*=\s*"none"/)
  })

  it('does not depend on html_handling for SPA routing', () => {
    assert.doesNotMatch(
      toml,
      /^\s*html_handling\s*=/m,
      'html_handling is not forwarded by the current DeepSpace deployment mapper',
    )
  })

  it('keeps every required [assets] setting intact', () => {
    assert.match(toml, /^\s*directory\s*=\s*"dist"/m)
    assert.match(toml, /^\s*binding\s*=\s*"ASSETS"/m)
    assert.match(toml, /^\s*not_found_handling\s*=\s*"none"/m)
    assert.match(toml, /^\s*run_worker_first\s*=\s*\[/m)
  })

  it('declares run_worker_first inside the [assets] section', () => {
    const lines = toml.split('\n')

    const assetsAt = lines.findIndex(
      (line) => line.trim() === '[assets]',
    )

    assert.ok(assetsAt >= 0, '[assets] section not found')

    const nextSection = lines.findIndex(
      (line, index) =>
        index > assetsAt && /^\s*\[/.test(line),
    )

    const end = nextSection === -1 ? lines.length : nextSection

    const keyLine = lines.findIndex(
      (line, index) =>
        index > assetsAt &&
        index < end &&
        /^\s*run_worker_first\s*=/.test(line),
    )

    assert.ok(
      keyLine > assetsAt && keyLine < end,
      'run_worker_first must be declared inside [assets]',
    )
  })

  it('binds the built SPA directory', () => {
    assert.match(toml, /directory\s*=\s*"dist"/)
    assert.match(toml, /binding\s*=\s*"ASSETS"/)
  })

  it('preserves the Durable Object configuration', () => {
    assert.match(toml, /class_name\s*=\s*"AppRecordRoom"/)
    assert.match(toml, /name\s*=\s*"RECORD_ROOMS"/)
  })
})

describe('run_worker_first configuration', () => {
  const toml = read('wrangler.toml')
  const rules = readRunWorkerFirst(toml)

  it('parses the route list', () => {
    assert.ok(
      rules.length > 0,
      'run_worker_first must contain route patterns',
    )
  })

  it('contains only well-formed route patterns', () => {
    const malformed = rules.filter(
      (rule) => !rule.startsWith('/') && !rule.startsWith('!/'),
    )

    assert.deepEqual(
      malformed,
      [],
      `Malformed rules: ${malformed.join(', ')}`,
    )
  })

  it('does not introduce negative routing rules', () => {
    const negatives = rules.filter((rule) => rule.startsWith('!/'))

    assert.deepEqual(
      negatives,
      [],
      `Unexpected negative rules: ${negatives.join(', ')}`,
    )
  })

  it('contains every SPA entry route', () => {
    for (const route of SPA_ROUTES) {
      assert.ok(
        rules.includes(route),
        `${route} must be explicitly configured`,
      )
    }
  })

  it('contains every SPA subroute pattern', () => {
    for (const route of SPA_SUBROUTES) {
      assert.ok(
        rules.includes(route),
        `${route} must be explicitly configured`,
      )
    }
  })

  it('covers all SPA routes', () => {
    for (const route of SPA_ROUTES) {
      assert.equal(
        covered(route, rules),
        true,
        `${route} must reach the Worker`,
      )
    }
  })

  it('covers SPA subroutes', () => {
    const routes = [
      '/dashboard/overview',
      '/dashboard/projects',
      '/investigations/new',
      '/investigations/inv_123/evidence',
      '/validation/xyz',
      '/history/2026',
      '/history/2026/11',
      '/settings/limits',
      '/settings/profile',
    ]

    for (const route of routes) {
      assert.equal(
        covered(route, rules),
        true,
        `${route} must reach the Worker`,
      )
    }
  })

  it('preserves all existing platform routes', () => {
    for (const route of PLATFORM_ROUTES) {
      assert.ok(
        rules.includes(route),
        `${route} must be preserved`,
      )
    }
  })

  it('keeps platform routes before SPA routes', () => {
    const firstSpaIndex = rules.indexOf('/login')

    assert.ok(firstSpaIndex >= 0)

    for (const route of PLATFORM_ROUTES) {
      assert.ok(
        rules.indexOf(route) >= 0 &&
          rules.indexOf(route) < firstSpaIndex,
        `${route} must remain before SPA routes`,
      )
    }
  })

  it('does not use a global wildcard', () => {
    assert.ok(!rules.includes('/*'))
    assert.ok(!rules.includes('*'))
  })

  it('does not route static assets through SPA patterns', () => {
    const assets = [
      '/assets/index-abc123.js',
      '/assets/index-abc123.css',
      '/assets/logo.svg',
      '/favicon.svg',
      '/robots.txt',
      '/missing.png',
    ]

    for (const asset of assets) {
      assert.equal(
        covered(asset, rules),
        false,
        `${asset} must remain outside SPA route patterns`,
      )
    }
  })
})

describe('Worker fetch routing branches', () => {
  const source = read('worker.ts')

  it('handles WebSocket routes before API and asset handling', () => {
    const wsIndex = source.indexOf(
      "url.pathname.startsWith('/ws/')",
    )

    const apiIndex = source.indexOf(
      "url.pathname.startsWith('/api/')",
    )

    const assetIndex = source.indexOf(
      'env.ASSETS.fetch(request)',
    )

    assert.ok(wsIndex >= 0, 'WebSocket routing not found')
    assert.ok(apiIndex >= 0, 'API routing not found')
    assert.ok(assetIndex >= 0, 'Assets routing not found')

    assert.ok(wsIndex < apiIndex)
    assert.ok(apiIndex < assetIndex)
  })

  it('returns 404 for missing file requests', () => {
    assert.ok(
      source.includes("last.includes('.')"),
      'Worker must identify file-like paths',
    )

    assert.match(source, /status\s*:\s*404/)
  })

  it('serves the SPA shell through index.html', () => {
    assert.ok(
      source.includes("shellUrl.pathname = '/'"),
      'Worker must resolve the SPA shell',
    )
  })

  it('does not let API requests fall through to the SPA shell', () => {
    const apiIndex = source.indexOf(
      "if (url.pathname.startsWith('/api/'))",
    )

    const shellIndex = source.indexOf(
      "shellUrl.pathname = '/'",
    )

    assert.ok(apiIndex >= 0)
    assert.ok(shellIndex >= 0)
    assert.ok(apiIndex < shellIndex)

    const apiBlock = source.slice(
      apiIndex,
      source.indexOf('// Static assets and SPA fallback', apiIndex),
    )

    assert.match(apiBlock, /return\s+app\.fetch/)
  })
})

/**
 * Simulates the Worker fallback using a fake ASSETS binding.
 *
 * This validates the fallback decision after a request reaches
 * the Worker. It does not simulate Cloudflare run_worker_first.
 */
function decide(
  pathname: string,
  assets: Map<string, string>,
): {
  status: number
  body: string
  shell: boolean
} {
  const hit = assets.get(pathname)

  if (hit !== undefined) {
    return {
      status: 200,
      body: hit,
      shell: false,
    }
  }

  const lastSegment = pathname.slice(
    pathname.lastIndexOf('/') + 1,
  )

  if (lastSegment.includes('.')) {
    return {
      status: 404,
      body: JSON.stringify({ error: 'not_found' }),
      shell: false,
    }
  }

  const shell = assets.get('/index.html')

  if (shell === undefined) {
    return {
      status: 404,
      body: '',
      shell: false,
    }
  }

  return {
    status: 200,
    body: shell,
    shell: true,
  }
}

describe('SPA fallback rule', () => {
  const assets = new Map<string, string>([
    ['/index.html', '<!doctype html><title>SignalMesh</title>'],
    ['/assets/app.js', 'console.log(1)'],
    ['/favicon.svg', '<svg/>'],
    ['/robots.txt', 'User-agent: *'],
  ])

  it('serves a deep client route after refresh', () => {
    const result = decide(
      '/investigations/inv_123/evidence',
      assets,
    )

    assert.equal(result.status, 200)
    assert.equal(result.shell, true)
  })

  it('serves the login route', () => {
    const result = decide('/login', assets)

    assert.equal(result.status, 200)
    assert.equal(result.shell, true)
  })

  it('serves the root route', () => {
    const result = decide('/', assets)

    assert.equal(result.status, 200)
    assert.equal(result.shell, true)
  })

  it('serves every configured SPA route', () => {
    for (const route of SPA_ROUTES) {
      const result = decide(route, assets)

      assert.equal(
        result.status,
        200,
        `${route} must return 200`,
      )

      assert.equal(
        result.shell,
        true,
        `${route} must receive the SPA shell`,
      )
    }
  })

  it('serves SPA subroutes', () => {
    const routes = [
      '/dashboard/overview',
      '/investigations/new',
      '/validation/xyz',
      '/history/2026',
      '/settings/limits',
    ]

    for (const route of routes) {
      const result = decide(route, assets)

      assert.equal(result.status, 200, route)
      assert.equal(result.shell, true, route)
    }
  })

  it('returns 404 for a missing JavaScript asset', () => {
    const result = decide(
      '/assets/deleted-chunk-abc123.js',
      assets,
    )

    assert.equal(result.status, 404)
    assert.equal(result.shell, false)
  })

  it('returns 404 for a missing root file', () => {
    const result = decide('/missing.png', assets)

    assert.equal(result.status, 404)
    assert.equal(result.shell, false)
  })

  it('serves existing assets unchanged', () => {
    const result = decide('/assets/app.js', assets)

    assert.equal(result.status, 200)
    assert.equal(result.body, 'console.log(1)')
    assert.equal(result.shell, false)
  })

  it('serves existing root files unchanged', () => {
    assert.equal(
      decide('/robots.txt', assets).body,
      'User-agent: *',
    )

    assert.equal(
      decide('/favicon.svg', assets).body,
      '<svg/>',
    )
  })

  it('does not treat a dot in an earlier segment as a file extension', () => {
    const result = decide('/v1.2/investigations', assets)

    assert.equal(result.status, 200)
    assert.equal(result.shell, true)
  })
})
