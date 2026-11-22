/**
 * Encoding audit.
 *
 * PowerShell edits earlier in this project corrupted some files by writing
 * UTF-8 bytes through the ANSI code page (the classic `Ã©` mojibake). The source
 * tree must be valid UTF-8 with no replacement or double-encoded sequences,
 * because the UI is Portuguese and corrupted accents ship as visible garbage.
 *
 *   node --experimental-transform-types scripts/check-encoding.ts
 */

import { readdirSync, readFileSync, statSync, writeSync } from 'node:fs'
import { extname, join, relative } from 'node:path'

const ROOT = process.cwd()
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.wrangler', '.wrangler-smoke', '.data', '.npm-cache'])
const EXTENSIONS = new Set(['.ts', '.tsx', '.css', '.md', '.json', '.html', '.toml'])
const SELF = 'scripts/check-encoding.ts'

interface Problem {
  file: string
  line: number
  kind: string
  sample: string
}

const problems: Problem[] = []
let scanned = 0

/**
 * Sequences produced when UTF-8 is decoded as a single-byte code page and
 * re-encoded.
 *
 * Two code pages matter and they map the 0x80–0x9F range differently:
 *
 *  - **Latin-1** maps every byte to the code point of equal value, so `E2 80 94`
 *    becomes `â` + `€`‑only‑if… no: Latin-1 yields control characters, which a
 *    strict detector can match with `\u0080-\u009F`.
 *  - **Windows-1252** maps 0x80–0x9F to printable punctuation: 0x93/0x94 become
 *    `“`/`”` (U+201C/U+201D), 0x96 becomes `–` (U+2013).
 *
 * The previous pattern only covered `\u0080-\u00BF` (Latin-1) plus U+2122/U+0153,
 * which missed the CP1252 typographic quotes and dashes. That is exactly how a
 * `—` corrupted by PowerShell's `Set-Content` survived `check:encoding` while
 * being visibly mangled — see docs/audit-v0.2.4.md §8.
 *
 * Built from code points rather than written literally so this file does not
 * flag itself.
 */
const MOJIBAKE = new RegExp(
  [
    // A-accented lead byte (C3) followed by a Latin-1 continuation rendered as a
    // printable character: "Ã©", "Ã£", "Ã§", …
    '\\u00C3[\\u0080-\\u00BF]',
    // E2 80 xx decoded as Latin-1 (controls) or Windows-1252 (typographic
    // punctuation: “ ” ‘ ’ – — … † ‡ • ‰).
    '\\u00E2\\u20AC[\\u0080-\\u00BF\\u0152\\u0153\\u0160\\u0161\\u0178\\u017D\\u017E\\u0192\\u02C6\\u02DC\\u2013\\u2014\\u2018\\u2019\\u201A\\u201C\\u201D\\u201E\\u2020\\u2021\\u2022\\u2026\\u2030\\u2039\\u203A\\u2122]',
  ].join('|'),
)

function walk(directory: string): void {
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(directory, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) {
      walk(full)
      continue
    }
    if (!EXTENSIONS.has(extname(entry))) continue

    const relativePath = relative(ROOT, full).replace(/\\/g, '/')
    if (relativePath === SELF) continue

    scanned += 1
    const bytes = readFileSync(full)
    const text = bytes.toString('utf8')

    // A replacement character means the bytes were not valid UTF-8.
    if (text.includes('\uFFFD')) {
      const index = text.indexOf('\uFFFD')
      problems.push({
        file: relativePath,
        line: text.slice(0, index).split('\n').length,
        kind: 'byte inválido (substituído por U+FFFD)',
        sample: text.slice(Math.max(0, index - 40), index + 40).replace(/\n/g, ' '),
      })
    }

    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!
      const match = MOJIBAKE.exec(line)
      if (match) {
        problems.push({
          file: relativePath,
          line: index + 1,
          kind: 'mojibake (UTF-8 lido como ANSI)',
          sample: line.trim().slice(0, 110),
        })
      }
    }
  }
}

walk(ROOT)

if (problems.length === 0) {
  console.log(`OK — ${scanned} arquivos verificados, nenhum problema de codificação.`)
  process.exit(0)
}

const byFile = new Map<string, Problem[]>()
for (const problem of problems) {
  const list = byFile.get(problem.file) ?? []
  list.push(problem)
  byFile.set(problem.file, list)
}

// Write the report synchronously and exit only once it has been flushed.
//
// `console.error` + `process.exit(1)` truncated the report to nothing whenever
// this script ran under a parent process (a test harness, CI) rather than a
// terminal: `process.exit()` does not wait for a piped stdout/stderr to drain.
// `fs.writeSync(2, …)` is a blocking write to fd 2, so nothing can be lost.
const report: string[] = [`${problems.length} problema(s) em ${byFile.size} arquivo(s):`, '']
for (const [file, list] of byFile) {
  report.push(`  ${file}`)
  for (const problem of list.slice(0, 6)) {
    report.push(`    linha ${problem.line}: ${problem.kind}`)
    report.push(`      ${problem.sample}`)
  }
  if (list.length > 6) report.push(`    … e mais ${list.length - 6}`)
}

writeSync(2, `${report.join('\n')}\n`)
process.exitCode = 1
