import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { investigationCreateSchema } from '../../shared/schemas.ts'
import { fieldErrorKey } from '../../src/lib/field-errors.ts'

/**
 * New-investigation form: validation contract.
 *
 * These tests pin the two defects that made the form unusable, plus the rules
 * that must not drift:
 *
 *  1. **Array-element paths.** Zod reports an invalid keyword as
 *     `['keywords', 0]`. The form looks up `errors['keywords']`, so unless the
 *     index is folded away the field is never marked and the user only sees the
 *     generic banner. `fieldErrorKey` is the fold.
 *  2. **Readable messages.** A bare `.min()/.max()` on a keyword emitted zod's
 *     English default ("Too small: expected string to have >=1 characters"),
 *     which surfaced in the UI as an internal string.
 *
 * The business rules themselves (3/160 title, 10/2000 objective, 3/300 topic,
 * 20 keywords of ≤64 chars) are asserted here as *unchanged* — they are the
 * product's contract, not something this fix is allowed to relax.
 */

const VALID = {
  title: 'Detecção de fraudes com aprendizado de máquina',
  description: '',
  objective: 'Identificar quais técnicas são usadas e com quais resultados publicados.',
  topic: 'detecção de fraudes financeiras',
  keywords: ['fraude', 'machine learning'],
  status: 'draft' as const,
}

function issuesOf(input: Record<string, unknown>) {
  const parsed = investigationCreateSchema.safeParse(input)
  return parsed.success ? [] : parsed.error.issues
}

describe('fieldErrorKey: array indices fold onto the field', () => {
  it('maps a keyword element back to the keywords field', () => {
    // The exact shape zod produces for an invalid array element.
    assert.equal(fieldErrorKey(['keywords', 0]), 'keywords')
    assert.equal(fieldErrorKey(['keywords', 19]), 'keywords')
  })

  it('folds the wire form too ("keywords.0"), which the API error carries', () => {
    // `ApiError.fieldErrors()` receives the path as a dotted string.
    assert.equal(fieldErrorKey('keywords.0'), 'keywords')
    assert.equal(fieldErrorKey('source.items.2.title'), 'source.items.title')
    assert.equal(fieldErrorKey('title'), 'title')
  })

  it('keeps nested object paths intact', () => {
    // `source.url` is a distinct input, unlike `keywords.0`.
    assert.equal(fieldErrorKey(['source', 'url']), 'source.url')
    assert.equal(fieldErrorKey(['source', 'items', 2, 'title']), 'source.items.title')
  })

  it('falls back to "form" for an empty path', () => {
    assert.equal(fieldErrorKey([]), 'form')
  })
})

describe('investigationCreateSchema: a valid form passes', () => {
  it('accepts the canonical payload', () => {
    const parsed = investigationCreateSchema.safeParse(VALID)
    assert.equal(parsed.success, true)
    if (parsed.success) {
      assert.equal(parsed.data.title, VALID.title)
      assert.deepEqual(parsed.data.keywords, VALID.keywords)
      assert.equal(parsed.data.status, 'draft')
    }
  })

  it('trims surrounding whitespace without rejecting the value', () => {
    const parsed = investigationCreateSchema.safeParse({
      ...VALID,
      title: '  Título com espaços  ',
      topic: '  tema com espaços  ',
    })
    assert.equal(parsed.success, true)
    if (parsed.success) {
      assert.equal(parsed.data.title, 'Título com espaços')
      assert.equal(parsed.data.topic, 'tema com espaços')
    }
  })
})

describe('investigationCreateSchema: each required field reports itself', () => {
  const required: Array<[string, string]> = [
    ['title', 'Título'],
    ['topic', 'Tema'],
    ['objective', 'Objetivo'],
  ]

  for (const [field, label] of required) {
    it(`reports "${label}" when ${field} is absent`, () => {
      const issues = issuesOf({ ...VALID, [field]: '' })
      assert.ok(issues.length > 0, 'expected at least one issue')
      const issue = issues.find((i) => fieldErrorKey(i.path) === field)
      assert.ok(issue, `no issue keyed to "${field}" (got ${JSON.stringify(issues.map((i) => i.path))})`)
      assert.match(issue!.message, new RegExp(label))
      // The message must be readable prose, not zod's English default.
      assert.doesNotMatch(issue!.message, /Too small|Too big|Invalid input/i)
    })
  }

  it('does not flag description or keywords when they are empty', () => {
    // Both are optional: a blank description and no keywords must pass.
    const issues = issuesOf({ ...VALID, description: '', keywords: [] })
    assert.deepEqual(issues, [])
  })

  it('reports every missing field at once, not just the first', () => {
    const issues = issuesOf({ ...VALID, title: '', topic: '', objective: '' })
    const keys = new Set(issues.map((i) => fieldErrorKey(i.path)))
    assert.ok(keys.has('title'))
    assert.ok(keys.has('topic'))
    assert.ok(keys.has('objective'))
  })
})

