import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowLeft,
  CalendarDays,
  ExternalLink,
  FileText,
  Filter,
  Layers,
  Lightbulb,
  MessageSquare,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import type { Evidence, ValidationStatus } from '@shared/domain'
import type { InvestigationDetail } from '@shared/api'
import { VALIDATION_STATUSES } from '@shared/domain'
import { evidenceCreateSchema } from '@shared/schemas'
import { api } from '@/lib/api'
import { useAsync } from '@/hooks/useAsync'
import { PageContainer, PageHeader } from '@/components/layout/Page'
import { ScoreDial } from '@/components/charts/Charts'
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Input,
  Modal,
  Notice,
  Select,
  Skeleton,
  Textarea,
  ValidationStatusBadge,
  useToast,
  validationLabel,
} from '@/components/ui'
import { formatDateTime, formatNumber, formatRelative, safeHref, truncate } from '@/lib/format'
import { useI18n } from '@/i18n/I18nProvider'
import { cn } from '@/lib/utils'

/**
 * Evidence list.
 *
 * Every row shows the source, its provenance (domain, dates, content
 * availability) and the prioritisation index with an expandable explanation.
 * Notes and deletion live here; the validation decision lives on the dedicated
 * validation screen so the workflow stays legible.
 */
/**
 * Fields of the manual entry form, before they become an API payload.
 *
 * All strings, because they come straight from inputs; the shared schema turns
 * them into the typed contract.
 */
interface ManualEvidenceFormValues {
  title: string
  url: string
  snippet: string
  author: string
  publishedAt: string
}

