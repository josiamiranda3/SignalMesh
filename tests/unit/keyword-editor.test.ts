import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  splitKeywords,
  dedupeKeywords,
  mergeKeywords,
  renameKeyword,
  MAX_KEYWORDS,
  MAX_KEYWORD_LENGTH,
} from '../../src/lib/keywords.ts'
import { investigationUpdateSchema } from '../../shared/schemas.ts'

/**
 * Keyword editing: normalisation and limits.
 *
 * The creation form and the edit modal now share one editor, so these rules are
 * exercised once, at their single source. The point of the suite is that the
 * modal cannot accept something the creation form rejects — two copies of the
 * normalisation would eventually disagree, and the disagreement would look like
 * "the list was saved joined together".
 */

describe('splitKeywords: one entry becomes individual terms', () => {
  it('splits a semicolon-separated list', () => {
    assert.deepEqual(splitKeywords('fraude; machine learning; antifraude'), [
      'fraude',
      'machine learning',
      'antifraude',
    ])
  })

  it('splits commas, newlines and tabs', () => {
    assert.deepEqual(splitKeywords('a,b'), ['a', 'b'])
    assert.deepEqual(splitKeywords('a\nb'), ['a', 'b'])
    assert.deepEqual(splitKeywords('a\tb'), ['a', 'b'])
  })

  it('trims each term', () => {
    assert.deepEqual(splitKeywords('  a  ;  b  '), ['a', 'b'])
  })

  it('returns a single term unchanged', () => {
    assert.deepEqual(splitKeywords('fraude'), ['fraude'])
  })

  it('drops empty segments', () => {
    assert.deepEqual(splitKeywords(';;  ;'), [])
    assert.deepEqual(splitKeywords(''), [])
    assert.deepEqual(splitKeywords('   '), [])
    assert.deepEqual(splitKeywords('a;;b'), ['a', 'b'])
  })

  it('keeps a multi-word term intact (a space is not a separator)', () => {
    // "machine learning" is one keyword, not two.
    assert.deepEqual(splitKeywords('machine learning'), ['machine learning'])
  })
})

describe('dedupeKeywords: case-insensitive, order preserved', () => {
  it('removes duplicates regardless of case, keeping the first spelling', () => {
    assert.deepEqual(dedupeKeywords(['Fraude', 'fraude', 'FRAUDE']), ['Fraude'])
  })

  it('preserves the original order', () => {
    assert.deepEqual(dedupeKeywords(['b', 'a', 'c']), ['b', 'a', 'c'])
  })

  it('returns an empty list unchanged', () => {
    assert.deepEqual(dedupeKeywords([]), [])
  })
})

describe('mergeKeywords: adding to an existing list', () => {
  it('appends new terms', () => {
    const { next, problem } = mergeKeywords(['a'], 'b')
    assert.deepEqual(next, ['a', 'b'])
    assert.equal(problem, null)
  })

  it('splits a pasted list and appends each term', () => {
    const { next } = mergeKeywords([], 'um; dois, três')
    assert.deepEqual(next, ['um', 'dois', 'três'])
  })

  it('ignores a duplicate that differs only by case', () => {
    const { next, problem } = mergeKeywords(['Fraude'], 'fraude')
    assert.deepEqual(next, ['Fraude'])
    assert.equal(problem, null)
  })

  it('stops at 20 and reports the limit', () => {
    const existing = Array.from({ length: 19 }, (_, i) => `t${i}`)
    const { next, problem } = mergeKeywords(existing, 'novo; extra')
    assert.equal(next.length, 20)
    assert.match(String(problem), /Máximo de 20/)
  })

  it('refuses a term over 64 characters and says how long it is', () => {
    const { next, problem } = mergeKeywords([], 'x'.repeat(70))
    assert.deepEqual(next, [])
    assert.match(String(problem), /70 caracteres/)
    assert.match(String(problem), /64/)
  })

  it('keeps the accepted terms when one in a pasted list is too long', () => {
    const { next, problem } = mergeKeywords([], `bom; ${'x'.repeat(70)}; outro`)
    assert.deepEqual(next, ['bom', 'outro'])
    assert.ok(problem)
  })

  it('does nothing for a blank entry', () => {
    const { next, problem } = mergeKeywords(['a'], '   ')
    assert.deepEqual(next, ['a'])
    assert.equal(problem, null)
  })
})

describe('renameKeyword: editing in place', () => {
  it('renames the term at the given index', () => {
    assert.deepEqual(renameKeyword(['a', 'b', 'c'], 1, 'novo b'), ['a', 'novo b', 'c'])
  })

  it('trims the new value', () => {
    assert.deepEqual(renameKeyword(['a'], 0, '  espaçado  '), ['espaçado'])
  })

  it('refuses a rename that duplicates another term', () => {
    assert.equal(renameKeyword(['a', 'b'], 1, 'a'), null)
  })

  it('refuses a rename over the length limit', () => {
    assert.equal(renameKeyword(['a'], 0, 'x'.repeat(65)), null)
  })

  it('allows renaming a term to its own value', () => {
    assert.deepEqual(renameKeyword(['a'], 0, 'a'), ['a'])
  })
})

describe('limits match the schema', () => {
  it('exposes the same 20-term limit the schema enforces', () => {
    assert.equal(MAX_KEYWORDS, 20)
    const atLimit = Array.from({ length: 20 }, (_, i) => `t${i}`)
    assert.equal(investigationUpdateSchema.safeParse({ keywords: atLimit }).success, true)
    assert.equal(
      investigationUpdateSchema.safeParse({ keywords: [...atLimit, 'extra'] }).success,
      false,
    )
  })

  it('exposes the same 64-character limit the schema enforces', () => {
    assert.equal(MAX_KEYWORD_LENGTH, 64)
    assert.equal(investigationUpdateSchema.safeParse({ keywords: ['x'.repeat(64)] }).success, true)
    assert.equal(investigationUpdateSchema.safeParse({ keywords: ['x'.repeat(65)] }).success, false)
  })
})

describe('the update contract accepts keywords', () => {
  it('accepts a keyword-only patch', () => {
    // This is what lets the modal save without resending every field.
    const parsed = investigationUpdateSchema.safeParse({ keywords: ['a', 'b'] })
    assert.equal(parsed.success, true)
    if (parsed.success) assert.deepEqual(parsed.data, { keywords: ['a', 'b'] })
  })

  it('accepts the full metadata payload the modal submits', () => {
    const parsed = investigationUpdateSchema.safeParse({
      title: 'Título atualizado',
      topic: 'tema atualizado',
      objective: 'Objetivo atualizado com detalhe suficiente.',
      description: 'Descrição atualizada.',
      keywords: ['um', 'dois'],
    })
    assert.equal(parsed.success, true)
  })

  it('rejects an empty patch', () => {
    const parsed = investigationUpdateSchema.safeParse({})
    assert.equal(parsed.success, false)
  })

  it('rejects a keyword list above the limit', () => {
    const parsed = investigationUpdateSchema.safeParse({
      keywords: Array.from({ length: 21 }, (_, i) => `t${i}`),
    })
    assert.equal(parsed.success, false)
  })
})
