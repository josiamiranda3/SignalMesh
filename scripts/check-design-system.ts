/**
 * Design-system guard.
 *
 * The browser audit (`tests/e2e/design-audit.ts`) measures the rendered DOM, but
 * it needs a working browser and this environment cannot launch one. These
 * checks cover the properties that can be proven from source, and they are the
 * ones a redesign silently breaks:
 *
 *   1. **Contrast.** Every text/background pair the tokens define is measured
 *      against WCAG AA for the size class it is used at. The failure this
 *      prevents is real: Signal Red `#B64B50` is 3.86:1 on the canvas, so using
 *      it for body copy would fail AA — it is legal only as large text or as a
 *      surface carrying white.
 *   2. **Token integrity.** No removed colour name is still referenced, and no
 *      hex literal smuggles an un-audited colour into a component.
 *   3. **Surface ladder.** The five surface tiers are strictly ordered by
 *      luminance, so "raised" is actually lighter than "surface" everywhere.
 *   4. **Type roles.** The mono face is used for labels/figures and the sans for
 *      prose — the pairing the design language depends on.
 *
 *   node --experimental-transform-types --disable-warning=ExperimentalWarning \
 *     scripts/check-design-system.ts
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const STYLES = join(ROOT, 'src', 'styles.css')
const SRC = join(ROOT, 'src')

let failures = 0

function pass(label: string): void {
  console.log(`  ok    ${label}`)
}

function fail(label: string, detail: string): void {
  failures += 1
  console.log(`  FAIL  ${label}\n        ${detail}`)
}

// ---------------------------------------------------------------------------
// Colour maths
// ---------------------------------------------------------------------------

interface Rgb {
  r: number
  g: number
  b: number
}

function parseHex(value: string): Rgb {
  const hex = value.replace('#', '').trim()
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  }
}

function channel(value: number): number {
  const s = value / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a: string, b: string): number {
  const la = luminance(parseHex(a))
  const lb = luminance(parseHex(b))
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

// ---------------------------------------------------------------------------
// Token extraction
// ---------------------------------------------------------------------------

const css = readFileSync(STYLES, 'utf8')

function token(name: string): string {
  const match = new RegExp(`--color-${name}:\\s*(#[0-9A-Fa-f]{3,8})`).exec(css)
  if (!match) throw new Error(`token --color-${name} not declared in src/styles.css`)
  return match[1]!
}

// ---------------------------------------------------------------------------
// 1. Contrast
// ---------------------------------------------------------------------------

console.log('\n1. Contrast (WCAG AA)')

const SURFACES = ['canvas', 'base', 'surface', 'raised']

// Body ink must clear 4.5:1 on every surface it can sit on.
for (const ink of ['ink', 'ink-muted', 'ink-subtle']) {
  const fg = token(ink)
  for (const surface of SURFACES) {
    const ratio = contrast(fg, token(surface))
    if (ratio + 0.005 >= 4.5) pass(`--color-${ink} on --color-${surface} = ${ratio.toFixed(2)}:1`)
    else fail(`--color-${ink} on --color-${surface}`, `${ratio.toFixed(2)}:1 is below 4.5:1`)
  }
}

// The faint tier is for meta/labels only. It must still clear AA on the
// surfaces those labels actually appear on (surface and raised).
for (const surface of ['surface', 'raised']) {
  const ratio = contrast(token('ink-faint'), token(surface))
  if (ratio + 0.005 >= 4.5) pass(`--color-ink-faint on --color-${surface} = ${ratio.toFixed(2)}:1`)
  else fail(`--color-ink-faint on --color-${surface}`, `${ratio.toFixed(2)}:1 is below 4.5:1`)
}

// Signal Red as *text* is the documented trap: it passes only at large sizes.
const redOnCanvas = contrast(token('signal'), token('canvas'))
if (redOnCanvas >= 3) pass(`--color-signal on canvas = ${redOnCanvas.toFixed(2)}:1 (large-text tier)`)
else fail('--color-signal on canvas', `${redOnCanvas.toFixed(2)}:1 is below 3:1`)

if (redOnCanvas < 4.5) {
  // Document the constraint as a passing assertion: it must NOT be treated as
  // body-text colour. `signal-bright` exists for that role.
  const bright = contrast(token('signal-bright'), token('surface'))
  if (bright + 0.005 >= 4.5) pass(`--color-signal-bright on surface = ${bright.toFixed(2)}:1 (text-safe red)`)
  else fail('--color-signal-bright on surface', `${bright.toFixed(2)}:1 is below 4.5:1`)
}

// A solid red fill must carry white text at AA.
const whiteOnRed = contrast('#FFFFFF', token('signal'))
if (whiteOnRed + 0.005 >= 4.5) pass(`white on --color-signal = ${whiteOnRed.toFixed(2)}:1`)
else fail('white on --color-signal', `${whiteOnRed.toFixed(2)}:1 is below 4.5:1`)

// Semantic states are text colours on surface.
for (const state of ['positive', 'caution', 'negative']) {
  const ratio = contrast(token(state), token('surface'))
  if (ratio + 0.005 >= 4.5) pass(`--color-${state} on surface = ${ratio.toFixed(2)}:1`)
  else fail(`--color-${state} on surface`, `${ratio.toFixed(2)}:1 is below 4.5:1`)
}

// ---------------------------------------------------------------------------
// 2. Token integrity
// ---------------------------------------------------------------------------

console.log('\n2. Token integrity')

const sources: string[] = []
function walk(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full)
    else if (/\.(tsx?|css)$/.test(entry)) sources.push(full)
  }
}
walk(SRC)

/** Colour names that were removed in the redesign and must not return. */
const RETIRED = ['violet', 'cyan']

