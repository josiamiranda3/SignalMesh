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

import { readdirSync, readFileSync, statSync } from 'node:fs'
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
 * Sequences produced when UTF-8 is decoded as Latin-1 and re-encoded.
 *
 * Built from code points rather than written literally so this file does not
 * flag itself.
 */
const MOJIBAKE = new RegExp(
  [
    // A-accented lead byte (C3) followed by a Latin-1 continuation rendered as a
    // printable character: "Ã©", "Ã£", "Ã§", …
    '\\u00C3[\\u0080-\\u00BF]',
    // E2 80 xx (dashes, quotes, ellipsis) decoded as Latin-1: "â€“", "â€™"
    '\\u00E2\\u20AC[\\u0080-\\u00BF\\u2122\\u0153]',
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

console.error(`${problems.length} problema(s) em ${byFile.size} arquivo(s):\n`)
for (const [file, list] of byFile) {
  console.error(`  ${file}`)
  for (const problem of list.slice(0, 6)) {
    console.error(`    linha ${problem.line}: ${problem.kind}`)
    console.error(`      ${problem.sample}`)
  }
  if (list.length > 6) console.error(`    … e mais ${list.length - 6}`)
}

process.exit(1)
