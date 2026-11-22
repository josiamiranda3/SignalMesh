import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  CircleAlert,
  CircleHelp,
  ExternalLink,
  FileWarning,
  Info,
  Layers,
  Quote,
  Scale,
  Sparkles,
} from 'lucide-react'
import type { Analysis } from '@shared/domain'
import type { InvestigationDetail } from '@shared/api'
import { api, ApiError } from '@/lib/api'
import { useAsync } from '@/hooks/useAsync'
import { PageContainer, PageHeader, SectionHeader } from '@/components/layout/Page'
import {
  Badge,
  Button,
  EmptyState,
  Modal,
  Notice,
  Skeleton,
  useToast,
} from '@/components/ui'
import { formatDateTime, formatNumber, formatRelative, safeHref, untilReset } from '@/lib/format'
import { useI18n, type TranslationKey } from '@/i18n/I18nProvider'
import { cn } from '@/lib/utils'

/**
 * Analysis.
 *
 * Requests a structured Gemini analysis over the investigation's stored
 * evidence and renders the validated result: executive summary, findings with
 * their citations, contradictions, limitations, gaps and the model used. A
 * failed analysis is shown as a failure with its reason — never as an empty or
 * partially trusted result.
 */
export default function AnalysisPage() {
  const { id = '' } = useParams()
  const toast = useToast()
  const { t, locale } = useI18n()
  const { data, error, loading, reload } = useAsync<InvestigationDetail>(
    () => api.get<InvestigationDetail>(`/api/investigations/${id}`),
    [id],
  )

  const [running, setRunning] = useState(false)
  const [failure, setFailure] = useState<Error | null>(null)
  const [selectedAnalysis, setSelectedAnalysis] = useState<string | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const analyses = data?.analyses ?? []
  const evidence = data?.evidence ?? []
  const completed = analyses.filter((item) => item.status === 'completed')
  const active = useMemo(
    () => completed.find((item) => item.id === selectedAnalysis) ?? completed[0] ?? null,
    [completed, selectedAnalysis],
  )
  const quota = data?.quota
  const exhausted = quota ? quota.analysis.remaining <= 0 : false
  const externalDisabled = quota ? !quota.externalApisEnabled : false

  const requestAnalysis = async () => {
    setConfirmOpen(false)
    setRunning(true)
    setFailure(null)
    try {
      const analysis = await api.post<Analysis>(`/api/investigations/${id}/analyses`, {
        // The analysis text is written in the language the user is reading the
        // interface in. Only the *output* language is affected: the evidence,
        // its titles and URLs are forwarded verbatim by the server.
        outputLanguage: locale,
      })
      setSelectedAnalysis(analysis.id)
      toast.success(
        t('analysis.completedTitle'),
        t('analysis.completedToastDetail', { count: analysis.findings.length }),
      )
      reload()
    } catch (caught) {
      setFailure(caught instanceof Error ? caught : new Error('Falha desconhecida'))
      reload()
    } finally {
      setRunning(false)
    }
  }

  if (loading) {
    return (
      <PageContainer>
        <Skeleton className="h-3 w-48" />
        <Skeleton className="mt-4 h-8 w-2/5" />
        <Skeleton className="mt-6 h-40 rounded-lg" />
        <Skeleton className="mt-4 h-64 rounded-lg" />
      </PageContainer>
    )
  }

  if (error || !data) {
    return (
      <PageContainer>
        <EmptyState
          icon={<AlertTriangle className="size-5" aria-hidden />}
          title={t('analysis.unavailableTitle')}
          description={error?.message ?? t('analysis.unavailableDescription')}
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
        eyebrow={t('analysis.eyebrow')}
        title={t('analysis.title')}
        description={t('analysis.description')}
        meta={
          quota ? (
            <>
              <span className="text-[0.75rem] text-ink-subtle">
                <span>
                  {t('analysis.quotaToday', {
                    used: quota.analysis.used,
                    limit: quota.analysis.limit,
                  })}
                </span>
              </span>
              <span aria-hidden className="size-1 rounded-full bg-hairline-strong" />
              <span className="text-[0.75rem] text-ink-subtle">
                {t('analysis.evidenceAvailable', { count: formatNumber(evidence.length) })}
              </span>
            </>
          ) : null
        }
        actions={
          <Button
            variant="primary"
            size="md"
            loading={running}
            disabled={evidence.length === 0 || externalDisabled || exhausted}
            onClick={() => setConfirmOpen(true)}
            iconLeft={running ? undefined : <Sparkles className="size-4" aria-hidden />}
          >
            {running ? t('analysis.analyzing') : t('analysis.requestAnalysis')}
          </Button>
        }
      />

      {externalDisabled ? (
        <div className="mt-6">
          <Notice tone="caution" title={t('analysis.disabledTitle')}>
            {t('analysis.disabledDescription')}
          </Notice>
        </div>
      ) : exhausted ? (
        <div className="mt-6">
          <Notice tone="caution" title={t('analysis.quotaTitle')}>
            {t('analysis.quotaDescription', { when: untilReset(quota!.analysis.resetsAt) })}
          </Notice>
        </div>
      ) : evidence.length === 0 ? (
        <div className="mt-6">
          <Notice tone="info" title={t('analysis.noEvidenceTitle')}>
            {t('analysis.noEvidenceDescription')}
          </Notice>
        </div>
      ) : null}

      {failure ? (
        <div className="mt-5">
          <Notice
            tone="danger"
            title={t(failureTitleKey(failure))}
            action={
              <Button size="sm" variant="secondary" onClick={() => setFailure(null)}>
                Dispensar
              </Button>
            }
          >
            {failure.message}
          </Notice>
        </div>
      ) : null}

      {running ? <AnalysisSkeleton /> : null}

      {!running && completed.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={<Sparkles className="size-5" aria-hidden />}
            title={t('analysis.emptyTitle')}
            description={t('analysis.emptyDescription')}
            action={
              evidence.length > 0 ? (
                <Button
                  variant="primary"
                  onClick={() => setConfirmOpen(true)}
                  disabled={externalDisabled || exhausted}
                  iconLeft={<Sparkles className="size-4" aria-hidden />}
                >
                  {t('analysis.requestAnalysis')}
                </Button>
              ) : (
                <Link to={`/investigations/${id}/research`}>
                  <Button variant="primary">{t('analysis.researchFirst')}</Button>
                </Link>
              )
            }
          />
        </div>
      ) : null}

      {/* Failed attempts are surfaced explicitly */}
      {!running && analyses.some((item) => item.status === 'failed') ? (
        <div className="mt-5">
          <section className="panel overflow-hidden" aria-labelledby="failed-analyses">
            <div className="flex items-center gap-2 border-b border-hairline px-5 py-3.5">
              <FileWarning className="size-4 text-negative" aria-hidden />
              <h2 id="failed-analyses" className="text-[0.9375rem] font-semibold text-ink">
                {t('analysis.failedTitle')}
              </h2>
            </div>
            <ul className="divide-y divide-hairline/60">
              {analyses
                .filter((item) => item.status === 'failed')
                .map((item) => (
                  <li key={item.id} className="px-5 py-3">
                    <p className="text-[0.8125rem] leading-relaxed text-ink-muted">{item.errorMessage}</p>
                    <p className="mt-1 text-[0.75rem] text-ink-faint">
                      {t('analysis.failedMeta', { date: formatDateTime(item.createdAt), model: item.model })}
                    </p>
                  </li>
                ))}
            </ul>
          </section>
        </div>
      ) : null}

      {!running && completed.length > 0 ? (
        <div className="mt-5 space-y-4">
          {completed.length > 1 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="meta-label mr-1">{t('analysis.analysesLabel')}</span>
              {completed.map((analysis, index) => (
                <button
                  key={analysis.id}
                  type="button"
                  onClick={() => setSelectedAnalysis(analysis.id)}
                  aria-pressed={active?.id === analysis.id}
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-[0.75rem] transition-colors',
                    active?.id === analysis.id
                      ? 'border-signal/50 bg-signal/10 text-ink'
                      : 'border-hairline bg-raised/40 text-ink-subtle hover:border-hairline-strong',
                  )}
                >
                  {index === 0 ? 'Mais recente' : formatRelative(analysis.createdAt)}
                </button>
              ))}
            </div>
          ) : null}

          {active ? <AnalysisView analysis={active} evidenceCount={evidence.length} /> : null}
        </div>
      ) : null}

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t('analysis.confirmTitle')}
        description={t('analysis.confirmDescription')}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              {t('common.cancelAction')}
            </Button>
            <Button variant="primary" onClick={() => void requestAnalysis()} iconLeft={<Sparkles className="size-4" aria-hidden />}>
              {t('analysis.confirmAction')}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-[0.8125rem] leading-relaxed text-ink-muted">
          <p>
            {t('analysis.confirmSentIntro', { count: formatNumber(evidence.length) })}
          </p>
          <ul className="space-y-2">
            {[
              t('analysis.confirmRuleCited'),
              t('analysis.confirmRuleInvalid'),
              t('analysis.confirmRuleContradictions'),
              t('analysis.confirmRuleData'),
            ].map((item) => (
              <li key={item} className="flex gap-2">
                <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-signal" />
                {item}
              </li>
            ))}
          </ul>
          <Notice tone="info">
            {t('analysis.confirmNote')}
          </Notice>
        </div>
      </Modal>
    </PageContainer>
  )
}

