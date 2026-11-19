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
      const analysis = await api.post<Analysis>(`/api/investigations/${id}/analyses`, {})
      setSelectedAnalysis(analysis.id)
      toast.success('Análise concluída', `${analysis.findings.length} descoberta(s) vinculadas a evidências reais.`)
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
          title="Investigação indisponível"
          description={error?.message ?? 'Não foi possível carregar as análises.'}
          action={
            <Link to="/investigations">
              <Button variant="primary">Voltar</Button>
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
        eyebrow="Análise estruturada"
        title="Síntese das evidências"
        description="A análise é produzida pelo Google Gemini a partir exclusivamente das evidências armazenadas nesta investigação. Referências a fontes inexistentes invalidam o resultado."
        meta={
          quota ? (
            <>
              <span className="text-[0.75rem] text-ink-subtle">
                Análises hoje: <span className="tnum">{quota.analysis.used}/{quota.analysis.limit}</span>
              </span>
              <span aria-hidden className="size-1 rounded-full bg-hairline-strong" />
              <span className="text-[0.75rem] text-ink-subtle">
                {formatNumber(evidence.length)} evidência(s) disponível(is)
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
            {running ? 'Analisando…' : 'Solicitar análise'}
          </Button>
        }
      />

      {externalDisabled ? (
        <div className="mt-6">
          <Notice tone="caution" title="Análise por IA desativada">
            As chamadas externas estão desligadas ou a chave do Gemini não está configurada no backend.
          </Notice>
        </div>
      ) : exhausted ? (
        <div className="mt-6">
          <Notice tone="caution" title="Limite diário de análises atingido">
            O contador reinicia {untilReset(quota!.analysis.resetsAt)}. As análises anteriores continuam acessíveis.
          </Notice>
        </div>
      ) : evidence.length === 0 ? (
        <div className="mt-6">
          <Notice tone="info" title="Nenhuma evidência para analisar">
            Adicione fontes à investigação antes de solicitar uma análise. A IA só recebe evidências efetivamente
            armazenadas.
          </Notice>
        </div>
      ) : null}

      {failure ? (
        <div className="mt-5">
          <Notice
            tone="danger"
            title={failureTitle(failure)}
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
            title="Nenhuma análise concluída"
            description="A análise organiza as evidências em resumo executivo, descobertas com referências, contradições e limitações. Ela não decide se uma fonte é verdadeira — isso permanece com você."
            action={
              evidence.length > 0 ? (
                <Button
                  variant="primary"
                  onClick={() => setConfirmOpen(true)}
                  disabled={externalDisabled || exhausted}
                  iconLeft={<Sparkles className="size-4" aria-hidden />}
                >
                  Solicitar análise
                </Button>
              ) : (
                <Link to={`/investigations/${id}/research`}>
                  <Button variant="primary">Pesquisar fontes primeiro</Button>
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
                Tentativas não concluídas
              </h2>
            </div>
            <ul className="divide-y divide-hairline/60">
              {analyses
                .filter((item) => item.status === 'failed')
                .map((item) => (
                  <li key={item.id} className="px-5 py-3">
                    <p className="text-[0.8125rem] leading-relaxed text-ink-muted">{item.errorMessage}</p>
                    <p className="mt-1 text-[0.75rem] text-ink-faint">
                      {formatDateTime(item.createdAt)} · modelo {item.model} · nenhuma conclusão foi registrada
                    </p>
                  </li>
                ))}
            </ul>
          </section>
        </div>
      ) : null}

      {!running && completed.length > 0 ? (
        <div className="mt-6 space-y-5">
          {completed.length > 1 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="meta-label mr-1">Análises</span>
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
        title="Solicitar análise ao Gemini"
        description="Uma chamada ao provedor será feita e consumirá uma análise da sua cota diária."
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              Cancelar
            </Button>
            <Button variant="primary" onClick={() => void requestAnalysis()} iconLeft={<Sparkles className="size-4" aria-hidden />}>
              Confirmar análise
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-[0.8125rem] leading-relaxed text-ink-muted">
          <p>
            Serão enviadas ao Google Gemini <strong className="text-ink">{formatNumber(evidence.length)}</strong>{' '}
            evidência(s) desta investigação, incluindo título, URL, domínio, data e o conteúdo recuperado de
            cada fonte, junto com o objetivo da investigação.
          </p>
          <ul className="space-y-2">
            {[
              'Toda descoberta deve citar evidências reais do conjunto enviado.',
              'Referências inexistentes invalidam a análise inteira.',
              'Contradições entre fontes são relatadas, não resolvidas arbitrariamente.',
              'Conteúdo das fontes é tratado como dado, nunca como instrução.',
            ].map((item) => (
              <li key={item} className="flex gap-2">
                <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-signal" />
                {item}
              </li>
            ))}
          </ul>
          <Notice tone="info">
            Aprovação humana de uma evidência não é atestado de veracidade científica ou jurídica.
          </Notice>
        </div>
      </Modal>
    </PageContainer>
  )
}

function AnalysisView({ analysis, evidenceCount }: { analysis: Analysis; evidenceCount: number }) {
  const evidenceById = new Map(analysis.references.map((reference) => [reference.evidenceId, reference]))

  return (
    <article className="space-y-5">
      {/* Provenance bar */}
      <div className="panel flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3">
        <Badge tone="signal" dot>
          Análise concluída
        </Badge>
        <span className="text-[0.75rem] text-ink-subtle">
          Modelo <span className="font-mono text-ink-muted">{analysis.model}</span>
        </span>
        <span className="text-[0.75rem] text-ink-subtle">{formatDateTime(analysis.createdAt)}</span>
        <span className="text-[0.75rem] text-ink-subtle">
          {analysis.evidenceIds.length} de {evidenceCount} evidência(s) enviadas
        </span>
        {analysis.usage?.totalTokens ? (
          <span className="tnum text-[0.75rem] text-ink-faint">{formatNumber(analysis.usage.totalTokens)} tokens</span>
        ) : null}
      </div>

      {analysis.insufficientEvidence ? (
        <Notice tone="caution" title="A IA considerou o conjunto de evidências insuficiente">
          O modelo declarou explicitamente que as fontes disponíveis não sustentam conclusões fortes. Leia as
          limitações e lacunas abaixo antes de usar este resultado.
        </Notice>
      ) : null}

      {/* Executive summary */}
      <section className="panel p-5" aria-labelledby="summary-heading">
        <SectionHeader title="Resumo executivo" description="Síntese produzida a partir das evidências enviadas" />
        <p className="mt-3 whitespace-pre-wrap text-pretty text-[0.875rem] leading-relaxed text-ink-muted">
          {analysis.executiveSummary || 'Nenhum resumo retornado.'}
        </p>
      </section>

      {/* Findings */}
      <section className="panel p-5" aria-labelledby="findings-heading">
        <SectionHeader
          title="Principais descobertas"
          description="Cada item cita as evidências que o sustentam"
          actions={<span className="tnum text-[0.75rem] text-ink-faint">{analysis.findings.length}</span>}
        />
        {analysis.findings.length === 0 ? (
          <p className="mt-4 text-[0.8125rem] text-ink-faint">
            Nenhuma descoberta foi apresentada — o modelo não encontrou suporte suficiente.
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
                        confiança {finding.confidence === 'high' ? 'alta' : finding.confidence === 'medium' ? 'média' : 'baixa'}
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
                            referência ausente
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
          <SectionHeader title="Pontos relevantes" description="Observações que merecem atenção" />
          {analysis.keyPoints.length === 0 ? (
            <p className="mt-3 text-[0.8125rem] text-ink-faint">Nenhum ponto destacado.</p>
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
          <SectionHeader title="Sustentado pelas fontes" description="Afirmações com respaldo direto no material enviado" />
          {analysis.supportedClaims.length === 0 ? (
            <p className="mt-3 text-[0.8125rem] text-ink-faint">Nenhuma afirmação foi marcada como diretamente sustentada.</p>
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
          title="Possíveis contradições"
          description="Divergências entre fontes que você precisa resolver"
          actions={<Scale className="size-4 text-caution" aria-hidden />}
        />
        {analysis.contradictions.length === 0 ? (
          <p className="mt-3 text-[0.8125rem] text-ink-faint">
            Nenhuma contradição foi identificada entre as evidências enviadas.
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
          <SectionHeader title="Limitações" description="O que esta análise não pode afirmar" />
          {analysis.limitations.length === 0 ? (
            <p className="mt-3 text-[0.8125rem] text-ink-faint">Nenhuma limitação declarada pelo modelo.</p>
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
          <SectionHeader title="Lacunas de informação" description="O que ainda precisa ser pesquisado" />
          {analysis.informationGaps.length === 0 ? (
            <p className="mt-3 text-[0.8125rem] text-ink-faint">Nenhuma lacuna identificada.</p>
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
        <SectionHeader title="Relação com o objetivo" description="Como o conjunto responde à pergunta da investigação" />
        <p className="mt-3 whitespace-pre-wrap text-[0.875rem] leading-relaxed text-ink-muted">
          {analysis.objectiveAlignment || 'O modelo não avaliou o alinhamento com o objetivo.'}
        </p>
      </section>

      {/* References */}
      <section className="panel p-5" aria-labelledby="references-heading">
        <SectionHeader
          title="Referências utilizadas"
          description="Somente evidências reais desta investigação podem aparecer aqui"
          actions={<span className="tnum text-[0.75rem] text-ink-faint">{analysis.references.length}</span>}
        />
        {analysis.references.length === 0 ? (
          <p className="mt-3 text-[0.8125rem] text-ink-faint">Nenhuma referência foi citada.</p>
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
          Esta síntese foi gerada por um modelo de linguagem e validada apenas quanto ao schema e à existência das
          referências. Ela não substitui verificação factual por um pesquisador.
        </p>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <Link to={`/investigations/${analysis.investigationId}/validation`}>
          <Button variant="primary" size="md" iconRight={<ArrowRight className="size-4" aria-hidden />}>
            Validar evidências
          </Button>
        </Link>
        <Link to={`/investigations/${analysis.investigationId}/evidence`}>
          <Button variant="secondary" size="md" iconLeft={<Layers className="size-4" aria-hidden />}>
            Revisar fontes
          </Button>
        </Link>
      </div>
    </article>
  )
}

function AnalysisSkeleton() {
  return (
    <div className="mt-6 space-y-4">
      <div className="panel flex items-center gap-3 px-5 py-3.5">
        <Sparkles className="size-4 animate-pulse text-signal" aria-hidden />
        <div>
          <p className="text-[0.8125rem] text-ink">Gerando análise estruturada…</p>
          <p className="mt-0.5 text-[0.75rem] text-ink-faint">
            As referências são verificadas contra as evidências reais antes de exibir o resultado.
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

function failureTitle(error: Error): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'invalid_provider_response':
        return 'A resposta da IA não passou na validação'
      case 'provider_rate_limited':
        return 'Limite do Gemini atingido'
      case 'provider_timeout':
        return 'O Gemini demorou demais para responder'
      case 'provider_auth_failed':
        return 'Falha de autenticação no Gemini'
      case 'quota_exceeded':
        return 'Limite de consumo atingido'
      case 'external_disabled':
        return 'Análise por IA desativada'
      case 'invalid_request':
        return 'Não foi possível solicitar a análise'
      default:
        return 'Não foi possível concluir a análise'
    }
  }
  return 'Não foi possível concluir a análise'
}
