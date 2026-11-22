import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  AlertTriangle,
  Archive,
  ArrowRight,
  BadgeCheck,
  CheckCircle2,
  Download,
  FileJson,
  Layers,
  Pencil,
  Play,
  Sparkles,
  Trash2,
} from 'lucide-react'
import type { Investigation, InvestigationStatus } from '@shared/domain'
import type { InvestigationDetail } from '@shared/api'
import { INVESTIGATION_STATUSES } from '@shared/domain'
import { investigationUpdateSchema } from '@shared/schemas'
import { api, ApiError, downloadFile, fieldErrorKey } from '@/lib/api'
import { useAsync } from '@/hooks/useAsync'
import { useI18n } from '@/i18n/I18nProvider'
import { Breadcrumbs, PageContainer, PageHeader, SectionHeader } from '@/components/layout/Page'
import { InlineStat } from '@/components/dashboard/MetricCard'
import {
  Button,
  EmptyState,
  Field,
  Input,
  KeywordEditor,
  InvestigationStatusBadge,
  Modal,
  Notice,
  Select,
  Skeleton,
  Textarea,
  investigationStatusLabel,
  useToast,
  validationLabel,
} from '@/components/ui'
import { formatDate, formatDateTime, formatNumber, formatRelative } from '@/lib/format'

/**
 * Investigation detail.
 *
 * The control centre for one investigation: read the objective, see counts by
 * validation status, jump into research / evidence / analysis / validation, and
 * manage the record (edit, change status, archive, export, delete). Destructive
 * actions are two-step and state exactly what will be removed.
 */
