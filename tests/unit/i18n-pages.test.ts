import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * No hardcoded Portuguese left in the migrated pages.
 *
 * The catalog test proves the two dictionaries agree; this one proves the pages
 * actually *use* them. A page that kept a literal `title="Investigações"` would
 * pass every catalog check and still show Portuguese to an English user, which
 * is exactly the failure mode this phase is meant to eliminate.
 *
 * Scope is deliberately limited to the three pages migrated in this phase.
 */

const ROOT = process.cwd()

const PAGES = [
  'src/pages/DashboardPage.tsx',
  'src/pages/InvestigationsPage.tsx',
  'src/pages/InvestigationDetailPage.tsx',
  // Phase 2
  'src/pages/ResearchPage.tsx',
  'src/pages/EvidencePage.tsx',
  'src/pages/AnalysisPage.tsx',
  'src/pages/ValidationPage.tsx',
  // Phase 3
  'src/pages/LandingPage.tsx',
  'src/pages/NewInvestigationPage.tsx',
  'src/pages/HistoryPage.tsx',
  'src/pages/LoginPage.tsx',
  'src/pages/NotFoundPage.tsx',
  // Added during the final audit: never covered by a phase scope.
  'src/pages/SettingsPage.tsx',
  // Shared components these pages render
  'src/components/charts/Charts.tsx',
  'src/components/ui/KeywordEditor.tsx',
  'src/components/ui/Modal.tsx',
  'src/components/ui/Notice.tsx',
  'src/components/layout/Page.tsx',
]

/** Portuguese-only characters. Present in no English word. */
const ACCENT = /[áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ]/

/**
 * Portuguese UI words that carry no accent, so the accent scan misses them.
 * This list exists because "Pesquisar mais" slipped through the browser audit
 * in phase 2: a word can be Portuguese without any diacritic.
 */
const UNACCENTED_PT = [
  'Pesquisar',
  'Pesquisas',
  'Evidências',
  'Adicionar',
  'Remover',
  'Salvar',
  'Excluir',
  'Nenhum',
  'Nenhuma',
  'Buscar',
  'Voltar',
  'Cancelar',
  'Prioridade',
  'Justificativa',
  'Solicitar',
  // Decision verbs. `Aprovar` and `Rejeitar` are accent-free, which is exactly
  // how they survived every earlier scan and shipped as Portuguese labels in
  // the English interface.
  'Aprovar',
  'Rejeitar',
  'Revisar',
  'Revisão',
  'Aprovada',
  'Rejeitada',
  'Aprovadas',
  'Rejeitadas',
  'Pendente',
  'Pendentes',
]

/** Reads a file with its line endings normalised. */
function read(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n')
}

