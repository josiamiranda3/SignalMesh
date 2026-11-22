import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CircleHelp,
  ExternalLink,
  History,
  RotateCcw,
  ShieldQuestion,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react'
import type { Evidence, Validation, ValidationStatus } from '@shared/domain'
import type { InvestigationDetail } from '@shared/api'
import { api } from '@/lib/api'
import { useAsync } from '@/hooks/useAsync'
import { PageContainer, PageHeader } from '@/components/layout/Page'
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Modal,
  Notice,
  Skeleton,
  Tabs,
  Textarea,
  ValidationStatusBadge,
  useToast,
  validationLabel,
} from '@/components/ui'
import { formatDateTime, formatNumber, formatRelative, safeHref } from '@/lib/format'
import { useI18n } from '@/i18n/I18nProvider'
import { cn } from '@/lib/utils'

/**
 * Human validation.
 *
 * The decision surface of the product. Three outcomes — accepted, rejected,
 * needs review — each with its own requirement: rejection and review demand a
 * justification. Changing a decision appends a new event, so the full history
 * of a source's status remains visible.
 */
export default function ValidationPage() {
  const { t } = useI18n()
  const { id: routeId } = useParams()
  const toast = useToast()

  const { data, error, loading, reload } = useAsync<InvestigationDetail | ValidationQueue>(
    () =>
      routeId
        ? api.get<InvestigationDetail>(`/api/investigations/${routeId}`)
        : api.get<ValidationQueue>('/api/validations'),
    [routeId],
  )

  const [tab, setTab] = useState<'pending' | 'needs_review' | 'accepted' | 'rejected'>('pending')
  const [target, setTarget] = useState<{
    evidence: Evidence
    status: ValidationStatus
  } | null>(null)
  const [historyTarget, setHistoryTarget] = useState<Evidence | null>(null)

  const rows = useMemo<Row[]>(() => {
    if (!data) return []
    if (routeId) {
      const detail = data as InvestigationDetail
      return detail.evidence.map((evidence) => ({
        evidence,
        investigationId: detail.investigation.id,
        investigationTitle: detail.investigation.title,
        validations: detail.validations.filter((validation) => validation.evidenceId === evidence.id),
      }))
    }
    return (data as ValidationQueue).map((item) => ({
      evidence: item.evidence,
      investigationId: item.investigation.id,
      investigationTitle: item.investigation.title,
      validations: item.latestValidation ? [item.latestValidation] : [],
    }))
  }, [data, routeId])

  const counts = useMemo(() => {
    const result: Record<ValidationStatus, number> = { pending: 0, accepted: 0, rejected: 0, needs_review: 0 }
    for (const row of rows) result[row.evidence.validationStatus] += 1
    return result
  }, [rows])

  const visible = rows.filter((row) => row.evidence.validationStatus === tab)

  if (loading) {
    return (
      <PageContainer>
        <Skeleton className="h-8 w-2/5" />
        <Skeleton className="mt-6 h-10 w-full" />
        <div className="mt-4 space-y-2.5">
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-24 rounded-lg" />
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
          title={t('validationPage.unavailableTitle')}
          description={error?.message ?? t('validationPage.unavailableDescription')}
          action={
            <Link to="/investigations">
              <Button variant="primary">{t('validationPage.back')}</Button>
            </Link>
          }
        />
      </PageContainer>
    )
  }

  return (
    <PageContainer>
      {routeId ? (
        <Link
          to={`/investigations/${routeId}`}
          className="mb-5 inline-flex min-h-9 items-center gap-1.5 text-[0.75rem] text-ink-subtle transition-colors hover:text-ink"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          {(data as InvestigationDetail).investigation.title}
        </Link>
      ) : null}

      <PageHeader
        eyebrow={t('validationPage.eyebrow')}
        title={routeId ? t('validationPage.titleWithInvestigation') : t('validationPage.titleQueue')}
        description={t('validationPage.description')}
        meta={
          <>
            <span className="text-[0.75rem] text-ink-subtle">{t('validationPage.totalCount', { count: formatNumber(rows.length) })}</span>
            <span aria-hidden className="size-1 rounded-full bg-hairline-strong" />
            <span className="text-[0.75rem] text-caution">
              {t('validationPage.awaitingDecision', { count: counts.needs_review + counts.pending })}
            </span>
          </>
        }
      />

      <Tabs
        className="mt-6"
        ariaLabel={t('validationPage.filterAria')}
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'pending', label: t('validationPage.tabPending'), count: counts.pending },
          { value: 'needs_review', label: t('validationPage.tabNeedsReview'), count: counts.needs_review },
          { value: 'accepted', label: t('validationPage.tabAccepted'), count: counts.accepted },
          { value: 'rejected', label: t('validationPage.tabRejected'), count: counts.rejected },
        ]}
      />

      <div className="mt-5">
        {visible.length === 0 ? (
          <EmptyState
            icon={tab === 'pending' ? <Check className="size-5" aria-hidden /> : <ShieldQuestion className="size-5" aria-hidden />}
            title={
              tab === 'pending'
                ? t('validationPage.emptyPending')
                : tab === 'accepted'
                  ? t('validationPage.emptyAccepted')
                  : tab === 'rejected'
                    ? t('validationPage.emptyRejected')
                    : t('validationPage.emptyNeedsReview')
            }
            description={
              rows.length === 0
                ? t('validationPage.emptyDescriptionStart')
                : t('validationPage.emptyDescriptionOther')
            }
            compact
          />
        ) : (
          <ul className="space-y-2.5">
            {visible.map((row) => (
              <ValidationRow
                key={row.evidence.id}
                row={row}
                showInvestigation={!routeId}
                onDecide={(status) => setTarget({ evidence: row.evidence, status })}
                onHistory={() => setHistoryTarget(row.evidence)}
              />
            ))}
          </ul>
        )}
      </div>

      <div className="mt-6">
        <Notice tone="info" title={t('validationPage.meaningTitle')}>
          <ul className="mt-1 space-y-1">
            <li>
              <strong className="text-ink">{t('validationPage.meaningAcceptedStrong')}</strong>{' '}
              {t('validationPage.meaningAcceptedRest')}
            </li>
            <li>
              <strong className="text-ink">{t('validationPage.meaningReviewStrong')}</strong>{' '}
              {t('validationPage.meaningReviewRest')}
            </li>
            <li>
              <strong className="text-ink">{t('validationPage.meaningRejectedStrong')}</strong>{' '}
              {t('validationPage.meaningRejectedRest')}
            </li>
          </ul>
        </Notice>
      </div>

      <DecisionModal
        target={target}
        onClose={() => setTarget(null)}
        onDone={(status) => {
          setTarget(null)
          reload()
          toast.success(
            status === 'accepted'
              ? t('validationPage.toastAccepted')
              : status === 'rejected'
                ? t('validationPage.toastRejected')
                : t('validationPage.toastReview'),
            t('validationPage.toastDetail'),
          )
        }}
        onError={(message) => toast.error(t('validationPage.decisionError'), message)}
      />

      <HistoryModal evidence={historyTarget} onClose={() => setHistoryTarget(null)} />
    </PageContainer>
  )
}

