import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_WEIGHTS, scoreRelevance, tokenize } from '../../shared/relevance.ts'

/**
 * Relevance scoring.
 *
 * The properties tested here are the ones the product promises: the index is
 * bounded, explainable, weight-sensitive, and — critically — reports missing
 * data instead of silently scoring an undated source as if it were fresh.
 */

const investigation = {
  topic: 'inteligência artificial para detecção de fraudes financeiras no Brasil',
  objective: 'identificar instituições que usam aprendizado de máquina contra fraude e resultados publicados',
  keywords: ['fraude financeira', 'machine learning', 'antifraude'],
}

describe('tokenize', () => {
  it('removes diacritics, stop words and short tokens', () => {
    const tokens = tokenize('A Inteligência artificial é usada na detecção de fraudes')
    assert.ok(tokens.includes('inteligencia'))
    assert.ok(tokens.includes('deteccao'))
    assert.ok(!tokens.includes('de'))
    assert.ok(!tokens.includes('a'))
  })

  it('handles English stop words too', () => {
    const tokens = tokenize('The detection of fraud and the technology')
    assert.ok(!tokens.includes('the'))
    assert.ok(!tokens.includes('and'))
    assert.ok(tokens.includes('detection'))
  })
})

describe('scoreRelevance', () => {
  it('returns a bounded index in [0,1]', () => {
    const breakdown = scoreRelevance(
      {
        title: 'Detecção de fraudes financeiras com machine learning no Brasil',
        snippet: 'Estudo sobre antifraude e fraude financeira com machine learning.',
        content: 'Conteúdo detalhado sobre fraude financeira e aprendizado de máquina aplicado a bancos.',
        domain: 'bcb.gov.br',
        publishedAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
      },
      { investigation },
    )
    for (const component of [breakdown.topical, breakdown.recency, breakdown.sourceQuality, breakdown.objectiveAlignment]) {
      if (component === null) continue
      assert.ok(component >= 0 && component <= 1, `componente fora do intervalo: ${component}`)
    }
  })

  it('explains every evaluated component', () => {
    const breakdown = scoreRelevance(
      {
        title: 'Fraude financeira e machine learning',
        snippet: 'Antifraude com aprendizado de máquina no Brasil.',
        content: null,
        domain: 'example.com',
        publishedAt: '2024-01-01T00:00:00.000Z',
      },
      { investigation },
    )
    assert.ok(breakdown.rationale.length >= 4)
    assert.ok(breakdown.rationale.some((line) => line.includes('Relevância temática')))
    assert.deepEqual(breakdown.weights, DEFAULT_WEIGHTS)
  })

  it('marks recency as missing when the source has no publication date', () => {
    const breakdown = scoreRelevance(
      {
        title: 'Fraude financeira no Brasil',
        snippet: 'Texto sobre fraude.',
        content: null,
        domain: 'example.com',
        publishedAt: null,
      },
      { investigation },
    )
    assert.equal(breakdown.recency, null)
    assert.ok(breakdown.missing.includes('Atualidade'))
    assert.ok(breakdown.rationale.some((line) => line.includes('não avaliada')))
  })

  it('scores a recent source higher on recency than an old one', () => {
    const base = {
      title: 'Fraude financeira',
      snippet: 'Antifraude com machine learning',
      content: null,
      domain: 'example.com',
    }
    const recent = scoreRelevance(
      { ...base, publishedAt: new Date(Date.now() - 60 * 86_400_000).toISOString() },
      { investigation },
    )
    const old = scoreRelevance({ ...base, publishedAt: '2012-01-01T00:00:00.000Z' }, { investigation })
    assert.ok(recent.recency !== null && old.recency !== null)
    assert.ok(recent.recency > old.recency)
  })

  it('does not treat a future date as maximally fresh', () => {
    const breakdown = scoreRelevance(
      {
        title: 'Fraude financeira',
        snippet: 'antifraude',
        content: null,
        domain: 'example.com',
        publishedAt: new Date(Date.now() + 400 * 86_400_000).toISOString(),
      },
      { investigation },
    )
    assert.ok(breakdown.recency !== null)
    assert.ok(breakdown.recency <= 0.5)
    assert.ok(breakdown.rationale.some((line) => line.includes('futuro')))
  })

  it('rewards institutional domains over user-generated content platforms', () => {
    const base = {
      title: 'Fraude financeira e antifraude com machine learning',
      snippet: 'Conteúdo sobre fraude financeira',
      content: 'Texto longo sobre fraude financeira e detecção.',
      publishedAt: '2024-06-01T00:00:00.000Z',
    }
    const gov = scoreRelevance({ ...base, domain: 'bcb.gov.br' }, { investigation })
    const blog = scoreRelevance({ ...base, domain: 'medium.com' }, { investigation })
    assert.ok(gov.sourceQuality !== null && blog.sourceQuality !== null)
    assert.ok(gov.sourceQuality > blog.sourceQuality)
  })

  it('does not award quality from brand reputation alone', () => {
    // A famous domain with no content and no date must not score at the top.
    const breakdown = scoreRelevance(
      {
        title: 'Fraude',
        snippet: '',
        content: null,
        domain: 'reuters.com',
        publishedAt: null,
      },
      { investigation },
    )
    assert.ok(breakdown.sourceQuality !== null)
    assert.ok(breakdown.sourceQuality < 0.85, `qualidade inesperadamente alta: ${breakdown.sourceQuality}`)
  })

  it('respects custom weights', () => {
    const input = {
      title: 'Fraude financeira no Brasil com machine learning',
      snippet: 'antifraude',
      content: 'texto',
      domain: 'example.com',
      publishedAt: '2024-01-01T00:00:00.000Z',
    }
    const topicalHeavy = scoreRelevance(input, {
      investigation,
      weights: { topical: 0.97, recency: 0.01, sourceQuality: 0.01, objectiveAlignment: 0.01 },
    })
    const recencyHeavy = scoreRelevance(input, {
      investigation,
      weights: { topical: 0.01, recency: 0.97, sourceQuality: 0.01, objectiveAlignment: 0.01 },
    })
    assert.notDeepEqual(topicalHeavy.weights, recencyHeavy.weights)
    assert.equal(topicalHeavy.weights.topical, 0.97)
  })

  it('renormalises over available components and says so', () => {
    const breakdown = scoreRelevance(
      {
        title: 'Fraude financeira no Brasil',
        snippet: 'antifraude com machine learning',
        content: null,
        domain: 'example.com',
        publishedAt: null,
      },
      { investigation },
    )
    assert.ok(
      breakdown.rationale.some((line) => line.includes('Índice calculado sobre')),
      'deve explicar que o índice é parcial',
    )
  })

  it('is deterministic for a fixed clock', () => {
    const now = new Date('2025-06-01T12:00:00.000Z')
    const input = {
      title: 'Fraude financeira no Brasil',
      snippet: 'antifraude e machine learning',
      content: null,
      domain: 'example.com',
      publishedAt: '2024-06-01T00:00:00.000Z',
    }
    const first = scoreRelevance(input, { investigation, now })
    const second = scoreRelevance(input, { investigation, now })
    assert.deepEqual(first, second)
  })
})