/** Strip block and line comments so prose in doc comments is not flagged. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

describe('migrated pages: no hardcoded Portuguese', () => {
  for (const page of PAGES) {
    it(`${page} has no accented Portuguese literal`, () => {
      const source = stripComments(read(page))
      const offenders: string[] = []

      // Any accented character inside a quoted string or JSX text is a leftover.
      for (const line of source.split('\n')) {
        if (!ACCENT.test(line)) continue
        // Allow the catalog keys themselves (they are ASCII) and imports.
        offenders.push(line.trim().slice(0, 100))
      }

      assert.deepEqual(offenders, [], `Portuguese text left in ${page}:\n${offenders.join('\n')}`)
    })

    it(`${page} imports the translation hook`, () => {
      const source = read(page)
      // Some files also import `TranslationKey`, so match the module rather
      // than an exact specifier list.
      assert.match(
        source,
        /import \{[^}]*useI18n[^}]*\} from '@\/i18n\/I18nProvider'/,
        `${page} does not import useI18n`,
      )
      assert.match(source, /\bt\(/, `${page} never calls t()`)
    })

    it(`${page} has no unaccented Portuguese UI word in JSX text`, () => {
      const source = stripComments(read(page))
      const offenders: string[] = []

      // Only inspect JSX text nodes and plain string literals; translation keys
      // are dotted lowercase and never match these capitalised words.
      for (const line of source.split('\n')) {
        const trimmed = line.trim()
        // Skip lines that are pure key lookups or imports.
        if (/^import\b/.test(trimmed)) continue
        if (/t\('|t\(`/.test(trimmed)) continue
        for (const word of UNACCENTED_PT) {
          if (new RegExp(`(^|[>\\s'"\`])${word}([<\\s'"\`.,:!?]|$)`).test(trimmed)) {
            offenders.push(`${word}: ${trimmed.slice(0, 80)}`)
          }
        }
      }

      assert.deepEqual(offenders, [], `unaccented Portuguese UI text in ${page}:\n${offenders.join('\n')}`)
    })

    it(`${page} does not fall back to literal strings`, () => {
      // `t('key') || 'Texto'` is forbidden: a missing key must be visible.
      const source = read(page)
      assert.doesNotMatch(source, /t\('[^']+'\)\s*\|\|/, `${page} has a literal fallback after t()`)
      assert.doesNotMatch(source, /t\([^)]*\)\s*\?\?\s*'[A-Z]/, `${page} has a literal fallback after t()`)
    })

    it(`${page} does not render the same key twice in a row`, () => {
      // The validation page shipped a box where each description appeared
      // twice, because a multi-line replacement left the key on two adjacent
      // lines. It type-checked and every key resolved, so nothing else caught
      // it — only the rendered page showed the repetition.
      const source = stripComments(read(page))
      const lines = source.split('\n').map((l) => l.trim())
      const doubled: string[] = []

      for (let i = 0; i < lines.length - 1; i += 1) {
        const current = lines[i]!
        const next = lines[i + 1]!
        if (!current || current !== next) continue
        // Only flag exact duplicate key lookups, not arbitrary repeated text.
        if (/^\{?t\('[\w.]+'[^)]*\)\}?$/.test(current)) doubled.push(current)
      }

      assert.deepEqual(doubled, [], `${page} renders the same key twice in a row:\n${doubled.join('\n')}`)
    })
  }
})

describe('migrated pages: keys resolve in both catalogs', () => {
  it('every t() key used exists in en and pt-BR', async () => {
    const en = (await import('../../src/i18n/en.json', { with: { type: 'json' } })).default as Record<string, unknown>
    const pt = (await import('../../src/i18n/pt-BR.json', { with: { type: 'json' } })).default as Record<string, unknown>

    const resolve = (tree: Record<string, unknown>, key: string): unknown => {
      let node: unknown = tree
      for (const segment of key.split('.')) {
        if (typeof node !== 'object' || node === null) return undefined
        node = (node as Record<string, unknown>)[segment]
      }
      return node
    }

    const missing: string[] = []
    for (const page of PAGES) {
      const source = stripComments(read(page))
      // Static keys only; dynamically built keys are checked by the catalogue
      // parity test instead.
      for (const match of source.matchAll(/\bt\('([a-zA-Z][\w.]*)'/g)) {
        const key = match[1]!
        if (typeof resolve(en, key) !== 'string') missing.push(`en:${key}`)
        if (typeof resolve(pt, key) !== 'string') missing.push(`pt-BR:${key}`)
      }
    }

    assert.deepEqual([...new Set(missing)], [], `keys missing from a catalog: ${[...new Set(missing)].join(', ')}`)
  })

  it('covers every migrated namespace', async () => {
    const en = (await import('../../src/i18n/en.json', { with: { type: 'json' } })).default as Record<string, unknown>
    for (const namespace of [
      'dashboard', 'investigations', 'detail', 'research', 'evidence',
      'analysis', 'validationPage', 'landing', 'newInvestigation',
      'history', 'login', 'notFound', 'settings',
    ]) {
      assert.ok(namespace in en, `missing namespace "${namespace}"`)
    }
  })
})
