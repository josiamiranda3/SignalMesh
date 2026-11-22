import { Link } from 'react-router-dom'
import {
  Activity,
  ArrowRight,
  BadgeCheck,
  CircleDashed,
  FlaskConical,
  Gauge,
  Layers,
  Plus,
  Sparkles,
} from 'lucide-react'
import type { DashboardSummary } from '@shared/api'
import { api } from '@/lib/api'
import { useAsync } from '@/hooks/useAsync'
import { PageContainer, PageHeader, SectionHeader } from '@/components/layout/Page'
import { MetricCard } from '@/components/dashboard/MetricCard'
import { Sparkline, BarDistribution } from '@/components/charts/Charts'
import {
  Button,
  EmptyState,
  InvestigationStatusBadge,
  Meter,
  Notice,
  Skeleton,
  SkeletonStats,
  validationLabel,
} from '@/components/ui'
import { formatNumber, formatRelative, formatDate, untilReset } from '@/lib/format'
import { useI18n } from '@/i18n/I18nProvider'
import { useAuth } from '@/app/AuthProvider'

/**
 * Dashboard.
 *
 * Every figure comes from `/api/dashboard`, which aggregates persisted rows for
 * the signed-in user. A brand-new account sees zeros plus designed empty states
 * that explain what will appear here and how to start — never sample numbers.
 */