interface Row {
  evidence: Evidence
  investigationId: string
  investigationTitle: string
  validations: Validation[]
}

interface ValidationQueueItem {
  evidence: Evidence
  investigation: { id: string; title: string }
  latestValidation: Validation | null
}
type ValidationQueue = ValidationQueueItem[]

function ValidationRow({
  row,
  showInvestigation,
  onDecide,
  onHistory,
}: {
  row: Row
  showInvestigation: boolean
  onDecide: (status: ValidationStatus) => void
  onHistory: () => void
}) {
  const { t } = useI18n()
  const { evidence } = row
  const href = safeHref(evidence.url)
  const lastDecision = row.validations[0]

  return (
    <li className="panel p-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <ValidationStatusBadge status={evidence.validationStatus} />
            {showInvestigation ? (
              <Link
                to={`/investigations/${row.investigationId}`}
                className="truncate text-[0.75rem] text-ink-faint transition-colors hover:text-ink-muted"
              >
                {row.investigationTitle}
              </Link>
            ) : null}
          </div>

          <h3 className="mt-2 text-[0.875rem] font-medium leading-snug text-ink">{evidence.title}</h3>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.75rem] text-ink-faint">
            <span>{evidence.domain || t('evidence.unknownDomain')}</span>
            <span aria-hidden>·</span>
            <span>{evidence.publishedAt ? formatDateTime(evidence.publishedAt) : t('evidence.noPublishedDate')}</span>
            <span aria-hidden>·</span>
            <span>{t('evidence.collected', { when: formatRelative(evidence.collectedAt) })}</span>
            {evidence.relevanceScore !== null ? (
              <>
                <span aria-hidden>·</span>
                <span className="tnum">{t('evidence.priorityValue', { score: Math.round(evidence.relevanceScore * 100) })}</span>
              </>
            ) : null}
          </div>

          {evidence.snippet ? (
            <p className="mt-2 line-clamp-2 text-[0.75rem] leading-relaxed text-ink-subtle">{evidence.snippet}</p>
          ) : null}

          {lastDecision?.justification ? (
            <div className="mt-2.5 rounded-md border border-hairline bg-raised/40 px-2.5 py-2">
              <p className="meta-label mb-1">{t('validationPage.lastJustification')}</p>
              <p className="text-[0.75rem] leading-relaxed text-ink-subtle">{lastDecision.justification}</p>
              <p className="mt-1 text-[0.75rem] text-ink-faint">{formatDateTime(lastDecision.createdAt)}</p>
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5 lg:flex-col lg:items-stretch">
          <Button
            variant={evidence.validationStatus === 'accepted' ? 'secondary' : 'primary'}
            size="sm"
            onClick={() => onDecide('accepted')}
            iconLeft={<ThumbsUp className="size-3.5" aria-hidden />}
            className="lg:justify-start"
          >
            {t('validationPage.approveButton')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onDecide('needs_review')}
            iconLeft={<CircleHelp className="size-3.5" aria-hidden />}
            className="lg:justify-start"
          >
            {t('validationPage.reviewButton')}
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => onDecide('rejected')}
            iconLeft={<ThumbsDown className="size-3.5" aria-hidden />}
            className="lg:justify-start"
          >
            {t('validationPage.rejectButton')}
          </Button>
          <div className="flex items-center gap-1.5 lg:justify-between">
            <Button variant="quiet" size="sm" onClick={onHistory} iconLeft={<History className="size-3.5" aria-hidden />}>
              {t('validationPage.historyButton')}
            </Button>
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-white/5 hover:text-ink-muted"
                aria-label={t('research.openSourceAria', { title: evidence.title })}
              >
                <ExternalLink className="size-3.5" aria-hidden />
              </a>
            ) : null}
          </div>
        </div>
      </div>
    </li>
  )
}