function AnalysisView({ analysis, evidenceCount }: { analysis: Analysis; evidenceCount: number }) {
  const { t } = useI18n()
  const evidenceById = new Map(analysis.references.map((reference) => [reference.evidenceId, reference]))

  return (
    <article className="space-y-5">
      {/* Provenance bar */}
      <div className="panel flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3">
        <Badge tone="signal" dot>
          {t('analysis.completedTitle')}
        </Badge>
        <span className="text-[0.75rem] text-ink-subtle">
          Modelo <span className="font-mono text-ink-muted">{analysis.model}</span>
        </span>
        <span className="text-[0.75rem] text-ink-subtle">{formatDateTime(analysis.createdAt)}</span>
        <span className="text-[0.75rem] text-ink-subtle">
          {t('analysis.evidenceSent', { used: analysis.evidenceIds.length, total: evidenceCount })}
        </span>
        {analysis.usage?.totalTokens ? (
          <span className="tnum text-[0.75rem] text-ink-faint">{formatNumber(analysis.usage.totalTokens)} tokens</span>
        ) : null}
      </div>

      {analysis.insufficientEvidence ? (
        <Notice tone="caution" title={t('analysis.insufficientTitle')}>
          {t('analysis.insufficientDescription')}
        </Notice>
      ) : null}

      {/* Executive summary */}
      <section className="panel p-5" aria-labelledby="summary-heading">
        <SectionHeader title={t('analysis.summaryTitle')} description={t('analysis.summaryDescription')} />
        <p className="mt-3 whitespace-pre-wrap text-pretty text-[0.875rem] leading-relaxed text-ink-muted">
          {analysis.executiveSummary || t('analysis.summaryEmpty')}
        </p>
      </section>

      {/* Findings */}
      <section className="panel p-5" aria-labelledby="findings-heading">
        <SectionHeader
          title={t('analysis.findingsTitle')}
          description={t('analysis.findingsDescription')}
          actions={<span className="tnum text-[0.75rem] text-ink-faint">{analysis.findings.length}</span>}
        />
        {analysis.findings.length === 0 ? (
          <p className="mt-4 text-[0.8125rem] text-ink-faint">
            {t('analysis.findingsEmpty')}
          </p>
        ) : (
          <ol className="mt-4 space-y-4">
            {analysis.findings.map((finding, index) => (
              <li key={index} className="border-l-2 border-signal/30 pl-4">
                <div className="flex items-start gap-2">
                  <span className="tnum mt-0.5 text-[0.75rem] font-semibold text-ink-faint">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[0.875rem] leading-relaxed text-ink">{finding.statement}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <Badge tone={finding.confidence === 'high' ? 'positive' : finding.confidence === 'medium' ? 'signal' : 'caution'}>
                        {finding.confidence === 'high'
                      ? t('analysis.confidenceHigh')
                      : finding.confidence === 'medium'
                        ? t('analysis.confidenceMedium')
                        : t('analysis.confidenceLow')}
                      </Badge>
                      {finding.evidenceIds.map((evidenceId) => {
                        const reference = evidenceById.get(evidenceId)
                        const href = reference ? safeHref(reference.url) : null
                        return href ? (
                          <a
                            key={evidenceId}
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer nofollow"
                            className="inline-flex max-w-[240px] items-center gap-1 rounded border border-hairline-strong bg-raised px-1.5 py-0.5 text-[0.75rem] text-ink-subtle transition-colors hover:border-signal/40 hover:text-ink"
                            title={reference?.title}
                          >
                            <ExternalLink className="size-2.5 shrink-0" aria-hidden />
                            <span className="truncate">{reference?.domain || evidenceId}</span>
                          </a>
                        ) : (
                          <span key={evidenceId} className="rounded border border-negative/40 px-1.5 py-0.5 text-[0.75rem] text-negative">
                            {t('analysis.missingReference')}
                          </span>
                        )
                      })}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      {/* Key points + supported claims */}
      <div className="grid gap-5 lg:grid-cols-2">
        <section className="panel p-5" aria-labelledby="keypoints-heading">
          <SectionHeader title={t('analysis.keyPointsTitle')} description={t('analysis.keyPointsDescription')} />
          {analysis.keyPoints.length === 0 ? (
            <p className="mt-3 text-[0.8125rem] text-ink-faint">{t('analysis.keyPointsEmpty')}</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {analysis.keyPoints.map((point, index) => (
                <li key={index} className="flex gap-2 text-[0.8125rem] leading-relaxed text-ink-muted">
                  <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-signal" />
                  {point}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel p-5" aria-labelledby="supported-heading">
          <SectionHeader title={t('analysis.supportedTitle')} description={t('analysis.supportedDescription')} />
          {analysis.supportedClaims.length === 0 ? (
            <p className="mt-3 text-[0.8125rem] text-ink-faint">{t('analysis.supportedEmpty')}</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {analysis.supportedClaims.map((claim, index) => (
                <li key={index} className="flex gap-2 text-[0.8125rem] leading-relaxed text-ink-muted">
                  <BadgeCheck className="mt-0.5 size-3.5 shrink-0 text-positive" aria-hidden />
                  {claim}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Contradictions */}
      <section className="panel p-5" aria-labelledby="contradictions-heading">
        <SectionHeader
          title={t('analysis.contradictionsTitle')}
          description={t('analysis.contradictionsDescription')}
          actions={<Scale className="size-4 text-caution" aria-hidden />}
        />
        {analysis.contradictions.length === 0 ? (
          <p className="mt-3 text-[0.8125rem] text-ink-faint">
            {t('analysis.contradictionsEmpty')}
          </p>
        ) : (
          <ul className="mt-3 space-y-3">
            {analysis.contradictions.map((contradiction, index) => (
              <li key={index} className="rounded-md border border-caution/25 bg-caution/[0.05] p-3">
                <div className="flex gap-2">
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-caution" aria-hidden />
                  <div>
                    <p className="text-[0.8125rem] leading-relaxed text-ink-muted">{contradiction.description}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {contradiction.evidenceIds.map((evidenceId) => {
                        const reference = evidenceById.get(evidenceId)
                        return (
                          <span key={evidenceId} className="rounded border border-hairline-strong bg-raised px-1.5 py-0.5 text-[0.75rem] text-ink-subtle">
                            {reference?.domain ?? evidenceId}
                          </span>
                        )
                      })}
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Limitations + gaps */}
      <div className="grid gap-5 lg:grid-cols-2">
        <section className="panel p-5" aria-labelledby="limitations-heading">
          <SectionHeader title={t('analysis.limitationsTitle')} description={t('analysis.limitationsDescription')} />
          {analysis.limitations.length === 0 ? (
            <p className="mt-3 text-[0.8125rem] text-ink-faint">{t('analysis.limitationsEmpty')}</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {analysis.limitations.map((item, index) => (
                <li key={index} className="flex gap-2 text-[0.8125rem] leading-relaxed text-ink-muted">
                  <Info className="mt-0.5 size-3.5 shrink-0 text-ink-faint" aria-hidden />
                  {item}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel p-5" aria-labelledby="gaps-heading">
          <SectionHeader title={t('analysis.gapsTitle')} description={t('analysis.gapsDescription')} />
          {analysis.informationGaps.length === 0 ? (
            <p className="mt-3 text-[0.8125rem] text-ink-faint">{t('analysis.gapsEmpty')}</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {analysis.informationGaps.map((item, index) => (
                <li key={index} className="flex gap-2 text-[0.8125rem] leading-relaxed text-ink-muted">
                  <CircleHelp className="mt-0.5 size-3.5 shrink-0 text-ink-faint" aria-hidden />
                  {item}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Objective alignment */}
      <section className="panel p-5" aria-labelledby="alignment-heading">
        <SectionHeader title={t('analysis.objectiveTitle')} description={t('analysis.objectiveDescription')} />
        <p className="mt-3 whitespace-pre-wrap text-[0.875rem] leading-relaxed text-ink-muted">
          {analysis.objectiveAlignment || t('analysis.objectiveEmpty')}
        </p>
      </section>

      {/* References */}
      <section className="panel p-5" aria-labelledby="references-heading">
        <SectionHeader
          title={t('analysis.referencesTitle')}
          description={t('analysis.referencesDescription')}
          actions={<span className="tnum text-[0.75rem] text-ink-faint">{analysis.references.length}</span>}
        />
        {analysis.references.length === 0 ? (
          <p className="mt-3 text-[0.8125rem] text-ink-faint">{t('analysis.referencesEmpty')}</p>
        ) : (
          <ol className="mt-3 space-y-2">
            {analysis.references.map((reference, index) => {
              const href = safeHref(reference.url)
              return (
                <li key={reference.evidenceId} className="flex items-start gap-2.5 rounded-md border border-hairline bg-raised/30 px-3 py-2">
                  <span className="tnum mt-0.5 text-[0.75rem] text-ink-faint">[{index + 1}]</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[0.8125rem] text-ink">{reference.title}</p>
                    <p className="truncate text-[0.75rem] text-ink-faint">{reference.domain || reference.url}</p>
                  </div>
                  {href ? (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="shrink-0 rounded p-1 text-ink-faint transition-colors hover:bg-white/5 hover:text-ink-muted"
                      aria-label={`Abrir ${reference.title}`}
                    >
                      <ExternalLink className="size-3.5" aria-hidden />
                    </a>
                  ) : null}
                </li>
              )
            })}
          </ol>
        )}
        <p className="mt-4 flex items-start gap-2 border-t border-hairline pt-3 text-[0.75rem] leading-relaxed text-ink-faint">
          <Quote className="mt-0.5 size-3 shrink-0" aria-hidden />
          {t('analysis.disclaimer')}
        </p>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <Link to={`/investigations/${analysis.investigationId}/validation`}>
          <Button variant="primary" size="md" iconRight={<ArrowRight className="size-4" aria-hidden />}>
            {t('analysis.validateEvidence')}
          </Button>
        </Link>
        <Link to={`/investigations/${analysis.investigationId}/evidence`}>
          <Button variant="secondary" size="md" iconLeft={<Layers className="size-4" aria-hidden />}>
            {t('analysis.reviewSources')}
          </Button>
        </Link>
      </div>
    </article>
  )
}

function AnalysisSkeleton() {
  const { t } = useI18n()
  return (
    <div className="mt-6 space-y-4">
      <div className="panel flex items-center gap-3 px-5 py-3.5">
        <Sparkles className="size-4 animate-pulse text-signal" aria-hidden />
        <div>
          <p className="text-[0.8125rem] text-ink">{t('analysis.generatingTitle')}</p>
          <p className="mt-0.5 text-[0.75rem] text-ink-faint">
            {t('analysis.generatingDescription')}
          </p>
        </div>
      </div>
      <Skeleton className="h-28 rounded-lg" />
      <Skeleton className="h-48 rounded-lg" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-36 rounded-lg" />
        <Skeleton className="h-36 rounded-lg" />
      </div>
    </div>
  )
}

/** Maps an API error code to a translation key; no user copy lives here. */
function failureTitleKey(error: Error): TranslationKey {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'invalid_provider_response':
        return 'analysis.failureInvalid'
      case 'provider_rate_limited':
        return 'analysis.failureProviderRate'
      case 'provider_timeout':
        return 'analysis.failureTimeout'
      case 'provider_auth_failed':
        return 'analysis.failureAuth'
      case 'quota_exceeded':
        return 'analysis.failureQuota'
      case 'external_disabled':
        return 'analysis.failureDisabled'
      case 'invalid_request':
        return 'analysis.failureRequest'
      default:
        return 'analysis.failureGeneric'
    }
  }
  return 'analysis.failureGeneric'
}
