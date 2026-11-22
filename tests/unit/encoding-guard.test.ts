import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The encoding guard must catch corruption it previously missed.
 *
 * `check:encoding` reads files as UTF-8 and flags U+FFFD (invalid bytes). That
 * catches a file that is not UTF-8, but **not** a file whose UTF-8 was already
 * decoded as a single-byte code page and re-encoded — the bytes are then valid
 * ASCII, just wrong.
 *
 * The concrete case (docs/audit-v0.2.4.md §8): an em dash (E2 80 94) written
 * through PowerShell's `Set-Content -Encoding utf8` came out as the three
 * characters "a-circumflex", "euro" and "right double quote". Under Latin-1 the
 * 0x94 becomes a control character, but under Windows-1252 it becomes U+201D —
 * and the original pattern's `\u0080-\u00BF` range missed it. A mangled
 * description survived several releases while `check:encoding` reported OK.
 *
 * These tests run the real script against fixtures so the detector itself is
 * exercised, not a copy of its regex.
 */

const SCRIPT = join(process.cwd(), 'scripts/check-encoding.ts')

interface Problem {
  file: string
  line: number
  kind: string
}

/**
 * Run the real script against one fixture and return the problems it reports
 * **for that fixture**.
 *
 * The child's output is captured through temporary files, not pipes: this
 * sandbox denies a child process the ability to write into a pipe owned by the
 * parent, so `stdio: 'pipe'` yields an empty string with no error. Writing to a
 * file descriptor opened by the parent is permitted, so the report survives.
 * (The same restriction is what makes `wrangler` fail with `spawn EPERM` here.)
 */
function runCheck(fileName: string, content: string): { ok: boolean; problems: Problem[] } {
  const work = join(process.cwd(), 'tests', '.encoding-fixture')
  const outFile = join(process.cwd(), 'tests', '.encoding-fixture-out.txt')
  const errFile = join(process.cwd(), 'tests', '.encoding-fixture-err.txt')
  try {
    mkdirSync(work, { recursive: true })
    writeFileSync(join(work, fileName), content, 'utf8')

    const outFd = openSync(outFile, 'w')
    const errFd = openSync(errFile, 'w')
    let status = 0
    try {
      const result = spawnSync(
        process.execPath,
        ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', SCRIPT],
        { cwd: process.cwd(), stdio: ['ignore', outFd, errFd] },
      )
      status = result.status ?? 0
    } finally {
      closeSync(outFd)
      closeSync(errFd)
    }

    const output = `${readFileSync(outFile, 'utf8')}${readFileSync(errFile, 'utf8')}`

    // Parse only the block belonging to this fixture. The script scans the whole
    // repository, so its global exit status reflects unrelated files; asserting
    // on that would make this test depend on the rest of the tree being clean.
    //
    // Output shape (stderr):
    //   N problema(s) em M arquivo(s):
    //
    //     tests/.encoding-fixture/probe.md
    //       linha 1: mojibake (UTF-8 lido como ANSI)
    //         <sample>
    const problems: Problem[] = []
    let inFixture = false
    for (const raw of output.split('\n')) {
      const trimmed = raw.trim()
      if (trimmed === '') {
        inFixture = false
        continue
      }
      if (trimmed.startsWith('tests/') && /\.(ts|tsx|md|json|css|html|toml)$/.test(trimmed)) {
        inFixture = trimmed.endsWith(`/${fileName}`)
        continue
      }
      if (!inFixture || !trimmed.startsWith('linha ')) continue
      const [position = '', ...rest] = trimmed.split(':')
      problems.push({
        file: fileName,
        line: Number(position.replace(/\D/g, '')),
        kind: rest.join(':').trim(),
      })
    }

    // `status` is informational: a non-zero status may come from unrelated files.
    void status
    return { ok: problems.length === 0, problems }
  } finally {
    rmSync(work, { recursive: true, force: true })
    rmSync(outFile, { force: true })
    rmSync(errFile, { force: true })
  }
}

/**
 * Sequence builders.
 *
 * Written from code points rather than as literals so this file does not flag
 * *itself* — the same reason `scripts/check-encoding.ts` builds its pattern this
 * way. A literal here is genuinely corrupted text, and the guard is right to
 * report it.
 */
const cp1252EmDash = String.fromCharCode(0x00e2, 0x20ac, 0x201d)
const cp1252LeftQuote = String.fromCharCode(0x00e2, 0x20ac, 0x0153)
/** "ção" as UTF-8 read through Latin-1: Ã § Ã £ o. */
const latin1Accents = String.fromCharCode(0x00c3, 0x00a7, 0x00c3, 0x00a3, 0x006f)

describe('check:encoding catches single-byte decoding of UTF-8', () => {
  it('accepts a clean UTF-8 file', () => {
    const result = runCheck('clean.md', '# Título com acentuação correta — travessão\n')
    assert.equal(result.ok, true, 'texto UTF-8 válido não pode ser sinalizado')
  })

  it('flags the CP1252 em dash that previously escaped', () => {
    // This is the exact sequence that survived: E2 80 94 read as Windows-1252.
    const result = runCheck('cp1252.md', `descrição ${cp1252EmDash} plataforma\n`)
    assert.equal(result.ok, false, 'o travessão corrompido precisa ser detectado')
    assert.ok(
      result.problems.some((problem) => /mojibake/i.test(problem.kind)),
      `esperava mojibake, veio ${JSON.stringify(result.problems)}`,
    )
  })

  it('flags a CP1252 quotation mark', () => {
    assert.equal(runCheck('quote.md', `aspas ${cp1252LeftQuote} citadas\n`).ok, false)
  })

  it('flags a Latin-1 accented sequence', () => {
    assert.equal(runCheck('latin1.md', `${latin1Accents}\n`).ok, false)
  })
})
