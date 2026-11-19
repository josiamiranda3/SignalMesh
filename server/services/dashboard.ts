import type { DashboardSummary } from '../../shared/api.ts'
import type { Repositories } from '../repositories/ports.ts'
import type { ActivityService } from './activity.ts'
import type { UsageService } from './usage.ts'

/**
 * Dashboard aggregation.
 *
 * Every number is computed from persisted rows for the calling user — there are
 * no placeholder metrics. When a user has no data the aggregation returns zeros
 * and the UI renders a designed empty state.
 */
export class DashboardService {
  constructor(
    private readonly repos: Repositories,
    private readonly activity: ActivityService,
    private readonly usage: UsageService,
  ) {}

  async summary(ownerId: string): Promise<DashboardSummary> {
    const [investigationCounts, evidenceCounts, analyses, validations, activityCount, activity, recentInvestigations, evidenceTrend, investigationTrend, quota] =
      await Promise.all([
        this.repos.investigations.countByStatus(ownerId),
        this.repos.evidence.countByOwner(ownerId),
        this.repos.analyses.countByOwner(ownerId),
        this.repos.validations.countByOwner(ownerId),
        this.activity.countByOwner(ownerId),
        this.activity.listByOwner(ownerId, 8),
        this.repos.investigations.listByOwner(ownerId),
        this.repos.evidence.createdAtBuckets(ownerId, 30),
        this.investigationTrend(ownerId),
        this.usage.snapshot(ownerId),
      ])

    const investigationTotal = Object.values(investigationCounts).reduce((sum, value) => sum + value, 0)

    return {
      investigations: {
        total: investigationTotal,
        byStatus: investigationCounts,
      },
      evidence: {
        total: evidenceCounts.total,
        byStatus: evidenceCounts.byStatus,
      },
      analyses,
      validations,
      activityCount,
      evidenceTrend: fillDailyBuckets(evidenceTrend, 30),
      investigationTrend,
      recentActivity: activity,
      recentInvestigations: recentInvestigations.slice(0, 5),
      quota,
    }
  }

  private async investigationTrend(ownerId: string): Promise<Array<{ date: string; count: number }>> {
    const all = await this.repos.investigations.listByOwner(ownerId)
    const buckets = new Map<string, number>()
    for (const investigation of all) {
      const date = investigation.createdAt.slice(0, 10)
      buckets.set(date, (buckets.get(date) ?? 0) + 1)
    }
    return fillDailyBuckets(
      [...buckets.entries()].map(([date, count]) => ({ date, count })),
      30,
    )
  }
}

/** Produce a dense 30-day series ending today, with zeros for empty days. */
function fillDailyBuckets(rows: Array<{ date: string; count: number }>, days: number): Array<{ date: string; count: number }> {
  const byDate = new Map(rows.map((row) => [row.date, row.count]))
  const result: Array<{ date: string; count: number }> = []
  const today = new Date()
  for (let index = days - 1; index >= 0; index -= 1) {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - index))
    const key = date.toISOString().slice(0, 10)
    result.push({ date: key, count: byDate.get(key) ?? 0 })
  }
  return result
}
