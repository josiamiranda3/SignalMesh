import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import en from '../../src/i18n/en.json' with { type: 'json' }
import ptBR from '../../src/i18n/pt-BR.json' with { type: 'json' }
import { LOCALES, DEFAULT_LOCALE, LOCALE_LABELS, isLocale, intlLocale } from '../../src/i18n/locales.ts'

/**
 * i18n catalog integrity.
 *
 * The type system already refuses an unknown key at a call site, but it cannot
 * prove that the two catalogs describe the *same* keys: `pt-BR.json` is cast to
 * the English shape, so a missing Portuguese entry would silently fall back at
 * runtime. These tests close that gap, and they are what makes "no missing
 * translation keys" a checked property rather than a hope.
 */

/**
 * Detect duplicate object keys in raw JSON.
 *
 * `JSON.parse` silently keeps the last value, so a duplicated key never fails a
 * type check or a parity comparison — it just shadows the earlier entry. During
 * the final audit `common.back` was in fact declared twice in both catalogs, and
 * only a raw-text scan found it.
 */
function duplicateKeys(raw: string): string[] {
  const duplicates: string[] = []
  const stack: Array<{ keys: Set<string>; path: string }> = [{ keys: new Set(), path: '' }]
  const re = /"((?:[^"\\]|\\.)*)"\s*:|([{}])/g
  let match: RegExpExecArray | null
  let lastKey: string | null = null

  while ((match = re.exec(raw)) !== null) {
    if (match[2] === '{') {
      const parent = stack[stack.length - 1]!
      stack.push({ keys: new Set(), path: lastKey ? `${parent.path}${lastKey}.` : parent.path })
      lastKey = null
    } else if (match[2] === '}') {
      if (stack.length > 1) stack.pop()
      lastKey = null
    } else if (match[1] !== undefined) {
      const scope = stack[stack.length - 1]!
      if (scope.keys.has(match[1])) duplicates.push(`${scope.path}${match[1]}`)
      scope.keys.add(match[1])
      lastKey = match[1]
    }
  }
  return duplicates
}

/** Flatten a nested catalog into dotted keys. */
function flatten(value: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  if (typeof value !== 'object' || value === null) return out
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof child === 'string') out.set(path, child)
    else for (const [k, v] of flatten(child, path)) out.set(k, v)
  }
  return out
}

const enKeys = flatten(en)
const ptKeys = flatten(ptBR)

describe('locale definitions', () => {
  it('offers exactly English and Brazilian Portuguese, with English as default', () => {
    assert.deepEqual([...LOCALES], ['en', 'pt-BR'])
    assert.equal(DEFAULT_LOCALE, 'en')
  })

  it('labels each locale in its own language', () => {
    assert.equal(LOCALE_LABELS.en, 'English')
    assert.equal(LOCALE_LABELS['pt-BR'], 'Português (Brasil)')
  })

  it('recognises only supported locale ids', () => {
    assert.equal(isLocale('en'), true)
    assert.equal(isLocale('pt-BR'), true)
    assert.equal(isLocale('pt'), false)
    assert.equal(isLocale('fr'), false)
    assert.equal(isLocale(null), false)
    assert.equal(isLocale(undefined), false)
  })

  it('maps a locale to its Intl tag', () => {
    assert.equal(intlLocale('pt-BR'), 'pt-BR')
    assert.equal(intlLocale('en'), 'en')
  })
})

describe('catalog parity', () => {
  it('declares no duplicate keys in either catalog', () => {
    const root = process.cwd()
    for (const file of ['src/i18n/en.json', 'src/i18n/pt-BR.json']) {
      const raw = readFileSync(join(root, file), 'utf8')
      assert.deepEqual(duplicateKeys(raw), [], `${file} has duplicate keys`)
    }
  })

  it('has the same keys in both languages', () => {
    const missingInPt = [...enKeys.keys()].filter((key) => !ptKeys.has(key))
    const extraInPt = [...ptKeys.keys()].filter((key) => !enKeys.has(key))

    assert.deepEqual(missingInPt, [], `keys missing from pt-BR.json: ${missingInPt.join(', ')}`)
    assert.deepEqual(extraInPt, [], `keys present only in pt-BR.json: ${extraInPt.join(', ')}`)
  })

  it('has no empty translation values', () => {
    for (const [key, value] of enKeys) {
      assert.ok(value.trim().length > 0, `en.${key} is empty`)
    }
    for (const [key, value] of ptKeys) {
      assert.ok(value.trim().length > 0, `pt-BR.${key} is empty`)
    }
  })

  it('keeps the same interpolation placeholders in both languages', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

    for (const [key, englishText] of enKeys) {
      const portugueseText = ptKeys.get(key)
      assert.ok(portugueseText !== undefined, `pt-BR missing ${key}`)
      assert.deepEqual(
        placeholders(portugueseText!),
        placeholders(englishText),
        `placeholder mismatch for "${key}"`,
      )
    }
  })

  it('actually translates the interface (English and Portuguese differ)', () => {
    // A copy-paste that left Portuguese text under an English key would pass
    // parity but fail the product goal. Spot-check the strings a user sees first.
    const mustDiffer = ['nav.dashboard', 'nav.investigations', 'status.active', 'common.signOut']
    for (const key of mustDiffer) {
      assert.notEqual(enKeys.get(key), ptKeys.get(key), `${key} is identical in both catalogs`)
    }
  })

  it('leaves no Portuguese copy in the English catalog for common UI words', () => {
    // Guard against a partially translated file: none of these Portuguese words
    // should appear in the English catalog.
    const portugueseMarkers = [
      'Visão geral',
      'Investigações',
      'Configurações',
      'Histórico',
      'Nova investigação',
      'Salvar',
      'Cancelar',
      'Em andamento',
      'Concluída',
    ]
    for (const [key, value] of enKeys) {
      for (const marker of portugueseMarkers) {
        assert.ok(
          !value.includes(marker),
          `en.${key} still contains Portuguese: "${value}"`,
        )
      }
    }
  })
})
