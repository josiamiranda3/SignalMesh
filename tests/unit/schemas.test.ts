import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  analysisRequestSchema,
  evidenceCreateSchema,
  exportQuerySchema,
  investigationCreateSchema,
  investigationUpdateSchema,
  listQuerySchema,
  researchRequestSchema,
  validationSchema,
} from '../../shared/schemas.ts'

/**
 * Request schemas.
 *
 * Two properties matter beyond "accepts good input": a partial update must not
 * inject defaults (that would blank fields the user never touched), and every
 * bound must be enforced rather than silently clamped.
 */

describe('investigationUpdateSchema', () => {
  it('keeps a partial payload partial (no default injection)', () => {
    const parsed = investigationUpdateSchema.safeParse({ title: 'Somente o título muda' })
    assert.ok(parsed.success)
    assert.deepEqual(Object.keys(parsed.data), ['title'])
    assert.equal((parsed.data as { keywords?: unknown }).keywords, undefined)
  })

  it('accepts a single-field update for each field', () => {
    for (const patch of [
      { title: 'Título novo' },
      { description: '' },
      { objective: 'Objetivo suficientemente longo' },
      { topic: 'Tema' },
      { keywords: ['a', 'b'] },
      { status: 'completed' as const },
    ]) {
      assert.ok(investigationUpdateSchema.safeParse(patch).success, `deveria aceitar ${JSON.stringify(patch)}`)
    }
  })

  it('rejects an empty update', () => {
    assert.equal(investigationUpdateSchema.safeParse({}).success, false)
  })

  it('rejects an unknown status', () => {
    assert.equal(investigationUpdateSchema.safeParse({ status: 'published' }).success, false)
  })

  it('trims whitespace', () => {
    const parsed = investigationUpdateSchema.safeParse({ title: '  Título com espaços  ' })
    assert.ok(parsed.success)
    assert.equal((parsed.data as { title: string }).title, 'Título com espaços')
  })
})

describe('investigationCreateSchema', () => {
  it('applies documented defaults', () => {
    const parsed = investigationCreateSchema.safeParse({
      title: 'Investigação',
      objective: 'Objetivo suficientemente longo para passar',
      topic: 'Tema',
    })
    assert.ok(parsed.success)
    assert.equal(parsed.data.description, '')
    assert.equal(parsed.data.status, 'draft')
    assert.deepEqual(parsed.data.keywords, [])
  })

  it('requires a minimum objective length', () => {
    const parsed = investigationCreateSchema.safeParse({ title: 'Investigação', objective: 'curto', topic: 'Tema' })
    assert.equal(parsed.success, false)
  })

  it('enforces the title maximum', () => {
    const parsed = investigationCreateSchema.safeParse({
      title: 'x'.repeat(161),
      objective: 'Objetivo suficientemente longo para passar',
      topic: 'Tema',
    })
    assert.equal(parsed.success, false)
  })
})

describe('evidenceCreateSchema', () => {
  const validSource = {
    title: 'Fonte',
    url: 'https://example.org/a',
    domain: 'example.org',
    snippet: 'trecho',
    retrievedContent: null,
    publishedAt: null,
    author: null,
    providerRequestId: null,
    contentAvailability: ['snippet'],
  }

  it('accepts a valid source', () => {
    assert.ok(evidenceCreateSchema.safeParse({ source: validSource }).success)
  })

  it('rejects non-http URLs', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'nao-e-url']) {
      const parsed = evidenceCreateSchema.safeParse({ source: { ...validSource, url } })
      assert.equal(parsed.success, false, `deveria rejeitar ${url}`)
    }
  })

  it('requires a datetime with offset for publishedAt', () => {
    const parsed = evidenceCreateSchema.safeParse({ source: { ...validSource, publishedAt: '2024-01-01' } })
    assert.equal(parsed.success, false)
  })

  it('defaults allowDuplicate to false', () => {
    const parsed = evidenceCreateSchema.safeParse({ source: validSource })
    assert.ok(parsed.success)
    assert.equal(parsed.data.allowDuplicate, false)
  })
})

describe('researchRequestSchema', () => {
  it('applies safe defaults', () => {
    const parsed = researchRequestSchema.safeParse({})
    assert.ok(parsed.success)
    assert.equal(parsed.data.numResults, 8)
    assert.equal(parsed.data.includeContent, true)
    assert.equal(parsed.data.repeat, false)
  })

  it('caps the number of results', () => {
    assert.equal(researchRequestSchema.safeParse({ numResults: 50 }).success, false)
    assert.equal(researchRequestSchema.safeParse({ numResults: 0 }).success, false)
  })
})

describe('validationSchema', () => {
  it('accepts each documented status', () => {
    for (const status of ['pending', 'accepted', 'rejected', 'needs_review'] as const) {
      assert.ok(validationSchema.safeParse({ status }).success)
    }
  })

  it('rejects an unknown status', () => {
    assert.equal(validationSchema.safeParse({ status: 'approved' }).success, false)
  })
})

describe('listQuerySchema', () => {
  it('coerces pagination from query strings', () => {
    const parsed = listQuerySchema.safeParse({ limit: '25', offset: '5' })
    assert.ok(parsed.success)
    assert.equal(parsed.data.limit, 25)
    assert.equal(parsed.data.offset, 5)
  })

  it('rejects out-of-range pagination', () => {
    assert.equal(listQuerySchema.safeParse({ limit: '500' }).success, false)
    assert.equal(listQuerySchema.safeParse({ offset: '-1' }).success, false)
  })
})

describe('analysisRequestSchema', () => {
  it('accepts an empty body (analyse everything)', () => {
    const parsed = analysisRequestSchema.safeParse({})
    assert.ok(parsed.success)
    assert.equal(parsed.data.repeat, false)
  })

  it('limits the evidence subset size', () => {
    const parsed = analysisRequestSchema.safeParse({
      evidenceIds: Array.from({ length: 61 }, (_, index) => `evi_${index}`),
    })
    assert.equal(parsed.success, false)
  })
})

describe('exportQuerySchema', () => {
  it('defaults to a full JSON export', () => {
    const parsed = exportQuerySchema.safeParse({})
    assert.ok(parsed.success)
    assert.equal(parsed.data.format, 'json')
    assert.equal(parsed.data.scope, 'investigation')
  })

  it('rejects an unsupported format', () => {
    assert.equal(exportQuerySchema.safeParse({ format: 'xlsx' }).success, false)
  })
})
