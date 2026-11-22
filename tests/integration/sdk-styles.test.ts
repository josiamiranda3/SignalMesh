import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The SDK stylesheet contract.
 *
 * ## The production defect this prevents
 *
 * The DeepSpace SDK ships its UI as compiled JavaScript whose `className`
 * strings are literal Tailwind utilities (`bg-card`, `border-border`,
 * `max-w-[380px]`, `p-8`, …). Tailwind v4 discovers classes by scanning source
 * files and skips `node_modules`, so none of those utilities were emitted.
 *
 * The visible result on `/login`:
 *
 *  - `.border` still applied its 1px width, but with no `border-border` the
 *    colour fell back to `currentColor` — near-white hairlines that appeared to
 *    cross the GitHub / Google / email buttons;
 *  - `.bg-card`, `.p-8`, `.max-w-[380px]` and `.rounded-2xl` did not exist, so
 *    the auth card had no width cap, no padding and no fill — a full-bleed
 *    transparent box spanning the viewport, which read as the right-hand panel
 *    "invading" the left column.
 *
 * ## What is asserted
 *
 * Declaring the colour tokens is necessary but **not sufficient**: a token only
 * yields a utility when Tailwind also sees the utility's name. Both halves are
 * checked here — the tokens exist, and the classes are safelisted — and the
 * built stylesheet is inspected when present.
 */

const ROOT = process.cwd()

function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8')
}

/** Colour tokens the SDK's utilities reference. */
const REQUIRED_TOKENS = [
  '--color-border',
  '--color-background',
  '--color-foreground',
  '--color-card',
  '--color-card-foreground',
  '--color-muted',
  '--color-muted-foreground',
  '--color-secondary',
  '--color-secondary-foreground',
  '--color-accent',
  '--color-accent-foreground',
  '--color-primary',
  '--color-primary-foreground',
  '--color-input',
  '--color-ring',
]

/** Utilities the overlay's markup actually uses. */
const REQUIRED_UTILITIES = [
  'bg-card',
  'border-border',
  'text-foreground',
  'text-muted-foreground',
  'bg-secondary',
  'bg-accent',
  'shadow-card-hover',
  'bg-border',
  'p-8',
  'px-4',
  'py-2.5',
  'max-w-[380px]',
  'text-[22px]',
  'rounded-2xl',
  'w-7',
  'h-7',
  'z-[99999]',
  'backdrop-blur-2xl',
  'gap-2.5',
  'flex-1',
  'h-px',
]

describe('SDK design tokens', () => {
  const css = read('src/styles.css')

  it('declares every colour token the SDK utilities resolve against', () => {
    const missing = REQUIRED_TOKENS.filter((token) => !css.includes(`${token}:`))
    assert.deepEqual(missing, [], `missing tokens: ${missing.join(', ')}`)
  })

  it('declares the SDK shadow token', () => {
    assert.match(css, /--shadow-card-hover:/)
  })

  it('declares the backdrop branding hook the SDK documents', () => {
    assert.match(css, /--ds-auth-backdrop:/)
  })
})

describe('SDK utility safelist', () => {
  const css = read('src/styles.css')

  it('safelists utilities, since node_modules is not scanned', () => {
    assert.match(css, /@source\s+inline\(/, 'no @source inline safelist found')
  })

  it('safelists every utility the auth overlay renders', () => {
    // Collect everything inside the @source inline(...) directives.
    const safelisted = [...css.matchAll(/@source\s+inline\("([^"]*)"\)/g)]
      .flatMap((m) => m[1]!.split(/\s+/))
      .filter(Boolean)
    const missing = REQUIRED_UTILITIES.filter((u) => !safelisted.includes(u))
    assert.deepEqual(missing, [], `not safelisted: ${missing.join(', ')}`)
  })

  it('keeps each @source inline directive on one line', () => {
    // Tailwind's parser rejects a multi-line string; this was a real build
    // failure during the fix, so it is pinned.
    for (const line of css.split('\n')) {
      const opened = line.match(/@source\s+inline\(/g)?.length ?? 0
      const closed = line.match(/\);/g)?.length ?? 0
      if (opened > 0) assert.ok(closed >= 1, `unterminated @source inline: ${line.slice(0, 70)}`)
    }
  })
})

describe('built stylesheet', () => {
  it('emits the overlay utilities into dist, when a build exists', () => {
    // The platform build writes to dist/client/assets; a plain vite build writes
    // to dist/assets. Check whichever exists.
    const candidates = [join(ROOT, 'dist/client/assets'), join(ROOT, 'dist/assets')]
    const dir = candidates.find((d) => existsSync(d))
    if (!dir) {
      console.log('    (no build output present — skipping artefact check)')
      return
    }

    const stylesheets = readdirSync(dir).filter((f) => f.endsWith('.css'))
    assert.ok(stylesheets.length > 0, 'a stylesheet should exist in the build output')

    const all = stylesheets.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n')
    // CSS escaping means `max-w-[380px]` is emitted as `.max-w-\[380px\]`, and
    // `py-2.5` as `.py-2\.5`. Normalise both forms before comparing.
    const escaped = (u: string) => `.${u.replace(/[[\].]/g, (c) => `\\${c}`)}`
    const missing = REQUIRED_UTILITIES.filter(
      (u) => !all.includes(`.${u}`) && !all.includes(escaped(u)),
    )

    assert.deepEqual(
      missing,
      [],
      `the built stylesheet is missing: ${missing.join(', ')}\n` +
        'Run a fresh build — a stale dist/ will fail this check.',
    )
  })

  it('resolves the token-driven utilities to real values, not currentColor', () => {
    const candidates = [join(ROOT, 'dist/client/assets'), join(ROOT, 'dist/assets')]
    const dir = candidates.find((d) => existsSync(d))
    if (!dir) return

    const all = readdirSync(dir)
      .filter((f) => f.endsWith('.css'))
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n')

    // `border-border` must set an explicit colour. If it were absent, `.border`
    // would fall back to `currentColor` — the near-white hairlines seen in
    // production.
    assert.match(all, /\.border-border\{border-color:var\(--color-border\)\}/)
    assert.match(all, /\.bg-card\{background-color:var\(--color-card\)\}/)
  })
})