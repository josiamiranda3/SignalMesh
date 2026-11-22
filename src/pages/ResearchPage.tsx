import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  CheckSquare,
  Copy,
  ExternalLink,
  FileText,
  Layers,
  Loader2,
  Search,
  User,
} from 'lucide-react'
import type { InvestigationDetail, ResearchResponse, ResearchResultItem } from '@shared/api'
import { api, ApiError } from '@/lib/api'
import { useAsync } from '@/hooks/useAsync'
import { PageContainer, PageHeader } from '@/components/layout/Page'
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Notice,
  Skeleton,
  useToast,
} from '@/components/ui'
import { formatDate, formatRelative, hostnameOf, safeHref, untilReset } from '@/lib/format'
import { useI18n, type TranslationKey } from '@/i18n/I18nProvider'
import { cn } from '@/lib/utils'

/**
 * Research.
 *
 * Calls Exa through the backend and renders exactly what came back: title, URL,
 * domain, snippet, publication date, author, content availability and the
 * prioritisation index. Results already added to the investigation are marked
 * and cannot be double-added from here. Rate limits, timeouts, empty results and
 * provider failures all have their own designed state.
 */
export default function ResearchPage() {
  const { id = '' } = useParams()
  const toast = useToast()
  const { t } = useI18n()

  const { data: detail, error: detailError, loading: detailLoading } = useAsync<InvestigationDetail>(
    () => api.get<InvestigationDetail>(`/api/investigations/${id}`),
    [id],
  )

  const [query, setQuery] = useState('')
  const [numResults, setNumResults] = useState(8)
  const [includeContent, setIncludeContent] = useState(true)
  const [repeat, setRepeat] = useState(false)

  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<ResearchResponse | null>(null)
  const [failure, setFailure] = useState<ApiError | Error | null>(null)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const [addedCount, setAddedCount] = useState<number | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const investigation = detail?.investigation
  const quota = result?.quota ?? detail?.quota
  const externalDisabled = quota ? !quota.externalApisEnabled : false
  const exhausted = quota ? quota.research.remaining <= 0 : false

  const suggestedQuery = useMemo(() => {
    if (!investigation) return ''
    const keywords = investigation.keywords.slice(0, 6).join(', ')
    return [investigation.topic, keywords ? `foco: ${keywords}` : '', investigation.objective]
      .filter(Boolean)
      .join(' — ')
      .slice(0, 400)
  }, [investigation])

  const results = result?.results ?? []
  const selectable = results.filter((item) => !item.alreadyAdded)

  const runSearch = async (event?: React.FormEvent) => {
    event?.preventDefault()
    setRunning(true)
    setFailure(null)
    setAddedCount(null)
    try {
      const response = await api.post<ResearchResponse>(`/api/investigations/${id}/research`, {
        ...(query.trim() ? { query: query.trim() } : {}),
        numResults,
        includeContent,
        repeat,
      })
      setResult(response)
      setSelected(new Set())
      if (response.results.length === 0) {
        toast.info(t('research.searchEmptyTitle'), t('research.searchEmptyDetail'))
      } else {
        toast.success(
          t('research.searchDoneTitle'),
          t('research.searchDoneDetail', { count: response.results.length }),
        )
      }
    } catch (caught) {
      setFailure(caught instanceof Error ? caught : new Error(t('research.unknownFailure')))
    } finally {
      setRunning(false)
    }
  }

  const toggle = (itemId: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }

  const addSelected = async () => {
    if (!result || selected.size === 0) return
    setAdding(true)
    try {
      const sources = result.results
        .filter((item) => selected.has(item.id) && !item.alreadyAdded)
        .map((item) => ({
          title: item.title,
          url: item.url,
          domain: item.domain,
          snippet: item.snippet,
          retrievedContent: item.retrievedContent,
          publishedAt: item.publishedAt,
          author: item.author,
          providerRequestId: result.providerRequestId,
          contentAvailability: item.contentAvailability,
        }))

      const outcome = await api.post<{
        added: Array<{ id: string }>
        skipped: Array<{ url: string; reason: string }>
      }>(`/api/investigations/${id}/evidence/bulk`, { sources, allowDuplicates: false })

      setAddedCount(outcome.added.length)
      setResult((current) =>
        current
          ? {
              ...current,
              results: current.results.map((item) =>
                selected.has(item.id) ? { ...item, alreadyAdded: true, existingEvidenceId: 'added' } : item,
              ),
            }
          : current,
      )
      setSelected(new Set())
      toast.success(
        t('research.addedToastTitle', { count: outcome.added.length }),
        outcome.skipped.length > 0
          ? t('research.addedToastSkipped', {
              count: outcome.skipped.length,
              reason: outcome.skipped[0]?.reason ?? '',
            })
          : t('research.addedToastNext'),
      )
    } catch (caught) {
      toast.error(t('research.addError'), caught instanceof Error ? caught.message : undefined)
    } finally {
      setAdding(false)
    }
  }

  if (detailLoading) {
    return (
      <PageContainer>
        <Skeleton className="h-3 w-48" />
        <Skeleton className="mt-4 h-8 w-2/5" />
        <Skeleton className="mt-6 h-32 rounded-lg" />
        <Skeleton className="mt-4 h-64 rounded-lg" />
      </PageContainer>
    )
  }

  if (detailError || !detail || !investigation) {
    return (
      <PageContainer>
        <EmptyState
          icon={<AlertTriangle className="size-5" aria-hidden />}
          title={t('research.unavailableTitle')}
          description={detailError?.message ?? t('research.unavailableDescription')}
          action={
            <Link to="/investigations">
              <Button variant="primary">{t('research.back')}</Button>
            </Link>
          }
        />
      </PageContainer>
    )
  }

  return (
    <PageContainer>
      <Link
        to={`/investigations/${id}`}
        className="mb-5 inline-flex min-h-9 items-center gap-1.5 text-[0.75rem] text-ink-subtle transition-colors hover:text-ink"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        {investigation.title}
      </Link>

      <PageHeader
        eyebrow={t('research.eyebrow')}
        title={t('research.title')}
        description={t('research.description')}
        meta={
          quota ? (
            <>
              <span className="text-[0.75rem] text-ink-subtle">
                <span>
                  {t('research.quotaToday', {
                    used: quota.research.used,
                    limit: quota.research.limit,
                  })}
                </span>
              </span>
              <span aria-hidden className="size-1 rounded-full bg-hairline-strong" />
              <span className="text-[0.75rem] text-ink-subtle">
                {exhausted
                  ? t('research.quotaExhausted', { when: untilReset(quota.research.resetsAt) })
                  : t('research.quotaRemaining', { count: quota.research.remaining })}
              </span>
            </>
          ) : null
        }
        actions={
          <Link to={`/investigations/${id}/evidence`}>
            <Button variant="secondary" size="md" iconLeft={<Layers className="size-4" aria-hidden />}>
              {t('research.viewEvidence', { count: detail.evidence.length })}
            </Button>
          </Link>
        }
      />

      {externalDisabled ? (
        <div className="mt-6">
          <Notice
            tone="caution"
            title={t('research.disabledTitle')}
            action={
              <Link to="/settings">
                <Button size="sm" variant="secondary">
                  {t('research.disabledAction')}
                </Button>
              </Link>
            }
          >
            {t('research.disabledDescription')}
          </Notice>
        </div>
      ) : exhausted ? (
        <div className="mt-6">
          <Notice tone="caution" title={t('research.quotaTitle')}>
            {t('research.quotaDescription', { when: untilReset(quota!.research.resetsAt) })}
          </Notice>
        </div>
      ) : null}

      {/* Query form */}
      <form onSubmit={runSearch} className="panel mt-5 p-5">
        <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
          <Field
            label={t('research.queryLabel')}
            hint={t('research.queryHint')}
            counter={`${(query || suggestedQuery).length}/400`}
          >
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={suggestedQuery || t('research.queryPlaceholder')}
              maxLength={400}
              aria-label={t('research.queryAria')}
              disabled={externalDisabled}
            />
          </Field>

          <div className="flex items-end gap-2">
            <Field label={t('research.resultsLabel')}>
              <select
                value={numResults}
                onChange={(event) => setNumResults(Number(event.target.value))}
                aria-label={t('research.resultsAria')}
                disabled={externalDisabled}
                className="h-9.5 w-[92px] rounded-md border border-hairline-strong bg-canvas/80 px-3 text-sm text-ink focus:border-signal focus:outline-none focus:ring-2 focus:ring-signal/20"
              >
                {[5, 8, 10, 15, 20].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </Field>
            <Button
              type="submit"
              variant="primary"
              size="md"
              loading={running}
              disabled={externalDisabled || exhausted}
              iconLeft={running ? undefined : <Search className="size-4" aria-hidden />}
              className="h-9.5"
            >
              {running ? t('research.searching') : t('research.search')}
            </Button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
          <label className="flex min-h-9 cursor-pointer items-center gap-2 text-[0.75rem] text-ink-muted">
            <input
              type="checkbox"
              checked={includeContent}
              onChange={(event) => setIncludeContent(event.target.checked)}
              className="size-4.5 shrink-0 accent-[#B64B50]"
              disabled={externalDisabled}
            />
            {t('research.includeContent')}
          </label>
          <label className="flex min-h-9 cursor-pointer items-center gap-2 text-[0.75rem] text-ink-muted">
            <input
              type="checkbox"
              checked={repeat}
              onChange={(event) => setRepeat(event.target.checked)}
              className="size-4.5 shrink-0 accent-[#B64B50]"
              disabled={externalDisabled}
            />
            {t('research.repeatSearch')}
          </label>
          <span className="text-[0.75rem] text-ink-faint">
            {t('research.quotaNote')}
          </span>
        </div>
      </form>

      {/* Failure state */}
      {failure ? (
        <div className="mt-5">
          <Notice
            tone="danger"
            title={t(failureTitleKey(failure))}
            action={
              <Button size="sm" variant="secondary" onClick={() => setFailure(null)}>
                {t('research.dismiss')}
              </Button>
            }
          >
            <p>{failure.message}</p>
            {failure instanceof ApiError && failure.code === 'rate_limited' ? (
              <p className="mt-2 text-[0.75rem] text-ink-subtle">
                {t('research.repeatHint')}
              </p>
            ) : null}
          </Notice>
        </div>
      ) : null}

      {/* Empty / loading */}
      <div className="mt-5">
        {running ? (
          <ResearchSkeleton />
        ) : !result ? (
          <EmptyState
            icon={<Search className="size-5" aria-hidden />}
            title={t('research.emptyTitle')}
            description={t('research.emptyDescription')}
            action={
              suggestedQuery ? (
                <Button variant="secondary" size="sm" onClick={() => setQuery(suggestedQuery)}>
                  {t('research.useSuggested')}
                </Button>
              ) : undefined
            }
          />
        ) : results.length === 0 ? (
          <EmptyState
            icon={<Search className="size-5" aria-hidden />}
            title={t('research.noResultsTitle')}
            description={t('research.noResultsDescription')}
            compact
          />
        ) : (
          <div className="space-y-4">
            <div className="panel flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-[0.8125rem] text-ink">
                  {t('research.resultsSummary', {
                    count: results.length,
                    when: formatRelative(result.executedAt),
                  })}
                </p>
                <p className="mt-0.5 truncate text-[0.75rem] text-ink-faint" title={result.query}>
                  “{result.query}”
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelected(new Set(selectable.map((item) => item.id)))}
                  disabled={selectable.length === 0}
                >
                  {t('research.selectAll')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
                  {t('research.clearSelection')}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void addSelected()}
                  loading={adding}
                  disabled={selected.size === 0}
                  iconLeft={<Layers className="size-3.5" aria-hidden />}
                >
                  {selected.size > 0
                    ? t('research.addAsEvidence', { count: selected.size })
                    : t('research.addAsEvidenceNone')}
                </Button>
              </div>
            </div>

            <Notice tone="info" title={t('research.contentNoticeTitle')}>
              {result.contentNotice}
              {result.costUsd !== null ? (
                <span className="ml-1 text-ink-subtle">
                  {t('research.costNotice', { cost: result.costUsd.toFixed(4) })}
                </span>
              ) : null}
            </Notice>

            {addedCount !== null && addedCount > 0 ? (
              <Notice
                tone="positive"
                title={t('research.addedTitle', { count: addedCount })}
                action={
                  <Link to={`/investigations/${id}/analysis`}>
                    <Button size="sm" variant="secondary" iconRight={<ArrowRight className="size-3.5" aria-hidden />}>
                      {t('research.requestAnalysis')}
                    </Button>
                  </Link>
                }
              >
                {t('research.addedDescription')}
              </Notice>
            ) : null}

            <ul className="space-y-2.5">
              {results.map((item) => (
                <ResultCard
                  key={item.id}
                  item={item}
                  selected={selected.has(item.id)}
                  onToggle={() => toggle(item.id)}
                  expanded={expanded === item.id}
                  onExpand={() => setExpanded((current) => (current === item.id ? null : item.id))}
                />
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="mt-6">
        <Notice tone="info" title={t('research.aboutTitle')}>
          {t('research.aboutDescription')}
        </Notice>
      </div>
    </PageContainer>
  )
}

function ResultCard({
  item,
  selected,
  onToggle,
  expanded,
  onExpand,
}: {
  item: ResearchResultItem
  selected: boolean
  onToggle: () => void
  expanded: boolean
  onExpand: () => void
}) {
  const href = safeHref(item.url)
  const score = Math.round(item.previewScore * 100)
  const { t } = useI18n()
  const hasFullText = item.contentAvailability.includes('text')

  return (
    <li
      className={cn(
        'panel overflow-hidden transition-colors',
        selected ? 'border-signal/45 bg-signal/[0.035]' : 'hover:border-hairline-strong',
      )}
    >
      <div className="flex gap-3 p-4">
        <button
          type="button"
          onClick={onToggle}
          disabled={item.alreadyAdded}
          aria-pressed={selected}
          aria-label={
            selected
              ? t('research.deselectAria', { title: item.title })
              : t('research.selectAria', { title: item.title })
          }
          className={cn(
            'mt-0.5 flex size-4.5 shrink-0 items-center justify-center rounded border transition-colors',
            item.alreadyAdded
              ? 'cursor-not-allowed border-positive/40 bg-positive/15 text-positive'
              : selected
                ? 'border-signal bg-signal text-white'
                : 'border-hairline-strong text-transparent hover:border-signal/60',
          )}
        >
          {item.alreadyAdded ? <Check className="size-3" aria-hidden /> : selected ? <Check className="size-3" aria-hidden /> : <CheckSquare className="size-3 opacity-0" aria-hidden />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="truncate text-[0.875rem] font-medium text-ink">{item.title}</h3>
                {item.alreadyAdded ? (
                  <Badge tone="positive" dot>
                    {t('research.alreadyAdded')}
                  </Badge>
                ) : null}
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.75rem] text-ink-faint">
                <span className="flex items-center gap-1">
                  <ExternalLink className="size-3" aria-hidden />
                  {item.domain || hostnameOf(item.url)}
                </span>
                {item.publishedAt ? (
                  <span className="flex items-center gap-1">
                    <CalendarDays className="size-3" aria-hidden />
                    {formatDate(item.publishedAt)}
                  </span>
                ) : (
                  <span className="text-ink-faint">{t('research.noPublishedDate')}</span>
                )}
                {item.author ? (
                  <span className="flex items-center gap-1">
                    <User className="size-3" aria-hidden />
                    {item.author}
                  </span>
                ) : null}
                <span className="flex items-center gap-1">
                  <FileText className="size-3" aria-hidden />
                  {hasFullText
                    ? t('research.fullContent')
                    : item.contentAvailability.includes('highlights')
                      ? t('research.snippetsOnly')
                      : t('research.metadataOnly')}
                </span>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-3">
              <div className="text-right">
                <p className="meta-label">{t('research.priority')}</p>
                <p className={cn('tnum text-[0.8125rem] font-semibold', score >= 70 ? 'text-positive' : score >= 45 ? 'text-signal-bright' : 'text-caution')}>
                  {score}
                </p>
              </div>
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="rounded-md border border-hairline-strong bg-raised p-1.5 text-ink-subtle transition-colors hover:border-hairline-strong hover:text-ink"
                  aria-label={t('research.openSourceAria', { title: item.title })}
                  title={t('research.openSource')}
                >
                  <ExternalLink className="size-3.5" aria-hidden />
                </a>
              ) : null}
            </div>
          </div>

          {item.snippet ? (
            <p className={cn('mt-2.5 text-[0.8125rem] leading-relaxed text-ink-muted', !expanded && 'line-clamp-3')}>
              {item.snippet}
            </p>
          ) : (
            <p className="mt-2.5 text-[0.8125rem] italic text-ink-faint">{t('research.noSnippet')}</p>
          )}

          <div className="mt-2.5 flex flex-wrap items-center gap-3">
            {item.retrievedContent ? (
              <button
                type="button"
                onClick={onExpand}
                className="text-[0.75rem] font-medium text-signal-bright transition-colors hover:text-signal"
                aria-expanded={expanded}
              >
                {expanded ? t('research.hideContent') : t('research.showContent')}
              </button>
            ) : null}
            <span className="truncate text-[0.75rem] text-ink-faint">{item.url}</span>
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(item.url)}
              className="flex items-center gap-1 text-[0.75rem] text-ink-faint transition-colors hover:text-ink-muted"
              aria-label={t('research.copyUrl')}
            >
              <Copy className="size-3" aria-hidden />
              {t('research.copy')}
            </button>
          </div>

          {expanded && item.retrievedContent ? (
            <div className="mt-3 max-h-72 overflow-y-auto rounded-md border border-hairline bg-canvas/70 p-3">
              <p className="whitespace-pre-wrap text-[0.75rem] leading-relaxed text-ink-subtle">
                {item.retrievedContent}
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </li>
  )
}

function ResearchSkeleton() {
  const { t } = useI18n()
  return (
    <div className="space-y-2.5">
      <div className="panel flex items-center gap-3 px-5 py-3.5">
        <Loader2 className="size-4 animate-spin text-signal" aria-hidden />
        <p className="text-[0.8125rem] text-ink-muted">{t('research.askingExa')}</p>
      </div>
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="panel p-4">
          <div className="flex gap-3">
            <Skeleton className="size-4.5 rounded" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="h-3 w-3/5" />
              <Skeleton className="h-3 w-full" />
              <Skeleton className="h-3 w-4/5" />
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

/** Maps an API error code to a translation key; no user copy lives here. */
function failureTitleKey(failure: Error): TranslationKey {
  if (failure instanceof ApiError) {
    switch (failure.code) {
      case 'external_disabled':
        return 'research.failureExternalDisabled'
      case 'quota_exceeded':
        return 'research.failureQuota'
      case 'rate_limited':
        return 'research.failureDuplicate'
      case 'provider_auth_failed':
        return 'research.failureAuth'
      case 'provider_rate_limited':
        return 'research.failureProviderRate'
      case 'provider_timeout':
        return 'research.failureTimeout'
      case 'provider_unavailable':
        return 'research.failureUnavailable'
      case 'invalid_provider_response':
        return 'research.failureInvalidResponse'
      default:
        return 'research.failureGeneric'
    }
  }
  return 'research.failureGeneric'
}
