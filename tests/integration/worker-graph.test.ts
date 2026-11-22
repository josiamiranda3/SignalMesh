import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The Worker bundle must stay free of Node-only runtimes.
 *
 * ## Why this is a test and not a comment
 *
 * DeepSpace runs the app on workerd. `node:sqlite` is only available there when
 * the compatibility date is on or after 2026-01-29 (or the
 * `enable_nodejs_sqlite_module` flag is set); this app declares 2025-01-01. A
 * static import of `node:sqlite` in the Worker graph therefore makes the
 * production build fail â€" while every local test still passes, because tests run
 * under Node where the module exists.
 *
 * That asymmetry is exactly how the defect reached v0.2.4.3: `normalizeUrl` and
 * the cookie helpers lived in modules that import the SQLite adapter, so three
 * Worker-reachable files pulled the database into the edge bundle without anyone
 * importing a database on purpose.
 *
 * This suite asserts the *property* (no Node-only module is reachable from the
 * Worker entry) rather than the current module layout, so it keeps holding if
 * files move again.
 */

const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** Modules that must never reach the Worker graph, and why. */
const FORBIDDEN = [
  {
    specifier: 'node:sqlite',
    reason: 'unavailable on workerd at compatibility_date 2025-01-01',
  },
  { specifier: 'node:fs', reason: 'no filesystem on the edge runtime' },
  { specifier: 'node:path', reason: 'no filesystem on the edge runtime' },
]

/**
 * Files the Worker entry transitively imports.
 *
 * Resolved from `worker.ts` by following relative imports. Node builtins and
 * package specifiers stop the walk (packages are bundled by the platform's own
 * toolchain and are out of scope here).
 */
function reachableFromWorker(): string[] {
  const seen = new Set<string>()
  const queue = [join(ROOT, 'worker.ts')]

  while (queue.length > 0) {
    const file = queue.pop() as string
    if (seen.has(file)) continue
    seen.add(file)

    let source: string
    try {
      source = readFileSync(file, 'utf8')
    } catch {
      continue
    }

    for (const specifier of relativeImportsIn(source)) {
      queue.push(resolveRelative(file, specifier))
    }
  }

  return [...seen]
}

/**
 * Every relative import specifier in a source file.
 *
 * Type-only imports are skipped on purpose: `import type { X } from './y.ts'`
 * is erased by the compiler and never reaches the bundle. Counting them would
 * report a graph the build does not actually have â€" `auth-resolver.ts` imports
 * the `SessionStore` *type* from the SQLite module without importing its
 * runtime, and that is legitimate.
 */
function relativeImportsIn(source: string): string[] {
  const withoutTypeImports = source.replace(
    /(?:^|\n)\s*(?:import|export)\s+type\b[^;\n]*?from\s*['"][^'"]+['"]\s*;?/g,
    '\n',
  )

  const found: string[] = []
  const patterns = [
    /(?:^|\n)\s*import\s+[^'"]*from\s+['"](\.[^'"]+)['"]/g,
    /(?:^|\n)\s*import\s+['"](\.[^'"]+)['"]/g,
    /(?:^|\n)\s*export\s+[^'"]*from\s+['"](\.[^'"]+)['"]/g,
    /import\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of withoutTypeImports.matchAll(pattern)) found.push(match[1] as string)
  }
  return found
}

/** Resolve a relative specifier to an on-disk `.ts` file. */
function resolveRelative(fromFile: string, specifier: string): string {
  const base = join(fromFile, '..', specifier)
  // The repository uses explicit extensions; normalise either style.
  return base.replace(/\.js$/, '.ts')
}

