import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity,
  BadgeCheck,
  ChevronDown,
  Download,
  FlaskConical,
  Layers,
  Search,
  Sparkles,
} from 'lucide-react'
import type { ActivityLogEntry, ActivityType } from '@shared/domain'
import { api } from '@/lib/api'
import { useAsync } from '@/hooks/useAsync'
import { PageContainer, PageHeader } from '@/components/layout/Page'
import { Badge, Button, EmptyState, Input, Notice, Select, Skeleton } from '@/components/ui'
import { formatDateTime, formatNumber, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useI18n, type TranslationKey } from '@/i18n/I18nProvider'
import { getActiveIntlLocale } from '@/lib/active'

/**
 * History.
 *
 * The persisted audit trail across every investigation the caller owns. Reads
 * directly from `activity_logs` — nothing here is reconstructed from browser
 * state, so a reload or a different device shows the same sequence.
 */

/** Filter groups: the label is a key, resolved at render. */
const EVENT_GROUPS: Array<{ value: string; labelKey: TranslationKey; types: ActivityType[] }> = [
  { value: '', labelKey: 'history.groupAll', types: [] },
  { value: 'investigation', labelKey: 'history.groupInvestigation', types: ['investigation.created', 'investigation.updated', 'investigation.status_changed', 'investigation.archived', 'investigation.deleted'] },
  { value: 'research', labelKey: 'history.groupResearch', types: ['research.executed', 'quota.blocked'] },
  { value: 'evidence', labelKey: 'history.groupEvidence', types: ['evidence.added', 'evidence.updated', 'evidence.removed', 'evidence.note_updated'] },
  { value: 'analysis', labelKey: 'history.groupAnalysis', types: ['analysis.requested', 'analysis.completed', 'analysis.failed'] },
  { value: 'validation', labelKey: 'history.groupValidation', types: ['validation.recorded'] },
  { value: 'export', labelKey: 'history.groupExport', types: ['export.generated'] },
]

const EVENT_META: Record<string, { icon: typeof Activity; tone: 'neutral' | 'signal' | 'positive' | 'caution' | 'negative' }> = {
  'investigation.created': { icon: FlaskConical, tone: 'signal' },
  'investigation.updated': { icon: FlaskConical, tone: 'neutral' },
  'investigation.status_changed': { icon: FlaskConical, tone: 'signal' },
  'investigation.archived': { icon: FlaskConical, tone: 'neutral' },
  'investigation.deleted': { icon: FlaskConical, tone: 'negative' },
  'research.executed': { icon: Search, tone: 'signal' },
  'quota.blocked': { icon: Notice, tone: 'caution' } as never,
  'evidence.added': { icon: Layers, tone: 'positive' },
  'evidence.updated': { icon: Layers, tone: 'neutral' },
  'evidence.removed': { icon: Layers, tone: 'negative' },
  'evidence.note_updated': { icon: Layers, tone: 'neutral' },
  'analysis.requested': { icon: Sparkles, tone: 'neutral' },
  'analysis.completed': { icon: Sparkles, tone: 'positive' },
  'analysis.failed': { icon: Sparkles, tone: 'negative' },
  'validation.recorded': { icon: BadgeCheck, tone: 'positive' },
  'export.generated': { icon: Download, tone: 'neutral' },
}

