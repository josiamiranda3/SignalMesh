import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowDownAZ,
  ArrowUpAZ,
  CalendarClock,
  Filter,
  FlaskConical,
  Plus,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import type { Investigation, InvestigationStatus } from '@shared/domain'
import type { Paginated } from '@shared/api'
import { api } from '@/lib/api'
import { useAsync, useDebounced } from '@/hooks/useAsync'
import { PageContainer, PageHeader } from '@/components/layout/Page'
import {
  Button,
  EmptyState,
  Input,
  InvestigationStatusBadge,
  Notice,
  Select,
  SkeletonTable,
  investigationStatusLabel,
} from '@/components/ui'
import { formatDate, formatRelative, formatNumber } from '@/lib/format'
import { useI18n } from '@/i18n/I18nProvider'
import { cn } from '@/lib/utils'
import { INVESTIGATION_STATUSES } from '@shared/domain'

/**
 * Investigations index.
 *
 * Search, status filter and sort are server-side so the list stays correct for
 * any number of rows; the URL is not stateful, which keeps this screen simple
 * and predictable. Empty states differ for "no investigations yet" versus
 * "nothing matches these filters" — the second is a dead end the user can undo.
 */
export default function InvestigationsPage() {
  const { t } = useI18n()
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'' | InvestigationStatus>('')
  const [sort, setSort] = useState<'updatedAt' | 'createdAt' | 'title'>('updatedAt')
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc')
  const debouncedSearch = useDebounced(search, 280)

  const { data, error, loading, refreshing, reload } = useAsync<Paginated<Investigation>>(
    () =>
      api.get<Paginated<Investigation>>('/api/investigations', {
        search: debouncedSearch || undefined,
        status: status || undefined,
        sort,
        direction,
        limit: 100,
      }),
    [debouncedSearch, status, sort, direction],
  )

  const hasFilters = Boolean(debouncedSearch || status)
  const items = useMemo(() => data?.items ?? [], [data])

  const summary = useMemo(() => {
    if (!data) return null
    const active = items.filter((item) => item.status === 'active').length
    return { total: data.total, active }
  }, [data, items])

  return (
    <PageContainer>
      <PageHeader
        eyebrow={t('investigations.eyebrow')}
        title={t('investigations.title')}
        description={t('investigations.description')}
        actions={
          <Link to="/investigations/new">
            <Button variant="primary" iconLeft={<Plus className="size-4" aria-hidden />}>
              {t('investigations.newInvestigation')}
            </Button>
          </Link>
        }
        meta={
          summary ? (
            <>
              <span className="text-[0.75rem] text-ink-subtle">
                {t(summary.total === 1 ? 'investigations.countOne' : 'investigations.countOther', {
                  count: formatNumber(summary.total),
                })}
              </span>
              <span aria-hidden className="size-1 rounded-full bg-hairline-strong" />
              <span className="text-[0.75rem] text-ink-subtle">
                {t('investigations.activeCount', { count: summary.active })}
              </span>
            </>
          ) : null
        }
      />

      {/* Toolbar */}
      <div className="mt-5 flex flex-col gap-2.5 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" aria-hidden />
          <Input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('investigations.searchPlaceholder')}
            aria-label={t('investigations.searchLabel')}
            className="pl-9"
          />
          {search ? (
            <button
              type="button"
              onClick={() => setSearch('')}
              aria-label={t('investigations.clearSearch')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-ink-faint hover:bg-white/5 hover:text-ink-muted"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:flex-none">
            <Filter className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" aria-hidden />
            <Select
              aria-label={t('investigations.filterLabel')}
              className="w-full pl-8 sm:w-[178px]"
              value={status}
              onChange={(event) => setStatus(event.target.value as '' | InvestigationStatus)}
              options={[
                { value: '', label: t('investigations.allStatuses') },
                ...INVESTIGATION_STATUSES.map((value) => ({
                  value,
                  label: investigationStatusLabel(value),
                })),
              ]}
            />
          </div>

          <div className="relative min-w-0 flex-1 sm:flex-none">
            <CalendarClock className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" aria-hidden />
            <Select
              aria-label={t('investigations.sortLabel')}
              className="w-full pl-8 sm:w-[164px]"
              value={sort}
              onChange={(event) => setSort(event.target.value as typeof sort)}
              options={[
                { value: 'updatedAt', label: t('investigations.sortUpdatedAt') },
                { value: 'createdAt', label: t('investigations.sortCreatedAt') },
                { value: 'title', label: t('investigations.sortTitle') },
              ]}
            />
          </div>

          <Button
            variant="secondary"
            size="icon"
            className="shrink-0"
            aria-label={direction === 'desc' ? t('investigations.directionDesc') : t('investigations.directionAsc')}
            title={direction === 'desc' ? t('investigations.directionDescTitle') : t('investigations.directionAscTitle')}
            onClick={() => setDirection((value) => (value === 'desc' ? 'asc' : 'desc'))}
          >
            {direction === 'desc' ? <ArrowDownAZ className="size-4" aria-hidden /> : <ArrowUpAZ className="size-4" aria-hidden />}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="mt-5">
          <Notice
            tone="danger"
            title={t('investigations.loadError')}
            action={
              <Button size="sm" onClick={reload}>
                {t('investigations.retry')}
              </Button>
            }
          >
            {error.message}
          </Notice>
        </div>
      ) : null}

      <div className={cn('mt-4 transition-opacity', refreshing && 'opacity-60')}>
        {loading ? (
          <SkeletonTable rows={5} />
        ) : items.length === 0 ? (
          hasFilters ? (
            <EmptyState
              icon={<SlidersHorizontal className="size-5" aria-hidden />}
              title={t('investigations.emptyFilteredTitle')}
              description={t('investigations.emptyFilteredDescription')}
              action={
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSearch('')
                    setStatus('')
                  }}
                >
                  {t('investigations.clearFilters')}
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={<FlaskConical className="size-5" aria-hidden />}
              title={t('investigations.emptyTitle')}
              description={t('investigations.emptyDescription')}
              action={
                <Link to="/investigations/new">
                  <Button variant="primary" iconLeft={<Plus className="size-4" aria-hidden />}>
                    {t('investigations.emptyAction')}
                  </Button>
                </Link>
              }
            />
          )
        ) : (
          <div className="panel overflow-hidden">
            <div className="hidden grid-cols-[minmax(0,1fr)_130px_128px_118px] items-center gap-4 border-b border-hairline bg-surface/40 px-5 py-2.5 md:grid">
              <span className="meta-label">{t('investigations.columnInvestigation')}</span>
              <span className="meta-label">{t('investigations.columnStatus')}</span>
              <span className="meta-label">{t('investigations.columnUpdated')}</span>
              <span className="meta-label">{t('investigations.columnCreated')}</span>
            </div>
            <ul className="divide-y divide-hairline/60">
              {items.map((investigation) => (
                <li key={investigation.id}>
                  <Link
                    to={`/investigations/${investigation.id}`}
                    className="group grid grid-cols-1 items-center gap-3 px-5 py-4 transition-colors duration-150 hover:bg-white/[0.028] md:grid-cols-[minmax(0,1fr)_130px_128px_118px] md:gap-4"
                  >
                    <div className="min-w-0">
                      <div className="flex items-start gap-2.5">
                        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-hairline-strong bg-raised">
                          <FlaskConical className="size-3.5 text-ink-subtle" aria-hidden />
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-[0.875rem] font-medium text-ink group-hover:text-white">
                            {investigation.title}
                          </p>
                          <p className="mt-0.5 line-clamp-1 text-[0.75rem] text-ink-faint">
                            {investigation.topic}
                            {investigation.keywords.length > 0 ? ` · ${investigation.keywords.slice(0, 3).join(', ')}` : ''}
                          </p>
                        </div>
                      </div>
                    </div>
                    <div>
                      <InvestigationStatusBadge status={investigation.status} />
                    </div>
                    <span className="text-[0.75rem] text-ink-subtle">{formatRelative(investigation.updatedAt)}</span>
                    <span className="text-[0.75rem] text-ink-faint">{formatDate(investigation.createdAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="border-t border-hairline px-5 py-2.5 text-[0.75rem] text-ink-faint">
              {t('investigations.footerCount', {
                shown: items.length,
                total: formatNumber(data?.total ?? 0),
              })}
            </div>
          </div>
        )}
      </div>
    </PageContainer>
  )
}