function DecisionModal({
  target,
  onClose,
  onDone,
  onError,
}: {
  target: { evidence: Evidence; status: ValidationStatus } | null
  onClose: () => void
  onDone: (status: ValidationStatus) => void
  onError: (message: string) => void
}) {
  const { t } = useI18n()
  const [justification, setJustification] = useState('')
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const requiresJustification = target?.status === 'rejected' || target?.status === 'needs_review'

  const submit = async () => {
    if (!target) return
    if (requiresJustification && justification.trim().length < 3) {
      setLocalError(t('validationPage.justificationTooShort'))
      return
    }
    setBusy(true)
    setLocalError(null)
    try {
      await api.post(`/api/evidence/${target.evidence.id}/validation`, {
        status: target.status,
        justification: justification.trim(),
      })
      onDone(target.status)
      setJustification('')
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : t('common.unknownError')
      setLocalError(message)
      onError(message)
    } finally {
      setBusy(false)
    }
  }

  const verbFor = (status: ValidationStatus): string =>
    status === 'accepted'
      ? t('validationPage.verbApprove')
      : status === 'rejected'
        ? t('validationPage.verbReject')
        : status === 'needs_review'
          ? t('validationPage.verbRequestReview')
          : t('validationPage.verbMarkPending')

  return (
    <Modal
      open={Boolean(target)}
      onClose={() => {
        setJustification('')
        setLocalError(null)
        onClose()
      }}
      title={
        target
          ? t('validationPage.dialogTitleWithTarget', { verb: verbFor(target.status) })
          : t('validationPage.dialogTitleFallback')
      }
      description={target ? target.evidence.title : undefined}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              setJustification('')
              setLocalError(null)
              onClose()
            }}
          >
            {t('common.cancelAction')}
          </Button>
          <Button
            variant={target?.status === 'rejected' ? 'danger' : 'primary'}
            onClick={() => void submit()}
            loading={busy}
          >
            {t('validationPage.confirmDecision')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {target ? (
          <div className="rounded-md border border-hairline bg-raised/40 p-3">
            <div className="flex items-center gap-2">
              <Badge
                tone={target.status === 'accepted' ? 'positive' : target.status === 'rejected' ? 'negative' : 'caution'}
                dot
              >
                {t('validationPage.newDecision', { status: validationLabel(target.status) })}
              </Badge>
              <span className="text-[0.75rem] text-ink-faint">
                {t('validationPage.previousDecision', { status: validationLabel(target.evidence.validationStatus) })}
              </span>
            </div>
            <p className="mt-2 text-[0.75rem] leading-relaxed text-ink-subtle">
              {target.status === 'accepted'
                ? t('validationPage.explainAccepted')
                : target.status === 'rejected'
                  ? t('validationPage.explainRejected')
                  : t('validationPage.explainReview')}
            </p>
          </div>
        ) : null}

        <Field
          label={t('common.justificationLabel')}
          optional={!requiresJustification}
          hint={
            requiresJustification
              ? t('validationPage.justificationHintRequired')
              : t('validationPage.justificationHintOptional')
          }
          error={localError}
          counter={`${justification.length}/2000`}
        >
          <Textarea
            value={justification}
            onChange={(event) => setJustification(event.target.value)}
            rows={4}
            maxLength={2000}
            placeholder={
              target?.status === 'rejected'
                ? t('validationPage.justificationPlaceholderRejected')
                : target?.status === 'needs_review'
                  ? t('validationPage.justificationPlaceholderReview')
                  : t('validationPage.justificationPlaceholderDefault')
            }
            aria-label={t('validationPage.justificationAria')}
          />
        </Field>

        <Notice tone="info">
          {t('validationPage.recordNote')} {t('validationPage.recordNoteRest')}
        </Notice>
      </div>
    </Modal>
  )
}