export default function HistoryPage() {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const { data, error, loading, reload } = useAsync<{
    items: ActivityLogEntry[]
    total: number
    limit: number
    offset: number
  }>(() => api.get('/api/history', { limit: 200 }), [])

  const filtered = useMemo(() => {
    const items = data?.items ?? []
    const types = EVENT_GROUPS.find((item) => item.value === group)?.types ?? []
    const needle = query.trim().toLowerCase()
    return items.filter((entry) => {
      if (types.length > 0 && !types.includes(entry.eventType)) return false
      if (!needle) return true
      return (
        entry.description.toLowerCase().includes(needle) ||
        entry.eventType.toLowerCase().includes(needle)
      )
    })
  }, [data, group, query])

  const groupedByDay = useMemo(() => {
    const groups = new Map<string, ActivityLogEntry[]>()
    for (const entry of filtered) {
      const day = entry.createdAt.slice(0, 10)
      const list = groups.get(day) ?? []
      list.push(entry)
      groups.set(day, list)
    }
    return [...groups.entries()]
  }, [filtered])

  return (
    <PageContainer>
      <PageHeader
        eyebrow={t('history.eyebrow')}
        title={t('history.title')}
        description={t('history.description')}
        meta={
          data ? (
            <span className="text-[0.75rem] text-ink-subtle">
              {t('history.eventCount', { count: formatNumber(data.total) })}
            </span>
          ) : null
        }
        actions={
          <Button variant="secondary" size="md" onClick={reload}>
            {t('history.refresh')}
          </Button>
        }
      />

      <div className="mt-6 flex flex-col gap-2.5 sm:flex-row">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" aria-hidden />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('history.searchPlaceholder')}
            aria-label={t('history.searchAria')}
            className="pl-9"
          />
        </div>
        <Select
          aria-label={t('history.filterAria')}
          className="w-full sm:w-[220px]"
          value={group}
          onChange={(event) => setGroup(event.target.value)}
          options={EVENT_GROUPS.map((item) => ({ value: item.value, label: t(item.labelKey) }))}
        />      </div>

      {error ? (
        <div className="mt-5">
          <Notice
            tone="danger"
            title={t('history.loadError')}
            action={
              <Button size="sm" onClick={reload}>
                {t('common.retry')}
              </Button>
            }
          >
            {error.message}
          </Notice>
        </div>
      ) : null}

      <div className="mt-5">
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-16 rounded-lg" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={<Activity className="size-5" aria-hidden />}
            title={data && data.total > 0 ? t('history.noMatchTitle') : t('history.emptyTitle')}
            description={
              data && data.total > 0
                ? t('history.noMatchDescription')
                : t('history.emptyDescription')
            }
            action={
              <Link to="/investigations/new">
                <Button variant="primary" size="sm">
                  {t('history.createInvestigation')}
                </Button>
              </Link>
            }
          />
        ) : (
          <div className="space-y-6">
            {groupedByDay.map(([day, entries]) => (
              <section key={day}>
                <h2 className="mb-2.5 flex items-center gap-2 text-[0.75rem] font-medium text-ink-subtle">
                  <span className="tnum">{formatDayLabel(day)}</span>
                  <span aria-hidden className="h-px flex-1 bg-hairline" />
                  <span className="text-[0.75rem] text-ink-faint">
                    {t('history.eventsInDay', { count: entries.length })}
                  </span>
                </h2>
                <ul className="panel divide-y divide-hairline/60 overflow-hidden">
                  {entries.map((entry) => {
                    const meta = EVENT_META[entry.eventType] ?? { icon: Activity, tone: 'neutral' as const }
                    const Icon = meta.icon
                    const expanded = expandedId === entry.id
                    const hasMetadata = Object.keys(entry.metadata).length > 0
                    return (
                      <li key={entry.id}>
                        <button
                          type="button"
                          onClick={() => setExpandedId(expanded ? null : entry.id)}
                          aria-expanded={expanded}
                          disabled={!hasMetadata}
                          className={cn(
                            'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors',
                            hasMetadata && 'hover:bg-white/[0.02]',
                          )}
                        >
                          <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-hairline-strong bg-raised">
                            <Icon className="size-3.5 text-ink-subtle" aria-hidden />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="text-[0.8125rem] text-ink-muted">{entry.description}</p>
                              <Badge tone={meta.tone}>{entry.eventType}</Badge>
                            </div>
                            <p className="mt-0.5 text-[0.75rem] text-ink-faint">
                              {formatDateTime(entry.createdAt)} · {formatRelative(entry.createdAt)}
                              {entry.investigationId ? (
                                <Link
                                  to={`/investigations/${entry.investigationId}`}
                                  onClick={(event) => event.stopPropagation()}
                                  className="ml-2 inline-flex min-h-11 items-center text-ink-subtle underline decoration-hairline-strong underline-offset-2 transition-colors hover:text-ink"
                                >
                                  {t('history.viewInvestigation')}
                                </Link>
                              ) : null}
                            </p>
                          </div>
                          {hasMetadata ? (
                            <ChevronDown
                              className={cn('mt-1 size-3.5 shrink-0 text-ink-faint transition-transform', expanded && 'rotate-180')}
                              aria-hidden
                            />
                          ) : null}
                        </button>
                        {expanded && hasMetadata ? (
                          <div className="border-t border-hairline/60 bg-canvas/60 px-4 py-3">
                            <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-[0.75rem] leading-relaxed text-ink-subtle">
                              {JSON.stringify(entry.metadata, null, 2)}
                            </pre>
                          </div>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </PageContainer>
  )
}

/**
 * Day heading for a group.
 *
 * Formats in the locale the interface is currently in, not a fixed one, so the
 * headings change with the language like every other date on the page.
 */
function formatDayLabel(isoDay: string): string {
  const date = new Date(`${isoDay}T12:00:00Z`)
  if (Number.isNaN(date.getTime())) return isoDay
  return new Intl.DateTimeFormat(getActiveIntlLocale(), {
    weekday: 'short',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(date)
}
