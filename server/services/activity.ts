import type { ActivityLogEntry, ActivityType } from '../../shared/domain.ts'
import type { Repositories } from '../repositories/ports.ts'
import { createId, nowIso } from '../lib/util.ts'

/**
 * Activity trail.
 *
 * Every meaningful state change is appended here with the acting user, the
 * investigation it belongs to, and a metadata snapshot. The trail is persisted
 * (never browser-only) and is what the history view and the export consume.
 */
export class ActivityService {
  constructor(private readonly repos: Repositories) {}

  async record(input: {
    investigationId: string | null
    ownerId: string
    eventType: ActivityType
    description: string
    metadata?: Record<string, unknown>
  }): Promise<ActivityLogEntry> {
    return this.repos.activity.create({
      id: createId('act'),
      investigationId: input.investigationId,
      ownerId: input.ownerId,
      eventType: input.eventType,
      description: input.description,
      metadata: input.metadata ?? {},
      createdAt: nowIso(),
    })
  }

  async listByOwner(ownerId: string, limit: number, offset = 0): Promise<ActivityLogEntry[]> {
    return this.repos.activity.listByOwner(ownerId, limit, offset)
  }

  async listByInvestigation(investigationId: string, limit = 200): Promise<ActivityLogEntry[]> {
    return this.repos.activity.listByInvestigation(investigationId, limit)
  }

  async countByOwner(ownerId: string): Promise<number> {
    return this.repos.activity.countByOwner(ownerId)
  }
}