function HistoryModal({ evidence, onClose }: { evidence: Evidence | null; onClose: () => void }) {
  const { t } = useI18n()
  const { data, error, loading } = useAsync<Validation[]>(
    () => (evidence ? api.get<Validation[]>(`/api/evidence/${evidence.id}/validations`) : Promise.resolve([])),
    [evidence?.id],
  )

  return (
    <Modal
      open={Boolean(evidence)}
      onClose={onClose}
      title={t('validationPage.historyTitle')}
      description={evidence?.title}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Fechar
        </Button>
      }
    >
      {loading ? (
        <div className="space-y-2">
          <Skeleton className="h-12 rounded-md" />
          <Skeleton className="h-12 rounded-md" />
        </div>
      ) : error ? (
        <Notice tone="danger">{error.message}</Notice>
      ) : !data || data.length === 0 ? (
        <p className="py-6 text-center text-[0.8125rem] text-ink-faint">
          {t('validationPage.historyEmpty')}
        </p>
      ) : (
        <ol className="relative space-y-4 border-l border-hairline pl-4">
          {data.map((item) => (
            <li key={item.id} className="relative">
              <span
                aria-hidden
                className={cn(
                  'absolute -left-[21px] top-1 size-2 rounded-full ring-4 ring-overlay',
                  item.status === 'accepted'
                    ? 'bg-positive'
                    : item.status === 'rejected'
                      ? 'bg-negative'
                      : item.status === 'needs_review'
                        ? 'bg-caution'
                        : 'bg-ink-faint',
                )}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  tone={item.status === 'accepted' ? 'positive' : item.status === 'rejected' ? 'negative' : 'caution'}
                >
                  {validationLabel(item.status)}
                </Badge>
                {item.previousStatus ? (
                  <span className="flex items-center gap-1 text-[0.75rem] text-ink-faint">
                    <RotateCcw className="size-2.5" aria-hidden />
                    antes: {validationLabel(item.previousStatus)}
                  </span>
                ) : null}
              </div>
              {item.justification ? (
                <p className="mt-1.5 text-[0.78125rem] leading-relaxed text-ink-muted">{item.justification}</p>
              ) : (
                <p className="mt-1.5 text-[0.75rem] italic text-ink-faint">{t('validationPage.noJustification')}</p>
              )}
              <p className="mt-1 text-[0.75rem] text-ink-faint">{formatDateTime(item.createdAt)}</p>
            </li>
          ))}
        </ol>
      )}
    </Modal>
  )
}
