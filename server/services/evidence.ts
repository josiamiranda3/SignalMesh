import type { Evidence, Investigation, ValidationStatus } from '../../shared/domain.ts'
import type { EvidenceBulkCreateInput, EvidenceCreateInput } from '../../shared/schemas.ts'
import { scoreRelevance } from '../../shared/relevance.ts'
import { normalizeUrl } from '../repositories/sqlite.ts'
import type { Repositories } from '../repositories/ports.ts'
import { errors } from '../lib/errors.ts'
import { createId, extractDomain, isSafeHttpUrl, nowIso } from '../lib/util.ts'
import type { ActivityService } from './activity.ts'
import type { InvestigationService } from './investigations.ts'

/**
 * Evidence storage.
 *
 * - Ownership is enforced through the investigation, never from client input.
 * - URLs are normalised before the duplicate check, so `?utm_source=...` and a
 *   trailing slash do not create a second copy of the same source.
 * - Relevance is computed on write from the investigation topic/objective and
 *   stored with its full breakdown, so a later weight change never rewrites
 *   history silently.
 */
export class EvidenceService {
  constructor(
    private readonly repos: Repositories,
    private readonly investigations: InvestigationService,
    private readonly activity: ActivityService,
  ) {}

  private buildEvidence(
    investigation: Investigation,
    source: EvidenceCreateInput['source'],
    ownerId: string,
  ): Evidence {
    const domain = source.domain || extractDomain(source.url)
    const breakdown = scoreRelevance(
      {
        title: source.title,
        snippet: source.snippet,
        content: source.retrievedContent,
        domain,
        publishedAt: source.publishedAt,
      },
      { investigation },
    )
    const timestamp = nowIso()
    return {
      id: createId('evi'),
      investigationId: investigation.id,
      ownerId,
      title: source.title,
      url: source.url,
      domain,
      snippet: source.snippet,
      retrievedContent: source.retrievedContent,
      publishedAt: source.publishedAt,
      author: source.author,
      collectedAt: timestamp,
      source: 'exa',
      sourceMetadata: {
        providerRequestId: source.providerRequestId,
        contentAvailability: source.contentAvailability,
        capturedDomain: domain,
      },
      contentAvailability: source.contentAvailability,
      relevanceScore: computeOverall(breakdown),
      relevanceBreakdown: breakdown,
      validationStatus: 'pending',
      note: '',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
  }

  async addOne(
    investigationId: string,
    ownerId: string,
    input: EvidenceCreateInput,
  ): Promise<{ evidence: Evidence; duplicate: boolean }> {
    const investigation = await this.investigations.requireOwned(investigationId, ownerId)
    if (!isSafeHttpUrl(input.source.url)) {
      throw errors.invalid('A URL da fonte deve ser http ou https')
    }

    const normalized = normalizeUrl(input.source.url)
    const existing = await this.repos.evidence.findDuplicate(investigationId, normalized)
    if (existing && !input.allowDuplicate) {
      return { evidence: existing, duplicate: true }
    }

    const evidence = this.buildEvidence(investigation, input.source, ownerId)
    await this.repos.evidence.create(evidence)
    await this.activity.record({
      investigationId,
      ownerId,
      eventType: 'evidence.added',
      description: `Evidência "${evidence.title}" adicionada a partir de ${evidence.domain || 'fonte externa'}`,
      metadata: {
        evidenceId: evidence.id,
        url: evidence.url,
        relevanceScore: evidence.relevanceScore,
      },
    })
    return { evidence, duplicate: false }
  }

  async addMany(
    investigationId: string,
    ownerId: string,
    input: EvidenceBulkCreateInput,
  ): Promise<{ added: Evidence[]; skipped: Array<{ url: string; reason: string }> }> {
    const investigation = await this.investigations.requireOwned(investigationId, ownerId)
    const added: Evidence[] = []
    const skipped: Array<{ url: string; reason: string }> = []
    const seenInBatch = new Set<string>()

    for (const source of input.sources) {
      if (!isSafeHttpUrl(source.url)) {
        skipped.push({ url: source.url, reason: 'URL inválida (apenas http/https)' })
        continue
      }
      const normalized = normalizeUrl(source.url)
      if (seenInBatch.has(normalized)) {
        skipped.push({ url: source.url, reason: 'URL repetida nesta seleção' })
        continue
      }
      seenInBatch.add(normalized)
      const existing = await this.repos.evidence.findDuplicate(investigationId, normalized)
      if (existing && !input.allowDuplicates) {
        skipped.push({ url: source.url, reason: 'Fonte já adicionada a esta investigação' })
        continue
      }
      const evidence = this.buildEvidence(investigation, source, ownerId)
      await this.repos.evidence.create(evidence)
      added.push(evidence)
    }

    if (added.length > 0) {
      await this.activity.record({
        investigationId,
        ownerId,
        eventType: 'evidence.added',
        description: `${added.length} evidência(s) adicionada(s) da pesquisa`,
        metadata: { count: added.length, skipped: skipped.length, evidenceIds: added.map((item) => item.id) },
      })
    }

    return { added, skipped }
  }

  async list(investigationId: string, ownerId: string): Promise<Evidence[]> {
    await this.investigations.requireOwned(investigationId, ownerId)
    return this.repos.evidence.listByInvestigation(investigationId)
  }

  async requireOwned(id: string, ownerId: string): Promise<Evidence> {
    const evidence = await this.repos.evidence.findById(id)
    if (!evidence || evidence.ownerId !== ownerId) {
      throw errors.notFound('Evidência não encontrada')
    }
    return evidence
  }

  async updateNote(id: string, ownerId: string, note: string): Promise<Evidence> {
    const current = await this.requireOwned(id, ownerId)
    const updated = await this.repos.evidence.update(id, { note, updatedAt: nowIso() })
    if (!updated) throw errors.notFound('Evidência não encontrada')
    await this.activity.record({
      investigationId: current.investigationId,
      ownerId,
      eventType: 'evidence.note_updated',
      description: `Observação atualizada em "${current.title}"`,
      metadata: { evidenceId: id },
    })
    return updated
  }

  async remove(id: string, ownerId: string): Promise<void> {
    const evidence = await this.requireOwned(id, ownerId)
    await this.repos.evidence.remove(id)
    await this.activity.record({
      investigationId: evidence.investigationId,
      ownerId,
      eventType: 'evidence.removed',
      description: `Evidência "${evidence.title}" excluída`,
      metadata: { evidenceId: id, url: evidence.url },
    })
  }

  async setValidationStatus(id: string, status: ValidationStatus): Promise<void> {
    await this.repos.evidence.update(id, { validationStatus: status, updatedAt: nowIso() })
  }

  async countsForOwner(ownerId: string): Promise<{ total: number; byStatus: Record<string, number> }> {
    return this.repos.evidence.countByOwner(ownerId)
  }

  async countsForInvestigation(investigationId: string): Promise<Record<string, number>> {
    return this.repos.evidence.countsByInvestigation(investigationId)
  }
}

function computeOverall(breakdown: ReturnType<typeof scoreRelevance>): number {
  const weights = breakdown.weights
  let sum = 0
  let effective = 0
  if (breakdown.topical !== null) {
    sum += breakdown.topical * weights.topical
    effective += weights.topical
  }
  if (breakdown.recency !== null) {
    sum += breakdown.recency * weights.recency
    effective += weights.recency
  }
  if (breakdown.sourceQuality !== null) {
    sum += breakdown.sourceQuality * weights.sourceQuality
    effective += weights.sourceQuality
  }
  if (breakdown.objectiveAlignment !== null) {
    sum += breakdown.objectiveAlignment * weights.objectiveAlignment
    effective += weights.objectiveAlignment
  }
  return effective > 0 ? Math.round((sum / effective) * 1000) / 1000 : 0
}