export default function InvestigationDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const toast = useToast()
  const { t } = useI18n()
  const { data, error, loading, reload } = useAsync<InvestigationDetail>(
    () => api.get<InvestigationDetail>(`/api/investigations/${id}`),
    [id],
  )

  const [editOpen, setEditOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  if (loading) {
    return (
      <PageContainer>
        <Skeleton className="h-3 w-40" />
        <Skeleton className="mt-4 h-8 w-2/5" />
        <Skeleton className="mt-3 h-4 w-3/5" />
        <div className="mt-6 grid gap-4 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-24 rounded-lg" />
          ))}
        </div>
        <Skeleton className="mt-5 h-64 rounded-lg" />
      </PageContainer>
    )
  }

  if (error || !data) {
    return (
      <PageContainer>
        <EmptyState
          icon={<AlertTriangle className="size-5" aria-hidden />}
          title={t('detail.notFoundTitle')}
          description={
            error?.message ??
            t('detail.notFoundDescription')
          }
          action={
            <Link to="/investigations">
              <Button variant="primary">{t('detail.backToInvestigations')}</Button>
            </Link>
          }
        />
      </PageContainer>
    )
  }

  const { investigation, counts, evidence, analyses } = data
  const latestAnalysis = analyses.find((analysis) => analysis.status === 'completed')
  const pending = (counts.byValidationStatus['pending'] ?? 0) + (counts.byValidationStatus['needs_review'] ?? 0)

  const changeStatus = async (status: InvestigationStatus) => {
    setBusy(`status:${status}`)
    try {
      await api.post(`/api/investigations/${id}/status`, { status })
      toast.success(
        t('detail.statusUpdated'),
        t('detail.statusUpdatedDetail', { status: investigationStatusLabel(status).toLowerCase() }),
      )
      reload()
    } catch (caught) {
      toast.error(t('detail.statusUpdateError'), caught instanceof Error ? caught.message : undefined)
    } finally {
      setBusy(null)
    }
  }

  const archive = async () => {
    setBusy('archive')
    try {
      await api.post(`/api/investigations/${id}/archive`)
      toast.success(t('detail.archivedTitle'), t('detail.archivedDescription'))
      reload()
    } catch (caught) {
      toast.error(t('detail.archiveError'), caught instanceof Error ? caught.message : undefined)
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    setBusy('delete')
    try {
      await api.delete(`/api/investigations/${id}`)
      toast.success(t('detail.deletedTitle'), t('detail.deletedDescription'))
      navigate('/investigations', { replace: true })
    } catch (caught) {
      toast.error(t('detail.deleteError'), caught instanceof Error ? caught.message : undefined)
      setBusy(null)
    }
  }

  return (
    <PageContainer>
      <Breadcrumbs
        items={[{ label: t('investigations.title'), to: '/investigations' }, { label: investigation.title }]}
      />

      <PageHeader
        eyebrow={t('detail.eyebrow')}
        title={investigation.title}
        description={investigation.description || investigation.topic}
        meta={
          <>
            <InvestigationStatusBadge status={investigation.status} />
            <span className="text-[0.75rem] text-ink-subtle">
              {t('detail.createdAt', { date: formatDate(investigation.createdAt) })}
            </span>
            <span aria-hidden className="size-1 rounded-full bg-hairline-strong" />
            <span className="text-[0.75rem] text-ink-subtle">
              {t('detail.updatedAt', { when: formatRelative(investigation.updatedAt) })}
            </span>
          </>
        }
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => setEditOpen(true)} iconLeft={<Pencil className="size-3.5" aria-hidden />}>
              {t('detail.edit')}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setExportOpen(true)} iconLeft={<Download className="size-3.5" aria-hidden />}>
              {t('detail.export')}
            </Button>
            <Link to={`/investigations/${id}/research`}>
              <Button variant="primary" size="sm" iconLeft={<Play className="size-3.5" aria-hidden />}>
                {t('detail.research')}
              </Button>
            </Link>
          </>
        }
      />

      {/* Objective — the anchor of the whole investigation */}
      <section className="panel mt-6 p-5" aria-labelledby="objective-heading">
        <h2 id="objective-heading" className="eyebrow">
          {t('detail.objectiveHeading')}
        </h2>
        <p className="mt-2 text-pretty text-[0.875rem] leading-relaxed text-ink-muted">{investigation.objective}</p>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span className="text-[0.75rem] text-ink-subtle">
            <span className="meta-label mr-1.5">{t('detail.topicLabel')}</span>
            {investigation.topic}
          </span>
          {investigation.keywords.length > 0 ? (
            <span className="text-[0.75rem] text-ink-subtle">
              <span className="meta-label mr-1.5">{t('detail.keywordsLabel')}</span>
              {investigation.keywords.join(' · ')}
            </span>
          ) : null}
        </div>
      </section>

      {/* Counts */}
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="panel p-4">
          <InlineStat label={t('detail.statEvidence')} value={formatNumber(counts.evidence)} />
          <p className="mt-2 text-[0.75rem] text-ink-faint">
            {t('detail.statEvidenceHint', { count: pending })}
          </p>
        </div>
        <div className="panel p-4">
          <InlineStat
            label={t('detail.statAccepted')}
            value={formatNumber(counts.byValidationStatus['accepted'] ?? 0)}
            tone="positive"
          />
          <p className="mt-2 text-[0.75rem] text-ink-faint">{t('detail.statAcceptedHint')}</p>
        </div>
        <div className="panel p-4">
          <InlineStat label={t('detail.statAnalyses')} value={formatNumber(counts.analyses)} tone="signal" />
          <p className="mt-2 text-[0.75rem] text-ink-faint">
            {latestAnalysis
              ? t('detail.statLastAnalysis', { date: formatDate(latestAnalysis.createdAt) })
              : t('detail.statNoAnalysis')}
          </p>
        </div>
        <div className="panel p-4">
          <InlineStat label={t('detail.statValidations')} value={formatNumber(counts.validations)} />
          <p className="mt-2 text-[0.75rem] text-ink-faint">{t('detail.statValidationsHint')}</p>
        </div>
      </div>

      {/* Workflow shortcuts */}
      <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <WorkflowCard
          to={`/investigations/${id}/research`}
          icon={<Play className="size-4" aria-hidden />}
          step="01"
          title={t('detail.workflowResearch')}
          description={t('detail.workflowResearchDescription')}
          footer={
            evidence.length === 0 ? t('detail.workflowResearchStart') : t('detail.workflowResearchRun')
          }
        />
        <WorkflowCard
          to={`/investigations/${id}/evidence`}
          icon={<Layers className="size-4" aria-hidden />}
          step="02"
          title={t('detail.workflowEvidence')}
          description={t('detail.workflowEvidenceDescription')}
          footer={t('detail.workflowEvidenceCount', { count: formatNumber(counts.evidence) })}
        />
        <WorkflowCard
          to={`/investigations/${id}/analysis`}
          icon={<Sparkles className="size-4" aria-hidden />}
          step="03"
          title={t('detail.workflowAnalysis')}
          description={t('detail.workflowAnalysisDescription')}
          footer={latestAnalysis ? t('detail.workflowAnalysisView') : t('detail.workflowAnalysisEmpty')}
        />
        <WorkflowCard
          to={`/investigations/${id}/validation`}
          icon={<BadgeCheck className="size-4" aria-hidden />}
          step="04"
          title={t('detail.workflowValidation')}
          description={t('detail.workflowValidationDescription')}
          footer={t('detail.workflowValidationPending', { count: pending })}
        />
      </div>

      {/* Recent evidence + activity */}
      <div className="mt-4 grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        <section className="panel overflow-hidden" aria-labelledby="recent-evidence">
          <div className="flex items-center justify-between border-b border-hairline px-5 py-3.5">
            <h2 id="recent-evidence" className="text-[0.9375rem] font-semibold text-ink">
              {t('detail.recentEvidence')}
            </h2>
            <Link
              to={`/investigations/${id}/evidence`}
              className="flex min-h-9 items-center gap-1 text-[0.75rem] text-ink-subtle transition-colors hover:text-ink"
            >
              {t('dashboard.viewAll')}
              <ArrowRight className="size-3" aria-hidden />
            </Link>
          </div>
          {evidence.length === 0 ? (
            <div className="px-5 py-10">
              <EmptyState
                compact
                icon={<Layers className="size-5" aria-hidden />}
                title={t('detail.recentEvidenceEmpty')}
                description={t('detail.recentEvidenceEmptyDescription')}
                action={
                  <Link to={`/investigations/${id}/research`}>
                    <Button variant="primary" size="sm">
                      {t('detail.recentEvidenceAction')}
                    </Button>
                  </Link>
                }
              />
            </div>
          ) : (
            <ul className="divide-y divide-hairline/60">
              {evidence.slice(0, 5).map((item) => (
                <li key={item.id} className="px-5 py-3">
                  <p className="truncate text-[0.8125rem] font-medium text-ink">{item.title}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.75rem] text-ink-faint">
                    <span>{item.domain || t('detail.unknownDomain')}</span>
                    <span aria-hidden>·</span>
                    <span>{validationLabel(item.validationStatus)}</span>
                    {item.relevanceScore !== null ? (
                      <>
                        <span aria-hidden>·</span>
                        <span className="tnum">
                          {t('detail.priority', { score: Math.round(item.relevanceScore * 100) })}
                        </span>
                      </>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel overflow-hidden" aria-labelledby="investigation-activity">
          <div className="flex items-center justify-between border-b border-hairline px-5 py-3.5">
            <h2 id="investigation-activity" className="text-[0.9375rem] font-semibold text-ink">
              {t('detail.activityTitle')}
            </h2>
            <Link to="/history" className="inline-flex min-h-9 items-center text-[0.75rem] text-ink-subtle transition-colors hover:text-ink">
              {t('nav.history')}
            </Link>
          </div>
          {data.activity.length === 0 ? (
            <p className="px-5 py-8 text-center text-[0.8125rem] text-ink-faint">
              {t('detail.activityEmpty')}
            </p>
          ) : (
            <ol className="divide-y divide-hairline/60">
              {data.activity.slice(0, 7).map((entry) => (
                <li key={entry.id} className="px-5 py-2.5">
                  <p className="text-[0.78125rem] leading-snug text-ink-muted">{entry.description}</p>
                  <p className="mt-0.5 text-[0.75rem] text-ink-faint">{formatDateTime(entry.createdAt)}</p>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      {/* Management */}
      <section className="panel mt-5 p-5" aria-labelledby="manage-heading">
        <SectionHeader
          title={t('detail.manageTitle')}
          description={t('detail.manageDescription')}
        />
        <div id="manage-heading" className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="w-full max-w-xs">
            <Field label={t('detail.manageStatusLabel')} hint={t('detail.manageStatusHint')}>
              <Select
                aria-label={t('detail.manageStatusAria')}
                value={investigation.status}
                disabled={busy !== null}
                onChange={(event) => void changeStatus(event.target.value as InvestigationStatus)}
                options={INVESTIGATION_STATUSES.map((status) => ({
                  value: status,
                  label: investigationStatusLabel(status),
                }))}
              />
            </Field>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void archive()}
              loading={busy === 'archive'}
              disabled={investigation.status === 'archived'}
              iconLeft={<Archive className="size-3.5" aria-hidden />}
            >
              {t('detail.archiveButton')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => setDeleteOpen(true)}
              iconLeft={<Trash2 className="size-3.5" aria-hidden />}
            >
              {t('detail.deleteButton')}
            </Button>
          </div>
        </div>
      </section>

      <EditInvestigationModal
        open={editOpen}
        investigation={investigation}
        onClose={() => setEditOpen(false)}
        onSaved={() => {
          setEditOpen(false)
          reload()
          toast.success(t('detail.savedTitle'))
        }}
      />

      <ExportModal
        open={exportOpen}
        investigationId={id}
        onClose={() => setExportOpen(false)}
        onExported={(filename) => toast.success(t('detail.exportedTitle'), filename)}
        onError={(message) => toast.error(t('detail.exportFailure'), message)}
      />

      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={t('detail.deleteConfirmTitle')}
        description={t('detail.deleteConfirmDescription')}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              {t('detail.cancel')}
            </Button>
            <Button variant="danger" onClick={() => void remove()} loading={busy === 'delete'}>
              {t('detail.deleteConfirm')}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-[0.8125rem] leading-relaxed text-ink-muted">
          <p>
            {t('detail.deleteSummary', {
              evidence: formatNumber(counts.evidence),
              analyses: formatNumber(counts.analyses),
              validations: formatNumber(counts.validations),
            })}
          </p>
          <Notice tone="caution">{t('detail.deleteNote')}</Notice>
        </div>
      </Modal>
    </PageContainer>
  )
}

function WorkflowCard({
  to,
  icon,
  step,
  title,
  description,
  footer,
}: {
  to: string
  icon: React.ReactNode
  step: string
  title: string
  description: string
  footer: string
}) {
  return (
    <Link
      to={to}
      className="group panel flex flex-col p-4 transition-colors hover:border-hairline-strong hover:bg-raised/40"
    >
      <div className="flex items-center justify-between">
        <div className="flex size-8 items-center justify-center rounded-md border border-hairline-strong bg-raised text-signal-bright">
          {icon}
        </div>
        <span className="tnum text-[0.75rem] font-semibold text-ink-faint">{step}</span>
      </div>
      <p className="mt-3 text-[0.8125rem] font-medium text-ink">{title}</p>
      <p className="mt-1 flex-1 text-[0.75rem] leading-relaxed text-ink-subtle">{description}</p>
      <p className="mt-3 flex items-center gap-1 text-[0.75rem] text-ink-faint transition-colors group-hover:text-signal-bright">
        {footer}
        <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
      </p>
    </Link>
  )
}

function EditInvestigationModal({
  open,
  investigation,
  onClose,
  onSaved,
}: {
  open: boolean
  investigation: Investigation
  onClose: () => void
  onSaved: () => void
}) {
  const [title, setTitle] = useState(investigation.title)
  const [topic, setTopic] = useState(investigation.topic)
  const [objective, setObjective] = useState(investigation.objective)
  const [description, setDescription] = useState(investigation.description)
  const { t } = useI18n()
  // Seeded from the saved investigation, so opening and saving without touching
  // the chips submits the existing list unchanged.
  const [keywords, setKeywords] = useState<string[]>(investigation.keywords)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const submit = async () => {
    setFormError(null)
    // `keywords` is part of the update contract, and sending it preserves the
    // saved list when the user did not edit it — the field is always included
    // rather than omitted, so an accidental empty array cannot erase it.
    const parsed = investigationUpdateSchema.safeParse({ title, topic, objective, description, keywords })
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const key = fieldErrorKey(issue.path)
        if (!fieldErrors[key]) fieldErrors[key] = issue.message
      }
      setErrors(fieldErrors)
      return
    }
    setErrors({})
    setSaving(true)
    try {
      await api.patch(`/api/investigations/${investigation.id}`, parsed.data)
      onSaved()
    } catch (caught) {
      if (caught instanceof ApiError) {
        setErrors(caught.fieldErrors())
        setFormError(caught.message)
      } else {
        setFormError(t('common.unknownError'))
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('detail.editModalTitle')}
      description={t('detail.editModalDescription')}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('detail.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={saving}>
            {t('detail.saveChanges')}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        {formError ? <Notice tone="danger">{formError}</Notice> : null}
        <Field label={t('detail.fieldTitle')} error={errors['title']} id="edit-field-title">
          <Input
            value={title}
            maxLength={160}
            onChange={(event) => setTitle(event.target.value)}
            invalid={Boolean(errors['title'])}
            aria-label={t('detail.fieldTitle')}
            aria-invalid={errors['title'] ? true : undefined}
            aria-describedby={errors['title'] ? 'edit-field-title-error' : undefined}
          />
        </Field>
        <Field label={t('detail.fieldTopic')} error={errors['topic']} id="edit-field-topic">
          <Input
            value={topic}
            maxLength={300}
            onChange={(event) => setTopic(event.target.value)}
            invalid={Boolean(errors['topic'])}
            aria-label={t('detail.fieldTopic')}
            aria-invalid={errors['topic'] ? true : undefined}
            aria-describedby={errors['topic'] ? 'edit-field-topic-error' : undefined}
          />
        </Field>
        <Field label={t('detail.fieldObjective')} error={errors['objective']} id="edit-field-objective">
          <Textarea
            value={objective}
            maxLength={2000}
            rows={4}
            onChange={(event) => setObjective(event.target.value)}
            invalid={Boolean(errors['objective'])}
            aria-label={t('detail.fieldObjective')}
            aria-invalid={errors['objective'] ? true : undefined}
            aria-describedby={errors['objective'] ? 'edit-field-objective-error' : undefined}
          />
        </Field>
        <Field label={t('detail.fieldDescription')} optional error={errors['description']} id="edit-field-description">
          <Textarea
            value={description}
            maxLength={4000}
            rows={3}
            onChange={(event) => setDescription(event.target.value)}
            invalid={Boolean(errors['description'])}
            aria-label={t('detail.fieldDescription')}
            aria-invalid={errors['description'] ? true : undefined}
            aria-describedby={errors['description'] ? 'edit-field-description-error' : undefined}
          />
        </Field>
        <Field
          label={t('detail.fieldKeywords')}
          optional
          error={errors['keywords']}
          id="edit-field-keywords"
          hint={t('detail.keywordsHint')}
        >
          <KeywordEditor
            value={keywords}
            onChange={(next) => {
              setKeywords(next)
              setErrors((current) => {
                const { keywords: _ignored, ...rest } = current
                return rest
              })
            }}
            onProblem={(problem) =>
              setErrors((current) => {
                if (problem) return { ...current, keywords: problem }
                const { keywords: _ignored, ...rest } = current
                return rest
              })
            }
            error={errors['keywords']}
            errorId="edit-field-keywords-error"
          />
        </Field>
      </form>
    </Modal>
  )
}

const EXPORT_SCOPES = [
  { value: 'investigation', labelKey: 'detail.exportScopeInvestigation', descriptionKey: 'detail.exportScopeInvestigationDescription' },
  { value: 'evidence', labelKey: 'detail.exportScopeEvidence', descriptionKey: 'detail.exportScopeEvidenceDescription' },
  { value: 'analyses', labelKey: 'detail.exportScopeAnalyses', descriptionKey: 'detail.exportScopeAnalysesDescription' },
  { value: 'validations', labelKey: 'detail.exportScopeValidations', descriptionKey: 'detail.exportScopeValidationsDescription' },
  { value: 'history', labelKey: 'detail.exportScopeHistory', descriptionKey: 'detail.exportScopeHistoryDescription' },
] as const

function ExportModal({
  open,
  investigationId,
  onClose,
  onExported,
  onError,
}: {
  open: boolean
  investigationId: string
  onClose: () => void
  onExported: (filename: string) => void
  onError: (message: string) => void
}) {
  const [format, setFormat] = useState<'json' | 'csv'>('json')
  const [scope, setScope] = useState<(typeof EXPORT_SCOPES)[number]['value']>('investigation')
  const [downloading, setDownloading] = useState(false)
  const { t } = useI18n()

  const download = async () => {
    setDownloading(true)
    try {
      const filename = await downloadFile(`/api/investigations/${investigationId}/export`, { format, scope })
      onExported(filename)
      onClose()
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : t('detail.exportUnexpected'))
    } finally {
      setDownloading(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('detail.exportModalTitle')}
      description={t('detail.exportModalDescription')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('detail.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void download()}
            loading={downloading}
            iconLeft={<Download className="size-4" aria-hidden />}
          >
            {t('detail.exportDownload')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <p className="meta-label mb-2">{t('detail.exportFormatLabel')}</p>
          <div className="grid grid-cols-2 gap-2">
            {(['json', 'csv'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setFormat(value)}
                aria-pressed={format === value}
                className={`flex items-center gap-2.5 rounded-md border px-3 py-2.5 text-left transition-colors ${
                  format === value
                    ? 'border-signal/50 bg-signal/[0.08] text-ink'
                    : 'border-hairline-strong bg-raised/40 text-ink-muted hover:border-hairline-strong'
                }`}
              >
                <FileJson className="size-4" aria-hidden />
                <span>
                  <span className="block text-[0.8125rem] font-medium uppercase">{value}</span>
                  <span className="block text-[0.75rem] text-ink-faint">
                    {value === 'json' ? t('detail.exportJsonDetail') : t('detail.exportCsvDetail')}
                  </span>
                </span>
                {format === value ? <CheckCircle2 className="ml-auto size-4 text-signal-bright" aria-hidden /> : null}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="meta-label mb-2">{t('detail.exportScopeLabel')}</p>
          <div className="space-y-1.5">
            {EXPORT_SCOPES.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => setScope(item.value)}
                aria-pressed={scope === item.value}
                className={`flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors ${
                  scope === item.value
                    ? 'border-signal/50 bg-signal/[0.08]'
                    : 'border-hairline bg-raised/30 hover:border-hairline-strong'
                }`}
              >
                <span
                  aria-hidden
                  className={`flex size-3.5 items-center justify-center rounded-full border ${
                    scope === item.value ? 'border-signal bg-signal' : 'border-hairline-strong'
                  }`}
                >
                  {scope === item.value ? <span className="size-1.5 rounded-full bg-white" /> : null}
                </span>
                <span className="min-w-0">
                  <span className="block text-[0.8125rem] text-ink">{t(item.labelKey)}</span>
                  <span className="block text-[0.75rem] text-ink-faint">{t(item.descriptionKey)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        <Notice tone="info">{t('detail.exportNote')}</Notice>
      </div>
    </Modal>
  )
}
