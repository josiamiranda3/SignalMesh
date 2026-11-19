import type { Investigation, RelevanceBreakdown, RelevanceWeights } from './domain.ts'

/**
 * Transparent relevance scoring.
 *
 * The output is a PRIORITISATION INDEX in [0,1] — an ordering aid — and never
 * a probability that a claim is true. Every component is reported with the
 * reason it earned its value, and components that cannot be evaluated because
 * the source lacks the necessary data stay `null` instead of silently scoring
 * as zero.
 */

export const DEFAULT_WEIGHTS: RelevanceWeights = {
  topical: 0.4,
  recency: 0.25,
  sourceQuality: 0.25,
  objectiveAlignment: 0.1,
}

export interface ScoringInput {
  title: string
  snippet: string
  content: string | null
  domain: string
  publishedAt: string | null
}

export interface ScoringContext {
  investigation: Pick<Investigation, 'topic' | 'objective' | 'keywords'>
  weights?: RelevanceWeights
  /** Injectable clock so tests are deterministic. */
  now?: Date
}

const STOP_WORDS = new Set([
  'a','o','e','de','da','do','das','dos','em','no','na','nos','nas','para','por','com','sem','que','se',
  'um','uma','uns','umas','ao','aos','à','às','como','mais','menos','sobre','entre','até','após','antes',
  'the','of','and','to','in','for','with','on','at','by','from','as','is','are','was','were','be','been',
  'this','that','these','those','it','its','or','an','not','but','than','then','into','during','while',
])

/** Lowercase, strip accents/diacritics and split into meaningful tokens. */
export function tokenize(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token))
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * Weighted Jaccard-ish overlap: how much of the investigation's vocabulary is
 * covered by the source. Evidence covering the topic's own words scores higher
 * than a source that merely repeats one keyword many times.
 */
function topicalScore(input: ScoringInput, context: ScoringContext): { value: number | null; reason: string } {
  const topicTokens = new Set(tokenize(`${context.investigation.topic} ${context.investigation.keywords.join(' ')}`))
  if (topicTokens.size === 0) {
    return { value: null, reason: 'Tema sem termos utilizáveis para comparação' }
  }
  const haystack = `${input.title} ${input.snippet} ${input.content ?? ''}`
  const sourceTokens = new Set(tokenize(haystack))
  let matched = 0
  for (const token of topicTokens) {
    if (sourceTokens.has(token)) matched += 1
  }
  const coverage = matched / topicTokens.size
  const density = Math.min(1, matched / Math.max(6, topicTokens.size * 0.6))
  const value = clamp01(coverage * 0.7 + density * 0.3)
  return {
    value: round(value),
    reason: `Cobertura de ${matched}/${topicTokens.size} termos do tema no título, trecho e conteúdo`,
  }
}

/**
 * Recency scores on a 3-year half-life curve. Undated sources return null: an
 * old undated page must not be treated as fresh.
 */
function recencyScore(input: ScoringInput, now: Date): { value: number | null; reason: string } {
  if (!input.publishedAt) {
    return { value: null, reason: 'Fonte sem data de publicação; atualidade não avaliada' }
  }
  const published = new Date(input.publishedAt)
  if (Number.isNaN(published.getTime())) {
    return { value: null, reason: 'Data de publicação inválida' }
  }
  const years = (now.getTime() - published.getTime()) / (365.25 * 86_400_000)
  if (years < 0) {
    return { value: 0.5, reason: 'Data de publicação no futuro; atualidade penalizada e tratada como incerta' }
  }
  const value = clamp01(Math.pow(0.5, years / 3))
  return { value: round(value), reason: `Publicado há ${years.toFixed(1)} anos (meia-vida de 3 anos)` }
}

/** Top-level domains and paths that carry inherent editorial process. */
const INSTITUTIONAL_SUFFIXES = ['.gov', '.gov.br', '.edu', '.edu.br', '.ac.uk', '.org.br', '.int']
const HIGH_TRUST_DOMAINS = new Set([
  'nature.com','science.org','sciencedirect.com','springer.com','link.springer.com','ieee.org','acm.org',
  'arxiv.org','pubmed.ncbi.nlm.nih.gov','ncbi.nlm.nih.gov','who.int','worldbank.org','oecd.org','ibge.gov.br',
  'bcb.gov.br','gov.br','planalto.gov.br','camara.leg.br','senado.leg.br','reuters.com','ft.com','economist.com',
])
const LOW_TRUST_PATTERNS = [
  /medium\.com$/i, /substack\.com$/i, /blogspot\./i, /wordpress\.com$/i, /linkedin\.com$/i,
  /reddit\.com$/i, /quora\.com$/i, /facebook\.com$/i, /x\.com$/i, /twitter\.com$/i, /pinterest\./i,
]

/**
 * Source quality scores structure and accountability signals that are visible
 * from the URL alone. It deliberately does NOT award a high score merely
 * because a brand is famous — reputation is not verifiability.
 */