/** Every *runtime* Node-builtin import in a source file (type-only excluded). */
function nodeImportsIn(source: string): string[] {
  const withoutTypeImports = source.replace(
    /(?:^|\n)\s*(?:import|export)\s+type\b[^;\n]*?from\s*['"][^'"]+['"]\s*;?/g,
    '\n',
  )

  const found: string[] = []
  const pattern = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](node:[^'"]+)['"]/g
  for (const match of withoutTypeImports.matchAll(pattern)) found.push(match[1] as string)
  return found
}

describe('Worker graph: no Node-only runtime', () => {
  it('reaches the modules it is supposed to reach', () => {
    // Guards the walker itself: a broken resolver would make every assertion
    // below vacuously true.
    const files = reachableFromWorker().map((file) => file.slice(ROOT.length).replace(/\\/g, '/'))
    assert.ok(files.includes('worker.ts'), 'walk starts at worker.ts')
    assert.ok(files.includes('server/app.ts'), 'reaches the app assembly')
    assert.ok(files.includes('server/services/research.ts'), 'reaches the research service')
    assert.ok(
      files.includes('server/repositories/records/repositories.ts'),
      'reaches the records adapter',
    )
  })

  it('never statically imports a Node-only runtime', () => {
    const offenders: Array<{ file: string; specifier: string }> = []

    for (const file of reachableFromWorker()) {
      for (const specifier of nodeImportsIn(readFileSync(file, 'utf8'))) {
        if (FORBIDDEN.some((entry) => entry.specifier === specifier)) {
          offenders.push({ file: file.slice(ROOT.length).replace(/\\/g, '/'), specifier })
        }
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `The Worker graph must not import Node-only modules:\n${offenders
        .map((entry) => `  ${entry.file} imports ${entry.specifier}`)
        .join('\n')}`,
    )
  })

  it('keeps the SQLite adapter out of the graph entirely', () => {
    const files = reachableFromWorker().map((file) => file.slice(ROOT.length).replace(/\\/g, '/'))
    assert.ok(!files.includes('server/db.ts'), 'server/db.ts must not be reachable from the Worker')
    assert.ok(
      !files.includes('server/repositories/sqlite.ts'),
      'the SQLite adapter must not be reachable from the Worker',
    )
    assert.ok(
      !files.includes('server/lib/sessions.ts'),
      'the SQLite-backed session store must not be reachable from the Worker',
    )
  })

  it('keeps the pure helpers in a module the Worker can import', () => {
    // The two functions that used to drag the adapter in. They must stay
    // importable without a database, or the graph above becomes reachable again.
    const files = reachableFromWorker().map((file) => file.slice(ROOT.length).replace(/\\/g, '/'))
    assert.ok(files.includes('server/lib/util.ts'), 'normalizeUrl lives in lib/util.ts')
    assert.ok(
      files.includes('server/lib/session-cookies.ts'),
      'the cookie helpers live in lib/session-cookies.ts',
    )
  })

  it('documents no Node filesystem use outside the email digest helper', () => {
    // `node:crypto` is legitimately required by research.ts for a query hash,
    // and the crypto module has been available on workerd since nodejs_compat.
    // This test pins that it is the ONLY Node builtin left in the graph, so a
    // future import has to justify itself here.
    const allowed = new Set(['node:crypto'])
    const unexpected: Array<{ file: string; specifier: string }> = []

    for (const file of reachableFromWorker()) {
      for (const specifier of nodeImportsIn(readFileSync(file, 'utf8'))) {
        if (!allowed.has(specifier)) {
          unexpected.push({ file: file.slice(ROOT.length).replace(/\\/g, '/'), specifier })
        }
      }
    }

    assert.deepEqual(
      unexpected,
      [],
      `Unexpected Node builtin in the Worker graph:\n${unexpected
        .map((entry) => `  ${entry.file} imports ${entry.specifier}`)
        .join('\n')}`,
    )
  })
})

describe('dependency direction: adapters point inward, helpers do not point outward', () => {
  /** Import specifiers actually declared by a module (not ones its prose names). */
  function importSpecifiers(source: string): string[] {
    const found: string[] = []
    const pattern = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g
    for (const match of source.matchAll(pattern)) found.push(match[1] as string)
    return found
  }

  it('lib/util.ts imports no database or repository module', () => {
    const source = readFileSync(join(ROOT, 'server/lib/util.ts'), 'utf8')
    const specifiers = importSpecifiers(source)
    assert.deepEqual(specifiers, [], 'util.ts is dependency-free')
    assert.deepEqual(nodeImportsIn(source), [], 'no Node builtins')
  })

  it('lib/session-cookies.ts imports no database or repository module', () => {
    const source = readFileSync(join(ROOT, 'server/lib/session-cookies.ts'), 'utf8')
    const specifiers = importSpecifiers(source)
    assert.ok(
      specifiers.every((specifier) => !specifier.includes('db.ts')),
      'no database import',
    )
    assert.ok(
      specifiers.every((specifier) => !specifier.includes('repositories/')),
      'no repository import',
    )
    // Prose may *mention* `node:sqlite` to explain the split; only real imports
    // count.
    assert.deepEqual(nodeImportsIn(source), [], 'no Node builtins')
  })

  it('the SQLite adapter re-exports normalizeUrl for its Node-side callers', () => {
    // Parity tests and the SQLite adapter itself still import it from there;
    // the re-export keeps one implementation, not two.
    const source = readFileSync(join(ROOT, 'server/repositories/sqlite.ts'), 'utf8')
    assert.match(source, /export \{ normalizeUrl \} from '\.\.\/lib\/util\.ts'/)
  })
})


