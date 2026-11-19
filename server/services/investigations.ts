import type { Investigation, InvestigationStatus } from '../../shared/domain.ts'
import type { InvestigationCreateInput, InvestigationUpdateInput, ListQueryInput } from '../../shared/schemas.ts'
import type { Paginated } from '../../shared/api.ts'
import type { Repositories } from '../repositories/ports.ts'
import { errors } from '../lib/errors.ts'
import { createId, nowIso } from '../lib/util.ts'
import type { ActivityService } from './activity.ts'

/**
 * Investigation lifecycle and ownership enforcement.
 *
 * Every method that touches an existing investigation calls `requireOwned`,
 * which loads the row and compares `ownerId`. A caller that guesses another
 * user's investigation id receives `not_found` — the same answer as a genuinely
 * missing id — so the API does not confirm that a foreign record exists.
 */
export class InvestigationService {
  constructor(
    private readonly repos: Repositories,
    private readonly activity: ActivityService,
  ) {}

  async create(ownerId: string, input: InvestigationCreateInput): Promise<Investigation> {
    const timestamp = nowIso()
    const investigation: Investigation = {
      id: createId('inv'),
      ownerId,
      title: input.title,
      description: input.description,
      objective: input.objective,
      topic: input.topic,
      keywords: dedupeKeywords(input.keywords),
      status: input.status,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    await this.repos.investigations.create(investigation)
    await this.activity.record({
      investigationId: investigation.id,
      ownerId,
      eventType: 'investigation.created',
      description: `Investigação "${investigation.title}" criada`,
      metadata: { status: investigation.status, topic: investigation.topic },
    })
    return investigation
  }

  async requireOwned(id: string, ownerId: string): Promise<Investigation> {
    const investigation = await this.repos.investigations.findById(id)
    if (!investigation || investigation.ownerId !== ownerId) {
      throw errors.notFound('Investigação não encontrada')
    }
    return investigation
  }

  async get(id: string, ownerId: string): Promise<Investigation> {
    return this.requireOwned(id, ownerId)
  }

  async list(ownerId: string, query: ListQueryInput): Promise<Paginated<Investigation>> {
    const result = await this.repos.investigations.list({
      ownerId,
      search: query.search,
      status: query.status,
      sort: query.sort,
      direction: query.direction,
      limit: query.limit,
      offset: query.offset,
    })
    return { items: result.items, total: result.total, limit: query.limit, offset: query.offset }
  }

  async update(id: string, ownerId: string, patch: InvestigationUpdateInput): Promise<Investigation> {
    const current = await this.requireOwned(id, ownerId)

    const changedFields = Object.keys(patch)
    if (changedFields.length === 0) throw errors.invalid('Nenhum campo para atualizar')

    const nextStatus = patch.status
    const updated = await this.repos.investigations.update(id, {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.objective !== undefined ? { objective: patch.objective } : {}),
      ...(patch.topic !== undefined ? { topic: patch.topic } : {}),
      ...(patch.keywords !== undefined ? { keywords: dedupeKeywords(patch.keywords) } : {}),
      ...(nextStatus !== undefined ? { status: nextStatus } : {}),
      updatedAt: nowIso(),
    })
    if (!updated) throw errors.notFound('Investigação não encontrada')

    await this.activity.record({
      investigationId: id,
      ownerId,
      eventType: nextStatus && nextStatus !== current.status ? 'investigation.status_changed' : 'investigation.updated',
      description:
        nextStatus && nextStatus !== current.status
          ? `Status alterado de "${current.status}" para "${nextStatus}"`
          : 'Investigação atualizada',
      metadata: { fields: changedFields, previousStatus: current.status, status: updated.status },
    })
    return updated
  }

  async changeStatus(id: string, ownerId: string, status: InvestigationStatus): Promise<Investigation> {
    return this.update(id, ownerId, { status })
  }

  async archive(id: string, ownerId: string): Promise<Investigation> {
    const current = await this.requireOwned(id, ownerId)
    const updated = await this.repos.investigations.update(id, { status: 'archived', updatedAt: nowIso() })
    if (!updated) throw errors.notFound('Investigação não encontrada')
    await this.activity.record({
      investigationId: id,
      ownerId,
      eventType: 'investigation.archived',
      description: 'Investigação arquivada',
      metadata: { status: 'archived', previousStatus: current.status },
    })
    return updated
  }

  /**
   * Deletes the investigation and everything that belongs to it. The activity
   * trail is preserved with a final entry, then the rows are removed in one
   * cascade (foreign keys point at investigations).
   */
  async remove(id: string, ownerId: string): Promise<void> {
    const investigation = await this.requireOwned(id, ownerId)
    await this.activity.record({
      investigationId: null,
      ownerId,
      eventType: 'investigation.deleted',
      description: `Investigação "${investigation.title}" excluída`,
      metadata: { investigationId: id, evidenceRemoved: true },
    })
    const removed = await this.repos.investigations.remove(id)
    if (!removed) throw errors.notFound('Investigação não encontrada')
  }

  async statusCounts(ownerId: string): Promise<Record<string, number>> {
    return this.repos.investigations.countByStatus(ownerId)
  }
}

function dedupeKeywords(keywords: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const keyword of keywords) {
    const cleaned = keyword.trim()
    const key = cleaned.toLowerCase()
    if (!cleaned || seen.has(key)) continue
    seen.add(key)
    result.push(cleaned)
  }
  return result.slice(0, 20)
}