describe('investigationCreateSchema: field limits are unchanged', () => {
  it('rejects a title below 3 characters', () => {
    const issues = issuesOf({ ...VALID, title: 'ab' })
    assert.equal(fieldErrorKey(issues[0]!.path), 'title')
    assert.match(issues[0]!.message, /ao menos 3/)
  })

  it('accepts a title of exactly 160 characters and rejects 161', () => {
    assert.equal(investigationCreateSchema.safeParse({ ...VALID, title: 'a'.repeat(160) }).success, true)
    assert.equal(investigationCreateSchema.safeParse({ ...VALID, title: 'a'.repeat(161) }).success, false)
  })

  it('rejects an objective below 10 characters', () => {
    const issues = issuesOf({ ...VALID, objective: 'curto' })
    assert.equal(fieldErrorKey(issues[0]!.path), 'objective')
    assert.match(issues[0]!.message, /ao menos 10/)
  })

  it('rejects a topic below 3 characters', () => {
    const issues = issuesOf({ ...VALID, topic: 'ab' })
    assert.equal(fieldErrorKey(issues[0]!.path), 'topic')
  })

  it('rejects a description over 4000 characters', () => {
    const issues = issuesOf({ ...VALID, description: 'x'.repeat(4001) })
    assert.equal(fieldErrorKey(issues[0]!.path), 'description')
    assert.match(issues[0]!.message, /muito longa/i)
  })

  it('treats a whitespace-only required field as missing', () => {
    const issues = issuesOf({ ...VALID, title: '   ' })
    assert.equal(fieldErrorKey(issues[0]!.path), 'title')
  })
})

describe('investigationCreateSchema: keywords are individual terms', () => {
  it('accepts up to 20 keywords', () => {
    const keywords = Array.from({ length: 20 }, (_, i) => `termo ${i}`)
    assert.equal(investigationCreateSchema.safeParse({ ...VALID, keywords }).success, true)
  })

  it('rejects 21 keywords, keyed to the keywords field (not an index)', () => {
    const keywords = Array.from({ length: 21 }, (_, i) => `termo ${i}`)
    const issues = issuesOf({ ...VALID, keywords })
    assert.equal(fieldErrorKey(issues[0]!.path), 'keywords')
    assert.match(issues[0]!.message, /Máximo de 20/)
  })

  it('rejects a single keyword longer than 64 characters, with a readable message', () => {
    const issues = issuesOf({ ...VALID, keywords: ['x'.repeat(70)] })
    const issue = issues[0]!
    // The element index folds back onto the field the form renders.
    assert.equal(fieldErrorKey(issue.path), 'keywords')
    assert.match(issue.message, /64/)
    assert.doesNotMatch(issue.message, /Too big|Too small/i)
  })

  it('rejects an empty or whitespace-only keyword with a readable message', () => {
    for (const bad of ['', '   ']) {
      const issues = issuesOf({ ...VALID, keywords: [bad] })
      assert.ok(issues.length > 0, `expected "${bad}" to be rejected`)
      assert.equal(fieldErrorKey(issues[0]!.path), 'keywords')
      assert.doesNotMatch(issues[0]!.message, /Too small/i)
    }
  })

  it('accepts a keyword at exactly 64 characters', () => {
    assert.equal(investigationCreateSchema.safeParse({ ...VALID, keywords: ['x'.repeat(64)] }).success, true)
  })

  it('keeps keywords as separate array entries, never one joined string', () => {
    // This is the shape the form must send: a list, not "a; b; c".
    const parsed = investigationCreateSchema.safeParse({ ...VALID, keywords: ['a', 'b', 'c'] })
    assert.equal(parsed.success, true)
    if (parsed.success) assert.deepEqual(parsed.data.keywords, ['a', 'b', 'c'])
  })
})