export default function EvidencePage() {
  const { id = '' } = useParams()
  const toast = useToast()
  const { t } = useI18n()
  const { data, error, loading, reload } = useAsync<InvestigationDetail>(
    () => api.get<InvestigationDetail>(`/api/investigations/${id}`),
    [id],
  )

  const [statusFilter, setStatusFilter] = useState<'' | ValidationStatus>('')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [noteTarget, setNoteTarget] = useState<Evidence | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Evidence | null>(null)
  const [manualOpen, setManualOpen] = useState(false)
  const [manualErrors, setManualErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const evidence = useMemo(() => data?.evidence ?? [], [data])

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return evidence.filter((item) => {
      if (statusFilter && item.validationStatus !== statusFilter) return false
      if (!needle) return true
      return (
        item.title.toLowerCase().includes(needle) ||
        item.domain.toLowerCase().includes(needle) ||
        item.snippet.toLowerCase().includes(needle)
      )
    })
  }, [evidence, statusFilter, search])

  /**
   * Add a hand-entered source.
   *
   * Validation is the shared schema, so the client and the server cannot drift:
   * a field the API would reject is rejected here first, with the field named.
   * A duplicate URL is not an error — the server returns the existing row with
   * `duplicate: true`, and the UI says so instead of pretending it created one.
   */
  const addManualEvidence = async (values: ManualEvidenceFormValues) => {
    const candidate = {
      source: {
        title: values.title.trim(),
        url: values.url.trim(),
        snippet: values.snippet.trim(),
        author: values.author.trim() || null,
        // `<input type="date">` yields `YYYY-MM-DD`; the contract wants an ISO
        // timestamp, so it is anchored at midnight UTC rather than sending a
        // bare date the server would reject.
        publishedAt: values.publishedAt ? `${values.publishedAt}T00:00:00.000Z` : null,
      },
      allowDuplicate: false,
    }

    const parsed = evidenceCreateSchema.safeParse(candidate)
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        // `source.title` → `title`, so the message lands on the right field.
        const key = issue.path.filter((part) => part !== 'source').join('.') || 'title'
        if (!fieldErrors[key]) fieldErrors[key] = issue.message
      }
      setManualErrors(fieldErrors)
      return
    }

    setManualErrors({})
    setBusy(true)
    try {
      const result = await api.post<{ evidence: Evidence; duplicate?: boolean }>(
        `/api/investigations/${id}/evidence`,
        parsed.data,
      )
      if (result.duplicate) {
        toast.info(t('evidence.alreadyTitle'), t('evidence.alreadyDetail'))
      } else {
        toast.success(
        t('evidence.addedToastTitle'),
        t('evidence.addedToastDetail', { title: result.evidence.title }),
      )
      }
      setManualOpen(false)
      reload()
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : undefined
      toast.error(t('evidence.addError'), message)
      // A server rejection is surfaced in the dialog too, so the user does not
      // have to re-open it after reading a transient toast.
      setManualErrors({ title: message ?? 'Falha ao salvar. Tente novamente.' })
    } finally {
      setBusy(false)
    }
  }

  const saveNote = async (note: string) => {
    if (!noteTarget) return
    setBusy(true)
    try {
      await api.patch(`/api/evidence/${noteTarget.id}`, { note })
      toast.success(t('evidence.noteSaved'))
      setNoteTarget(null)
      reload()
    } catch (caught) {
      toast.error(t('evidence.noteError'), caught instanceof Error ? caught.message : undefined)
    } finally {
      setBusy(false)
    }
  }

  const removeEvidence = async () => {
    if (!deleteTarget) return
    setBusy(true)
    try {
      await api.delete(`/api/evidence/${deleteTarget.id}`)
      toast.success(t('evidence.deletedTitle'), t('evidence.deletedDetail'))
      setDeleteTarget(null)
      reload()
    } catch (caught) {
      toast.error(t('evidence.deleteError'), caught instanceof Error ? caught.message : undefined)
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <PageContainer>
        <Skeleton className="h-3 w-48" />
        <Skeleton className="mt-4 h-8 w-2/5" />
        <div className="mt-6 space-y-2.5">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-28 rounded-lg" />
          ))}
        </div>
      </PageContainer>
    )
  }

  if (error || !data) {
    return (
      <PageContainer>
        <EmptyState
          icon={<AlertTriangle className="size-5" aria-hidden />}
          title={t('evidence.unavailableTitle')}
          description={error?.message ?? t('evidence.unavailableDescription')}
          action={
            <Link to="/investigations">
              <Button variant="primary">{t('common.back')}</Button>
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
        {data.investigation.title}
      </Link>

      <PageHeader
        eyebrow={t('evidence.eyebrow')}
        title={t('evidence.title')}
        description={t('evidence.description')}
        meta={
          <>
            <span className="text-[0.75rem] text-ink-subtle">
              {t('evidence.countLabel', { count: formatNumber(evidence.length) })}
            </span>
            <span aria-hidden className="size-1 rounded-full bg-hairline-strong" />
            <span className="text-[0.75rem] text-ink-subtle">
              {data.counts.byValidationStatus['accepted'] ?? 0} aprovada(s)
            </span>
            <span aria-hidden className="size-1 rounded-full bg-hairline-strong" />
            <span className="text-[0.75rem] text-ink-subtle">
              {data.counts.byValidationStatus['pending'] ?? 0} pendente(s)
            </span>
          </>
        }
        actions={
          <>
            <Button
              variant="secondary"
              size="md"
              onClick={() => {
                setManualErrors({})
                setManualOpen(true)
              }}
              iconLeft={<FileText className="size-4" aria-hidden />}
            >
              {t('evidence.addManual')}
            </Button>
            <Link to={`/investigations/${id}/research`}>
              <Button variant="secondary" size="md" iconLeft={<Search className="size-4" aria-hidden />}>
                {t('evidence.searchMore')}
              </Button>
            </Link>
            <Link to={`/investigations/${id}/validation`}>
              <Button variant="primary" size="md">
                {t('evidence.validate')}
              </Button>
            </Link>
          </>
        }
      />

      {evidence.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={<Layers className="size-5" aria-hidden />}
            title={t('evidence.emptyTitle')}
            description={t('evidence.emptyDescription')}
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button
                  variant="primary"
                  onClick={() => {
                    setManualErrors({})
                    setManualOpen(true)
                  }}
                  iconLeft={<FileText className="size-4" aria-hidden />}
                >
                  {t('evidence.addManual')}
                </Button>
                <Link to={`/investigations/${id}/research`}>
                  <Button variant="secondary" iconLeft={<Search className="size-4" aria-hidden />}>
                    Executar pesquisa
                  </Button>
                </Link>
              </div>
            }
          />
        </div>
      ) : (
        <>
          <div className="mt-6 flex flex-col gap-2.5 sm:flex-row">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" aria-hidden />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t('evidence.searchPlaceholder')}
                aria-label={t('evidence.searchAria')}
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
            <div className="relative sm:w-[188px]">
              <Filter className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" aria-hidden />
              <Select
                aria-label={t('evidence.filterAria')}
                className="w-full pl-8"
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as '' | ValidationStatus)}
                options={[
                  { value: '', label: 'Todos os status' },
                  ...VALIDATION_STATUSES.map((status) => ({ value: status, label: validationLabel(status) })),
                ]}
              />
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="mt-5">
              <EmptyState
                compact
                icon={<Filter className="size-5" aria-hidden />}
                title={t('evidence.noMatchTitle')}
                description={t('evidence.noMatchDescription')}
                action={
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setSearch('')
                      setStatusFilter('')
                    }}
                  >
                    Limpar filtros
                  </Button>
                }
              />
            </div>
          ) : (
            <ul className="mt-5 space-y-2.5">
              {filtered.map((item) => (
                <EvidenceRow
                  key={item.id}
                  evidence={item}
                  investigationId={id}
                  expanded={expanded === item.id}
                  onExpand={() => setExpanded((current) => (current === item.id ? null : item.id))}
                  onNote={() => setNoteTarget(item)}
                  onDelete={() => setDeleteTarget(item)}
                />
              ))}
            </ul>
          )}
        </>
      )}

      <ManualEvidenceModal
        open={manualOpen}
        busy={busy}
        errors={manualErrors}
        onClose={() => setManualOpen(false)}
        onSubmit={(values) => void addManualEvidence(values)}
      />

      <NoteModal
        evidence={noteTarget}
        busy={busy}
        onClose={() => setNoteTarget(null)}
        onSave={(note) => void saveNote(note)}
      />

      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title={t('evidence.deleteTitle')}
        description={t('evidence.deleteDescription')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              {t('common.cancelAction')}
            </Button>
            <Button variant="danger" onClick={() => void removeEvidence()} loading={busy}>
              {t('common.deleteAction')}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-[0.8125rem] leading-relaxed text-ink-muted">
          <p className="font-medium text-ink">{deleteTarget?.title}</p>
          <p className="break-all text-[0.75rem] text-ink-faint">{deleteTarget?.url}</p>
          <Notice tone="caution">
            {t('evidence.deleteNote')}
          </Notice>
        </div>
      </Modal>
    </PageContainer>
  )
}