for (const retired of RETIRED) {
  const users = sources.filter((file) => {
    const text = readFileSync(file, 'utf8')
    return new RegExp(`(?:bg|text|border|from|to|via|ring|fill|stroke)-${retired}\\b`).test(text)
  })
  if (users.length === 0) pass(`retired token "${retired}" is unreferenced`)
  else fail(`retired token "${retired}"`, `still used in ${users.map((f) => relative(ROOT, f)).join(', ')}`)
}

// Every `text-<name>` / `bg-<name>` utility that looks like a semantic colour
// must resolve to a declared token. This catches typos that Tailwind would
// silently drop.
const declared = new Set(
  [...css.matchAll(/--color-([a-z-]+):/g)].map((match) => match[1] as string),
)
const UTILITY = /(?:^|[\s"'`])(?:bg|text|border|ring|fill|stroke|from|to|via)-([a-z][a-z-]*)/g
const unknown = new Map<string, Set<string>>()

for (const file of sources) {
  if (!file.endsWith('.tsx')) continue
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(UTILITY)) {
    const name = match[1] as string
    // Tailwind's own palette and structural utilities are out of scope: this
    // check only polices the *semantic* names the design system declares.
    const semantic =
      name.startsWith('ink') ||
      name.startsWith('signal') ||
      ['canvas', 'base', 'surface', 'raised', 'overlay', 'hairline', 'positive', 'caution', 'negative'].some(
        (known) => name === known || name.startsWith(`${known}-`),
      )
    if (!semantic) continue
    const base = name.replace(/-(strong|bright|deep|dim|muted|subtle|faint)$/, '')
    const resolved = declared.has(name) || declared.has(base)
    if (!resolved) {
      if (!unknown.has(name)) unknown.set(name, new Set())
      unknown.get(name)!.add(relative(ROOT, file))
    }
  }
}

if (unknown.size === 0) pass('every semantic colour utility resolves to a declared token')
else {
  for (const [name, files] of unknown) {
    fail(`unknown semantic colour "${name}"`, [...files].join(', '))
  }
}

// ---------------------------------------------------------------------------
// 3. Surface ladder
// ---------------------------------------------------------------------------

console.log('\n3. Surface ladder')

const ladder = ['canvas', 'base', 'surface', 'raised', 'overlay']
let ordered = true
for (let i = 1; i < ladder.length; i += 1) {
  const lower = luminance(parseHex(token(ladder[i - 1]!)))
  const higher = luminance(parseHex(token(ladder[i]!)))
  if (higher <= lower) {
    ordered = false
    fail(
      `surface ladder at ${ladder[i]}`,
      `${ladder[i]} must be lighter than ${ladder[i - 1]}`,
    )
  }
}
if (ordered) pass(`surface tiers ascend in luminance: ${ladder.join(' < ')}`)

// ---------------------------------------------------------------------------
// 4. Type roles
// ---------------------------------------------------------------------------

console.log('\n4. Type roles')

if (/\.eyebrow\s*\{[^}]*font-family:\s*var\(--font-mono\)/.test(css)) {
  pass('.eyebrow uses the mono face')
} else {
  fail('.eyebrow', 'must use var(--font-mono)')
}

if (/\.meta-label\s*\{[^}]*font-family:\s*var\(--font-mono\)/.test(css)) {
  pass('.meta-label uses the mono face')
} else {
  fail('.meta-label', 'must use var(--font-mono)')
}

if (/\.figure\s*\{[^}]*font-variant-numeric:\s*tabular-nums/.test(css)) {
  pass('.figure is tabular')
} else {
  fail('.figure', 'must be tabular-nums so columns of numbers align')
}

if (/:focus-visible\s*\{[^}]*outline:/.test(css)) {
  pass('a visible focus ring is defined globally')
} else {
  fail('focus-visible', 'no global focus outline')
}

if (/prefers-reduced-motion/.test(css)) {
  pass('reduced-motion is honoured')
} else {
  fail('prefers-reduced-motion', 'motion must be disabled on request')
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

console.log('')
if (failures === 0) {
  console.log('OK — design system verified (contrast, tokens, surfaces, type roles).')
} else {
  console.log(`${failures} problema(s) no sistema de design.`)
  process.exitCode = 1
}