function sourceQualityScore(input: ScoringInput): { value: number; reason: string } {
  const domain = input.domain.toLowerCase()
  if (!domain) return { value: 0.2, reason: 'Domínio desconhecido' }

  const reasons: string[] = []
  let value = 0.45
  reasons.push('Domínio identificável')

  if (INSTITUTIONAL_SUFFIXES.some((suffix) => domain.endsWith(suffix))) {
    value += 0.3
    reasons.push('Domínio institucional/governamental ou acadêmico')
  } else if (HIGH_TRUST_DOMAINS.has(domain)) {
    value += 0.25
    reasons.push('Domínio de publicação revisada ou órgão oficial reconhecido')
  }

  if (LOW_TRUST_PATTERNS.some((pattern) => pattern.test(domain))) {
    value -= 0.25
    reasons.push('Plataforma de conteúdo gerado por usuário; curadoria editorial limitada')
  }

  const contentLength = (input.content ?? '').length
  if (contentLength >= 1500) {
    value += 0.12
    reasons.push('Conteúdo integral disponível para verificação')
  } else if (contentLength > 0) {
    value += 0.04
    reasons.push(`Conteúdo parcial disponível (${contentLength} caracteres)`)
  } else {
    value -= 0.08
    reasons.push('Sem conteúdo recuperado; apenas metadados')
  }

  if (!input.publishedAt) {
    value -= 0.05
    reasons.push('Ausência de data de publicação reduz rastreabilidade')
  }

  return { value: round(clamp01(value)), reason: reasons.join('; ') }
}

/**
 * Objective alignment measures whether the source addresses the concrete
 * questions in the investigation objective (as opposed to only the broad
 * topic). It stays null when the objective has no usable terms.
 */
function objectiveAlignmentScore(
  input: ScoringInput,
  context: ScoringContext,
): { value: number | null; reason: string } {
  const objectiveTokens = new Set(tokenize(context.investigation.objective))
  if (objectiveTokens.size === 0) {
    return { value: null, reason: 'Objetivo sem termos utilizáveis' }
  }
  const haystack = new Set(tokenize(`${input.title} ${input.snippet} ${input.content ?? ''}`))
  let matched = 0
  for (const token of objectiveTokens) if (haystack.has(token)) matched += 1
  const value = clamp01(matched / objectiveTokens.size)
  return {
    value: round(value),
    reason: `Cobertura de ${matched}/${objectiveTokens.size} termos do objetivo`,
  }
}

/**
 * Compute the prioritisation index and a human-readable breakdown.
 *
 * Weights are renormalised over the components that could actually be
 * evaluated, so a missing publication date does not silently drag a good source
 * down to zero — but `missing` records what was left out so the reader knows
 * the score is partial.
 */
export function scoreRelevance(input: ScoringInput, context: ScoringContext): RelevanceBreakdown {
  const weights = context.weights ?? DEFAULT_WEIGHTS
  const now = context.now ?? new Date()

  const topical = topicalScore(input, context)
  const recency = recencyScore(input, now)
  const quality = sourceQualityScore(input)
  const alignment = objectiveAlignmentScore(input, context)

  const components: Array<{ key: keyof RelevanceWeights; value: number | null; reason: string; label: string }> = [
    { key: 'topical', value: topical.value, reason: topical.reason, label: 'Relevância temática' },
    { key: 'recency', value: recency.value, reason: recency.reason, label: 'Atualidade' },
    { key: 'sourceQuality', value: quality.value, reason: quality.reason, label: 'Qualidade da fonte' },
    { key: 'objectiveAlignment', value: alignment.value, reason: alignment.reason, label: 'Alinhamento ao objetivo' },
  ]

  const missing: string[] = []
  let effectiveWeight = 0
  const rationale: string[] = []

  for (const component of components) {
    const weight = weights[component.key]
    if (component.value === null) {
      missing.push(component.label)
      rationale.push(`${component.label}: não avaliada — ${component.reason}`)
      continue
    }
    effectiveWeight += weight
    rationale.push(`${component.label}: ${component.value.toFixed(2)} (peso ${weight.toFixed(2)}) — ${component.reason}`)
  }

  if (missing.length > 0) {
    rationale.push(
      `Índice calculado sobre ${(effectiveWeight * 100).toFixed(0)}% dos pesos; componentes ausentes: ${missing.join(', ')}`,
    )
  }

  return {
    topical: topical.value,
    recency: recency.value,
    sourceQuality: quality.value,
    objectiveAlignment: alignment.value,
    rationale,
    weights: { ...weights },
    missing,
  }
}

/** Compact ranking index used to order search results before selection. */
export function previewScore(
  result: { title: string; snippet: string; content: string | null; domain: string; publishedAt: string | null },
  investigation: Pick<Investigation, 'topic' | 'objective' | 'keywords'>,
  now = new Date(),
): number {
  const breakdown = scoreRelevance(result, { investigation, now })
  const topical = breakdown.topical ?? 0
  const quality = breakdown.sourceQuality ?? 0
  return Math.round((topical * 0.5 + quality * 0.5) * 1000) / 1000
}