function EvidenceRow({
  evidence,
  investigationId,
  expanded,
  onExpand,
  onNote,
  onDelete,
}: {
  evidence: Evidence
  investigationId: string
  expanded: boolean
  onExpand: () => void
  onNote: () => void
  onDelete: () => void
}) {
  const { t } = useI18n()
  const href = safeHref(evidence.url)
  const hasContent = Boolean(evidence.retrievedContent)

  return (
    <li className="panel overflow-hidden">
      <div className="p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="flex shrink-0 items-center gap-3 sm:flex-col sm:items-center">
            <ScoreDial score={evidence.relevanceScore} size={46} />
            <span className="text-[0.75rem] text-ink-faint sm:hidden">prioridade</span>
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-[0.875rem] font-medium leading-snug text-ink">{evidence.title}</h3>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.75rem] text-ink-faint">
                  <span className="flex items-center gap-1">
                    <ExternalLink className="size-3" aria-hidden />
                    {evidence.domain || t('evidence.unknownDomain')}
                  </span>
                  <span className="flex items-center gap-1">
                    <CalendarDays className="size-3" aria-hidden />
                    {evidence.publishedAt ? formatDateTime(evidence.publishedAt) : t('evidence.noPublishedDate')}
                  </span>
                  <span>{t('evidence.collected', { when: formatRelative(evidence.collectedAt) })}</span>
                  <span className="flex items-center gap-1">
                    <FileText className="size-3" aria-hidden />
                    {hasContent ? t('evidence.fullContent') : t('evidence.snippetOnly')}
                  </span>
                </div>
              </div>
              <ValidationStatusBadge status={evidence.validationStatus} />
            </div>

            {evidence.snippet ? (
              <p className={cn('mt-2.5 text-[0.8125rem] leading-relaxed text-ink-muted', !expanded && 'line-clamp-2')}>
                {evidence.snippet}
              </p>
            ) : null}

            {evidence.note ? (
              <div className="mt-2.5 flex gap-2 rounded-md border border-hairline bg-raised/40 px-2.5 py-2">
                <MessageSquare className="mt-0.5 size-3 shrink-0 text-ink-faint" aria-hidden />
                <p className="text-[0.75rem] leading-relaxed text-ink-subtle">{truncate(evidence.note, 240)}</p>
              </div>
            ) : null}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              {href ? (
                <a href={href} target="_blank" rel="noopener noreferrer nofollow">
                  <Button variant="ghost" size="sm" iconLeft={<ExternalLink className="size-3" aria-hidden />}>
                    {t('research.openSource')}
                  </Button>
                </a>
              ) : (
                <Badge tone="negative">{t('evidence.invalidUrl')}</Badge>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={onExpand}
                aria-expanded={expanded}
                iconLeft={<Lightbulb className="size-3" aria-hidden />}
              >
                {expanded ? t('evidence.hidePriority') : t('evidence.showPriority')}
              </Button>
              <Button variant="ghost" size="sm" onClick={onNote} iconLeft={<MessageSquare className="size-3" aria-hidden />}>
                {evidence.note ? t('evidence.editNote') : t('evidence.addNote')}
              </Button>
              <Link to={`/investigations/${investigationId}/validation`}>
                <Button variant="ghost" size="sm">
                  {t('evidence.validateOne')}
                </Button>
              </Link>
              <Button
                variant="quiet"
                size="sm"
                onClick={onDelete}
                className="ml-auto text-ink-faint hover:text-negative"
                iconLeft={<Trash2 className="size-3" aria-hidden />}
              >
                {t('common.remove')}
              </Button>
            </div>
          </div>
        </div>

        {expanded ? (
          <div className="mt-4 grid gap-4 border-t border-hairline pt-4 lg:grid-cols-2">
            <div>
              <p className="meta-label mb-2">{t('evidence.breakdownTitle')}</p>
              {evidence.relevanceBreakdown ? (
                <dl className="space-y-2">
                  {[
                    { key: 'topical', label: t('evidence.breakdownTopical'), value: evidence.relevanceBreakdown.topical },
                    { key: 'recency', label: t('evidence.breakdownRecency'), value: evidence.relevanceBreakdown.recency },
                    { key: 'sourceQuality', label: t('evidence.breakdownSourceQuality'), value: evidence.relevanceBreakdown.sourceQuality },
                    { key: 'objectiveAlignment', label: t('evidence.breakdownObjective'), value: evidence.relevanceBreakdown.objectiveAlignment },
                  ].map((component) => (
                    <div key={component.key} className="flex items-center gap-2.5">
                      <dt className="w-40 shrink-0 text-[0.75rem] text-ink-subtle">{component.label}</dt>
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#1a222c]">
                        <div
                          className="h-full rounded-full bg-signal/70"
                          style={{ width: `${(component.value ?? 0) * 100}%` }}
                        />
                      </div>
                      <dd className="tnum w-10 text-right text-[0.75rem] text-ink-muted">
                        {component.value === null ? 'n/d' : component.value.toFixed(2)}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="text-[0.75rem] text-ink-faint">{t('evidence.noPriorityData')}</p>
              )}
            </div>

            <div>
              <p className="meta-label mb-2">{t('evidence.rationaleTitle')}</p>
              <ul className="space-y-1.5">
                {(evidence.relevanceBreakdown?.rationale ?? [t('evidence.noRationale')]).map((reason, index) => (
                  <li key={index} className="flex gap-2 text-[0.75rem] leading-relaxed text-ink-subtle">
                    <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-hairline-strong" />
                    {reason}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[0.75rem] leading-relaxed text-ink-faint">
                {t('evidence.indexNote')}
              </p>
            </div>
          </div>
        ) : null}

        {expanded && evidence.retrievedContent ? (
          <div className="mt-3 max-h-64 overflow-y-auto rounded-md border border-hairline bg-canvas/70 p-3">
            <p className="whitespace-pre-wrap text-[0.75rem] leading-relaxed text-ink-subtle">
              {truncate(evidence.retrievedContent, 6000)}
            </p>
          </div>
        ) : null}
      </div>
    </li>
  )
}

/**
 * Manual evidence entry.
 *
 * The only creation path that does not need a provider: the researcher types the
 * source directly. It posts to the same endpoint the API exposes
 * (`POST /api/investigations/:id/evidence`), so validation, ownership, duplicate
 * protection and persistence are the ones the server already enforces — this
 * form adds no rules of its own beyond the shared schema below.
 */
function ManualEvidenceModal({
  open,
  busy,
  errors,
  onClose,
  onSubmit,
}: {
  open: boolean
  busy: boolean
  errors: Record<string, string>
  onClose: () => void
  onSubmit: (input: ManualEvidenceFormValues) => void
}) {
  const [title, setTitle] = useState('')
  const { t } = useI18n()
  const [url, setUrl] = useState('')
  const [snippet, setSnippet] = useState('')
  const [author, setAuthor] = useState('')
  const [publishedAt, setPublishedAt] = useState('')

  const reset = () => {
    setTitle('')
    setUrl('')
    setSnippet('')
    setAuthor('')
    setPublishedAt('')
  }

  return (
    <Modal
      open={open}
      onClose={() => {
        reset()
        onClose()
      }}
      title={t('evidence.manualTitle')}
      description={t('evidence.manualDescription')}
      size="lg"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              reset()
              onClose()
            }}
          >
            {t('common.cancelAction')}
          </Button>
          <Button variant="primary" type="submit" form="evidence-manual-form" loading={busy}>
            {t('evidence.manualAction')}
          </Button>
        </>
      }
    >
      <form
        id="evidence-manual-form"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          onSubmit({
            title,
            url,
            snippet,
            author,
            publishedAt,
          })
        }}
      >
        <Field
          label={t('evidence.sourceTitleLabel')}
          error={errors['title']}
          counter={`${title.length}/400`}
          hint={t('evidence.sourceTitleHint')}
        >
          <Input
            value={title}
            maxLength={400}
            onChange={(event) => setTitle(event.target.value)}
            invalid={Boolean(errors['title'])}
            placeholder={t('evidence.sourceTitlePlaceholder')}
            aria-label={t('evidence.sourceTitleAria')}
            autoFocus
          />
        </Field>

        <Field
          label={t('evidence.sourceUrlLabel')}
          error={errors['url']}
          hint={t('evidence.sourceUrlHint')}
        >
          <Input
            value={url}
            maxLength={2048}
            onChange={(event) => setUrl(event.target.value)}
            invalid={Boolean(errors['url'])}
            placeholder={t('evidence.sourceUrlPlaceholder')}
            aria-label={t('evidence.sourceUrlAria')}
            inputMode="url"
            autoComplete="off"
          />
        </Field>

        <Field label={t('evidence.snippetLabel')} optional error={errors['snippet']} counter={`${snippet.length}/8000`}>
          <Textarea
            value={snippet}
            maxLength={8000}
            rows={4}
            onChange={(event) => setSnippet(event.target.value)}
            invalid={Boolean(errors['snippet'])}
            placeholder={t('evidence.snippetPlaceholder')}
            aria-label={t('evidence.snippetAria')}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('evidence.authorLabel')} optional error={errors['author']}>
            <Input
              value={author}
              maxLength={300}
              onChange={(event) => setAuthor(event.target.value)}
              invalid={Boolean(errors['author'])}
              placeholder={t('evidence.authorPlaceholder')}
              aria-label={t('evidence.authorAria')}
            />
          </Field>

          <Field label={t('evidence.publishedAtLabel')} optional error={errors['publishedAt']}>
            <Input
              type="date"
              value={publishedAt}
              onChange={(event) => setPublishedAt(event.target.value)}
              invalid={Boolean(errors['publishedAt'])}
              aria-label={t('evidence.publishedAtAria')}
            />
          </Field>
        </div>
      </form>
    </Modal>
  )
}

function NoteModal({
  evidence,
  busy,
  onClose,
  onSave,
}: {
  evidence: Evidence | null
  busy: boolean
  onClose: () => void
  onSave: (note: string) => void
}) {
  const { t } = useI18n()
  return (
    <Modal
      open={Boolean(evidence)}
      onClose={onClose}
      title={t('evidence.noteTitle')}
      description={t('evidence.noteDescription')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancelAction')}
          </Button>
          <Button variant="primary" type="submit" form="evidence-note-form" loading={busy}>
            {t('evidence.noteSave')}
          </Button>
        </>
      }
    >
      <form
        id="evidence-note-form"
        key={evidence?.id ?? 'empty'}
        onSubmit={(event) => {
          event.preventDefault()
          const form = event.currentTarget
          const value = (form.elements.namedItem('note') as HTMLTextAreaElement | null)?.value ?? ''
          onSave(value)
        }}
      >
        <Field label={t('evidence.noteLabel')}>
          <Textarea
            name="note"
            defaultValue={evidence?.note ?? ''}
            rows={5}
            maxLength={4000}
            placeholder={t('evidence.notePlaceholder')}
          />
        </Field>
      </form>
    </Modal>
  )
}