export default function DashboardPage() {
  const { user } = useAuth()
  const { t } = useI18n()
  const { data, error, loading, reload } = useAsync<DashboardSummary>(
    () => api.get<DashboardSummary>('/api/dashboard'),
    [],
  )

  if (loading) {
    return (
      <PageContainer>
        <PageHeader
          eyebrow={t('dashboard.eyebrow')}
          title={t('dashboard.title')}
          description={t('dashboard.loading')}
        />
        <div className="mt-6 space-y-4">
          <SkeletonStats />
          <div className="grid gap-5 lg:grid-cols-3">
            <Skeleton className="h-72 rounded-lg lg:col-span-2" />
            <Skeleton className="h-72 rounded-lg" />
          </div>
        </div>
      </PageContainer>
    )
  }

  if (error || !data) {
    return (
      <PageContainer>
        <PageHeader eyebrow={t('dashboard.eyebrow')} title={t('dashboard.title')} />
        <Notice
          tone="danger"
          title={t('dashboard.loadError')}
          action={
            <Button size="sm" onClick={reload}>
              {t('common.retry')}
            </Button>
          }
        >
          {error?.message ?? t('dashboard.loadErrorFallback')}
        </Notice>
      </PageContainer>
    )
  }

  const isEmpty = data.investigations.total === 0
  const accepted = data.evidence.byStatus['accepted'] ?? 0
  const rejected = data.evidence.byStatus['rejected'] ?? 0
  const pending = data.evidence.byStatus['pending'] ?? 0
  const review = data.evidence.byStatus['needs_review'] ?? 0
  const totalEvidence = data.evidence.total

  return (
    <PageContainer>
      <PageHeader
        eyebrow={t('dashboard.eyebrow')}
        title={t('dashboard.greeting', {
          name: firstName(user?.name, t('dashboard.greetingAnonymous')),
        })}
        description={t('dashboard.description')}
        actions={
          <>
            <Button variant="secondary" size="md" onClick={reload} loading={false}>
              {t('dashboard.refresh')}
            </Button>
            <Link to="/investigations/new">
              <Button variant="primary" size="md" iconLeft={<Plus className="size-4" aria-hidden />}>
                {t('dashboard.newInvestigation')}
              </Button>
            </Link>
          </>
        }
      />

      <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label={t('dashboard.metricInvestigations')}
          value={formatNumber(data.investigations.total)}
          hint={t('dashboard.metricInvestigationsHint', {
            active: data.investigations.byStatus['active'] ?? 0,
            draft: data.investigations.byStatus['draft'] ?? 0,
          })}
          icon={FlaskConical}
          tone="signal"
        />
        <MetricCard
          label={t('dashboard.metricEvidence')}
          value={formatNumber(totalEvidence)}
          hint={
            totalEvidence === 0
              ? t('dashboard.metricEvidenceEmpty')
              : t('dashboard.metricEvidenceHint', { pending: formatNumber(pending + review) })
          }
          icon={Layers}
        />
        <MetricCard
          label={t('dashboard.metricAccepted')}
          value={formatNumber(accepted)}
          hint={
            totalEvidence > 0
              ? t('dashboard.metricAcceptedHint', { percent: Math.round((accepted / totalEvidence) * 100) })
              : t('dashboard.metricAcceptedEmpty')
          }
          icon={BadgeCheck}
          tone="positive"
        />
        <MetricCard
          label={t('dashboard.metricAnalyses')}
          value={formatNumber(data.analyses)}
          hint={t('dashboard.metricAnalysesHint', { count: formatNumber(data.validations) })}
          icon={Sparkles}
          tone="signal"
        />
      </div>

      {isEmpty ? (
        <div className="mt-5">
          <EmptyState
            icon={<FlaskConical className="size-5" aria-hidden />}
            title={t('dashboard.emptyTitle')}
            description={t('dashboard.emptyDescription')}
            action={
              <Link to="/investigations/new">
                <Button variant="primary" iconLeft={<Plus className="size-4" aria-hidden />}>
                  {t('dashboard.emptyAction')}
                </Button>
              </Link>
            }
            secondary={
              <Link to="/settings">
                <Button variant="ghost">{t('dashboard.emptySecondary')}</Button>
              </Link>
            }
          />
        </div>
      ) : (
        <>
          <div className="mt-5 grid gap-4 lg:grid-cols-3">
            {/* Evidence distribution */}
            <section className="panel p-5 lg:col-span-1" aria-labelledby="distribution-title">
              <SectionHeader
                title={t('dashboard.distributionTitle')}
                description={t('dashboard.distributionDescription')}
              />
              <div className="mt-5">
                <Meter
                  ariaLabel={t('dashboard.distributionTitle')}
                  segments={[
                    { value: accepted, tone: 'bg-positive', label: validationLabel('accepted') },
                    { value: review, tone: 'bg-caution', label: validationLabel('needs_review') },
                    { value: rejected, tone: 'bg-negative', label: validationLabel('rejected') },
                    { value: pending, tone: 'bg-ink-faint/40', label: validationLabel('pending') },
                  ]}
                />
              </div>
              <BarDistribution
                className="mt-5"
                rows={[
                  { label: validationLabel('accepted'), value: accepted, tone: 'bg-positive' },
                  { label: validationLabel('needs_review'), value: review, tone: 'bg-caution' },
                  { label: validationLabel('rejected'), value: rejected, tone: 'bg-negative' },
                  { label: validationLabel('pending'), value: pending, tone: 'bg-ink-faint/40' },
                ]}
              />
              <div className="mt-5 border-t border-hairline pt-4">
                <p className="text-[0.75rem] leading-relaxed text-ink-faint">
                  {t('dashboard.distributionNote')}
                </p>
              </div>
            </section>

            {/* 30-day trend */}
            <section className="panel p-5 lg:col-span-2" aria-labelledby="trend-title">
              <SectionHeader
                title={t('dashboard.trendTitle')}
                description={t('dashboard.trendDescription')}
                actions={
                  <div className="flex items-center gap-3 text-[0.75rem] text-ink-faint">
                    <span className="flex items-center gap-1.5">
                      <span className="size-1.5 rounded-full bg-signal" aria-hidden />
                      {t('dashboard.legendInvestigations')}
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="size-1.5 rounded-full bg-ink-muted" aria-hidden />
                      {t('dashboard.legendEvidence')}
                    </span>
                  </div>
                }
              />
              <div className="mt-5 space-y-4">
                <div>
                  <div className="flex items-baseline justify-between">
                    <p className="text-[0.75rem] text-ink-subtle">{t('dashboard.trendInvestigationsLabel')}</p>
                    <p className="figure text-[0.75rem] text-ink-muted">
                      {t('dashboard.trendLast30', {
                        count: formatNumber(data.investigationTrend.reduce((sum, point) => sum + point.count, 0)),
                      })}
                    </p>
                  </div>
                  <Sparkline
                    data={data.investigationTrend}
                    ariaLabel={t('dashboard.trendInvestigationsLabel')}
                    height={82}
                    tone="signal"
                  />
                </div>
                <div>
                  <div className="flex items-baseline justify-between">
                    <p className="text-[0.75rem] text-ink-subtle">{t('dashboard.trendEvidenceLabel')}</p>
                    <p className="figure text-[0.75rem] text-ink-muted">
                      {t('dashboard.trendLast30', {
                        count: formatNumber(data.evidenceTrend.reduce((sum, point) => sum + point.count, 0)),
                      })}
                    </p>
                  </div>
                  <Sparkline
                    data={data.evidenceTrend}
                    ariaLabel={t('dashboard.trendEvidenceLabel')}
                    height={82}
                    tone="neutral"
                  />
                </div>
              </div>
            </section>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-[1.45fr_1fr]">
            {/* Recent investigations */}
            <section className="panel overflow-hidden" aria-labelledby="recent-investigations">
              <div className="flex items-center justify-between border-b border-hairline px-5 py-3.5">
                <h2 id="recent-investigations" className="text-[0.875rem] font-semibold text-ink">
                  {t('dashboard.recentInvestigations')}
                </h2>
                <Link
                  to="/investigations"
                  className="flex min-h-11 items-center gap-1 text-[0.75rem] text-ink-subtle transition-colors hover:text-ink"
                >
                  {t('dashboard.viewAll')}
                  <ArrowRight className="size-3" aria-hidden />
                </Link>
              </div>
              {data.recentInvestigations.length === 0 ? (
                <div className="px-5 py-10 text-center text-[0.8125rem] text-ink-faint">
                  {t('dashboard.recentInvestigationsEmpty')}
                </div>
              ) : (
                <ul className="divide-y divide-hairline/60">
                  {data.recentInvestigations.map((investigation) => (
                    <li key={investigation.id}>
                      <Link
                        to={`/investigations/${investigation.id}`}
                        className="group flex items-start gap-3 px-5 py-3.5 transition-colors hover:bg-white/[0.02]"
                      >
                        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-hairline-strong bg-raised">
                          <FlaskConical className="size-3.5 text-ink-subtle" aria-hidden />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-[0.8125rem] font-medium text-ink group-hover:text-white">
                              {investigation.title}
                            </p>
                            <InvestigationStatusBadge status={investigation.status} />
                          </div>
                          <p className="mt-0.5 truncate text-[0.75rem] text-ink-faint">{investigation.topic}</p>
                        </div>
                        <span className="shrink-0 text-[0.75rem] text-ink-faint">
                          {formatRelative(investigation.updatedAt)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Recent activity + quota */}
            <div className="flex flex-col gap-4">
              <section className="panel overflow-hidden" aria-labelledby="recent-activity">
                <div className="flex items-center justify-between border-b border-hairline px-5 py-3.5">
                  <h2 id="recent-activity" className="text-[0.875rem] font-semibold text-ink">
                    {t('dashboard.recentActivity')}
                  </h2>
                  <Activity className="size-3.5 text-ink-faint" aria-hidden />
                </div>
                {data.recentActivity.length === 0 ? (
                  <div className="px-5 py-8 text-center text-[0.8125rem] text-ink-faint">
                    {t('dashboard.recentActivityEmpty')}
                  </div>
                ) : (
                  <ul className="divide-y divide-hairline/60">
                    {data.recentActivity.slice(0, 5).map((entry) => (
                      <li key={entry.id} className="px-5 py-3">
                        <p className="text-[0.78125rem] leading-snug text-ink-muted">{entry.description}</p>
                        <p className="mt-0.5 text-[0.75rem] text-ink-faint">{formatRelative(entry.createdAt)}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="panel p-5" aria-labelledby="quota-title">
                <div className="flex items-center justify-between">
                  <h2 id="quota-title" className="text-[0.875rem] font-semibold text-ink">
                    {t('dashboard.quotaTitle')}
                  </h2>
                  <Gauge className="size-3.5 text-ink-faint" aria-hidden />
                </div>
                <div className="mt-4 space-y-3.5">
                  <QuotaRow
                    label={t('dashboard.quotaResearch')}
                    used={data.quota.research.used}
                    limit={data.quota.research.limit}
                    resetsAt={data.quota.research.resetsAt}
                  />
                  <QuotaRow
                    label={t('dashboard.quotaAnalysis')}
                    used={data.quota.analysis.used}
                    limit={data.quota.analysis.limit}
                    resetsAt={data.quota.analysis.resetsAt}
                  />
                </div>
                {!data.quota.externalApisEnabled ? (
                  <p className="mt-4 flex items-start gap-2 rounded-md border border-hairline bg-raised/50 px-3 py-2 text-[0.75rem] leading-relaxed text-ink-subtle">
                    <CircleDashed className="mt-0.5 size-3.5 shrink-0 text-caution" aria-hidden />
                    {t('dashboard.quotaExternalDisabled')}
                  </p>
                ) : null}
                <Link
                  to="/settings"
                  className="mt-4 inline-flex min-h-9 items-center gap-1 text-[0.75rem] text-signal-bright transition-colors hover:text-signal"
                >
                  {t('dashboard.quotaConfigure')}
                  <ArrowRight className="size-3" aria-hidden />
                </Link>
              </section>
            </div>
          </div>
        </>
      )}
    </PageContainer>
  )
}

function QuotaRow({
  label,
  used,
  limit,
  resetsAt,
}: {
  label: string
  used: number
  limit: number
  resetsAt: string
}) {
  const { t } = useI18n()
  const ratio = limit > 0 ? used / limit : 0
  const tone = ratio >= 1 ? 'negative' : ratio >= 0.7 ? 'caution' : 'signal'
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[0.75rem] text-ink-muted">{label}</span>
        <span className="figure text-[0.75rem] text-ink-subtle">
          {used}/{limit}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#1a222c]">
        <div
          className={`h-full rounded-full transition-[width] ${
            tone === 'negative' ? 'bg-negative' : tone === 'caution' ? 'bg-caution' : 'bg-signal'
          }`}
          style={{ width: `${Math.min(100, ratio * 100)}%` }}
        />
      </div>
      {used >= limit ? (
        <p className="mt-1 text-[0.75rem] text-negative">
          {t('dashboard.quotaExhausted', { when: untilReset(resetsAt) })}
        </p>
      ) : null}
    </div>
  )
}

/**
 * First name for the greeting, or the generic greeting when the session has no
 * name. The caller passes the already-translated fallback so this helper never
 * holds user-facing copy of its own.
 */
function firstName(name: string | undefined, fallback: string): string {
  if (!name) return fallback
  return name.trim().split(/\s+/)[0] ?? name
}

/** Re-exported for tests that import the trend formatter. */
export const dashboardDate = formatDate
