import type { Services } from './services/index.ts'
import { createId, nowIso } from './lib/util.ts'
import { scoreRelevance } from '../shared/relevance.ts'

/**
 * Explicitly-labelled demo data.
 *
 * This runs only when `SEED_DEMO_DATA=true`. Every seeded row carries the
 * `demo: true` marker in its metadata/note, and the investigation title is
 * prefixed with "[DEMONSTRAÇÃO]", so a reviewer can never mistake it for real
 * research output. It is never created automatically on a normal boot.
 */

const DEMO_EMAIL = 'demonstracao@signalmess.local'

export async function seedDemoData(services: Services): Promise<void> {
  const existing = await services.repos.users.findByEmail(DEMO_EMAIL)
  const user =
    existing ??
    (await services.repos.users.upsert({
      id: 'usr_demo_signalmesh',
      email: DEMO_EMAIL,
      name: 'Conta de demonstração',
      avatarUrl: null,
      createdAt: nowIso(),
    }))

  const investigations = await services.repos.investigations.listByOwner(user.id)
  if (investigations.length > 0) return

  const investigation = await services.investigations.create(user.id, {
    title: '[DEMONSTRAÇÃO] IA na detecção de fraudes financeiras no Brasil',
    description:
      'Investigação de demonstração criada para ilustrar o fluxo completo do SignalMesh. As evidências abaixo são exemplos estáticos e não foram obtidas por pesquisa real.',
    objective:
      'Identificar aplicações reais de inteligência artificial na detecção de fraudes financeiras no Brasil, instituições envolvidas, tecnologias utilizadas e resultados publicados.',
    topic: 'inteligência artificial para detecção de fraudes financeiras no Brasil',
    keywords: ['fraude financeira', 'machine learning', 'Brasil', 'detecção de anomalias'],
    status: 'active',
  })

  const seeds = [
    {
      title: 'Detecção de fraudes com aprendizado de máquina em transações de cartão',
      url: 'https://example.org/demo/estudo-fraude-cartao',
      domain: 'example.org',
      snippet:
        'Exemplo fictício usado apenas para demonstração da interface. Estudo hipotético descreve modelos de gradient boosting aplicados a transações de cartão de crédito.',
      publishedAt: '2024-05-12T00:00:00.000Z',
      author: 'Equipe de demonstração',
    },
    {
      title: 'Regulação de IA no setor financeiro brasileiro',
      url: 'https://example.org/demo/regulacao-ia-financeiro',
      domain: 'example.org',
      snippet:
        'Exemplo fictício usado apenas para demonstração da interface. Documento hipotético discute requisitos de explicabilidade em modelos de decisão de crédito.',
      publishedAt: '2023-11-03T00:00:00.000Z',
      author: 'Equipe de demonstração',
    },
  ]

  for (const seed of seeds) {
    const breakdown = scoreRelevance(
      {
        title: seed.title,
        snippet: seed.snippet,
        content: seed.snippet,
        domain: seed.domain,
        publishedAt: seed.publishedAt,
      },
      { investigation: { topic: investigation.topic, objective: investigation.objective, keywords: investigation.keywords } },
    )
    const components = [breakdown.topical, breakdown.recency, breakdown.sourceQuality, breakdown.objectiveAlignment]
    const present = components.filter((value): value is number => value !== null)
    const score = present.length ? present.reduce((sum, value) => sum + value, 0) / present.length : 0

    await services.repos.evidence.create({
      id: createId('evi'),
      investigationId: investigation.id,
      ownerId: user.id,
      title: seed.title,
      url: seed.url,
      domain: seed.domain,
      snippet: seed.snippet,
      retrievedContent: null,
      publishedAt: seed.publishedAt,
      author: seed.author,
      collectedAt: nowIso(),
      source: 'demo',
      sourceMetadata: { demo: true },
      contentAvailability: ['snippet'],
      relevanceScore: Math.round(score * 1000) / 1000,
      relevanceBreakdown: breakdown,
      validationStatus: 'needs_review',
      note: 'Registro de demonstração: esta fonte é fictícia e serve apenas para ilustrar o fluxo.',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
  }

  await services.activity.record({
    investigationId: investigation.id,
    ownerId: user.id,
    eventType: 'investigation.created',
    description: 'Dados de demonstração criados (fontes fictícias, claramente identificadas)',
    metadata: { demo: true },
  })

  console.info(
    `[seed] Demonstração criada para ${DEMO_EMAIL}. As fontes são fictícias e estão marcadas como demonstração.`,
  )
}
