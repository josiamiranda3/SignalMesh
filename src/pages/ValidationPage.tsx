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
          title="Fila de validação indisponível"
          description={error?.message ?? 'Não foi possível carregar as evidências para validação.'}
          action={
            <Link to="/investigations">
              <Button variant="primary">Voltar para investigações</Button>
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
        eyebrow="Validação humana"
        title={routeId ? 'Decidir sobre as evidências' : 'Fila de validação'}
        description="A IA organiza; a decisão é sua. Aprovar significa que a fonte é adequada para esta investigação — não que o conteúdo seja cientificamente ou juridicamente verdadeiro."
        meta={
          <>
            <span className="text-[0.75rem] text-ink-subtle">{formatNumber(rows.length)} evidência(s) no total</span>
            <span aria-hidden className="size-1 rounded-full bg-hairline-strong" />
            <span className="text-[0.75rem] text-caution">
              {counts.needs_review + counts.pending} aguardando decisão
            </span>
          </>
        }
      />

      <Tabs
        className="mt-6"
        ariaLabel="Filtrar evidências por status de validação"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'pending', label: 'Pendentes', count: counts.pending },
          { value: 'needs_review', label: 'Em revisão', count: counts.needs_review },
          { value: 'accepted', label: 'Aprovadas', count: counts.accepted },
          { value: 'rejected', label: 'Rejeitadas', count: counts.rejected },
        ]}
      />

      <div className="mt-5">
        {visible.length === 0 ? (
          <EmptyState
            icon={tab === 'pending' ? <Check className="size-5" aria-hidden /> : <ShieldQuestion className="size-5" aria-hidden />}
            title={
              tab === 'pending'
                ? 'Nenhuma evidência pendente'
                : tab === 'accepted'
                  ? 'Nenhuma evidência aprovada ainda'
                  : tab === 'rejected'
                    ? 'Nenhuma evidência rejeitada'
                    : 'Nenhuma evidência em revisão'
            }
            description={
              rows.length === 0
                ? 'Adicione fontes a uma investigação para começar a validar. Cada decisão fica registrada com autor, justificativa e data.'
                : 'Troque de aba para ver as evidências em outro estado, ou adicione novas fontes à investigação.'
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
        <Notice tone="info" title="O que cada decisão significa">
          <ul className="mt-1 space-y-1">
            <li>
              <strong className="text-ink">Aprovada</strong> — a fonte é pertinente e utilizável como suporte nesta
              investigação.
            </li>
            <li>
              <strong className="text-ink">Em revisão</strong> — há dúvida sobre adequação, data ou método; exige
              verificação adicional.
            </li>
            <li>
              <strong className="text-ink">Rejeitada</strong> — a fonte não deve sustentar conclusões desta
              investigação.
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
              ? 'Evidência aprovada'
              : status === 'rejected'
                ? 'Evidência rejeitada'
                : 'Revisão solicitada',
            'A decisão foi registrada no histórico com sua justificativa.',
          )
        }}
        onError={(message) => toast.error('Não foi possível registrar a decisão', message)}
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
            <span>{evidence.domain || 'domínio desconhecido'}</span>
            <span aria-hidden>·</span>
            <span>{evidence.publishedAt ? formatDateTime(evidence.publishedAt) : 'sem data de publicação'}</span>
            <span aria-hidden>·</span>
            <span>coletada {formatRelative(evidence.collectedAt)}</span>
            {evidence.relevanceScore !== null ? (
              <>
                <span aria-hidden>·</span>
                <span className="tnum">prioridade {Math.round(evidence.relevanceScore * 100)}</span>
              </>
            ) : null}
          </div>

          {evidence.snippet ? (
            <p className="mt-2 line-clamp-2 text-[0.75rem] leading-relaxed text-ink-subtle">{evidence.snippet}</p>
          ) : null}

          {lastDecision?.justification ? (
            <div className="mt-2.5 rounded-md border border-hairline bg-raised/40 px-2.5 py-2">
              <p className="meta-label mb-1">Última justificativa</p>
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
            Aprovar
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onDecide('needs_review')}
            iconLeft={<CircleHelp className="size-3.5" aria-hidden />}
            className="lg:justify-start"
          >
            Revisão
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => onDecide('rejected')}
            iconLeft={<ThumbsDown className="size-3.5" aria-hidden />}
            className="lg:justify-start"
          >
            Rejeitar
          </Button>
          <div className="flex items-center gap-1.5 lg:justify-between">
            <Button variant="quiet" size="sm" onClick={onHistory} iconLeft={<History className="size-3.5" aria-hidden />}>
              Histórico
            </Button>
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="rounded-md p-1.5 text-ink-faint transition-colors hover:bg-white/5 hover:text-ink-muted"
                aria-label="Abrir fonte original"
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
  const [justification, setJustification] = useState('')
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const requiresJustification = target?.status === 'rejected' || target?.status === 'needs_review'

  const submit = async () => {
    if (!target) return
    if (requiresJustification && justification.trim().length < 3) {
      setLocalError('Informe uma justificativa com pelo menos 3 caracteres para esta decisão.')
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
      const message = caught instanceof Error ? caught.message : 'Erro inesperado'
      setLocalError(message)
      onError(message)
    } finally {
      setBusy(false)
    }
  }

  const verbFor = (status: ValidationStatus): string =>
    status === 'accepted'
      ? 'aprovar'
      : status === 'rejected'
        ? 'rejeitar'
        : status === 'needs_review'
          ? 'solicitar revisão de'
          : 'marcar como pendente'

  return (
    <Modal
      open={Boolean(target)}
      onClose={() => {
        setJustification('')
        setLocalError(null)
        onClose()
      }}
      title={target ? `Deseja ${verbFor(target.status)} esta evidência?` : 'Registrar decisão'}
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
            Cancelar
          </Button>
          <Button
            variant={target?.status === 'rejected' ? 'danger' : 'primary'}
            onClick={() => void submit()}
            loading={busy}
          >
            Confirmar decisão
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
                Nova decisão: {validationLabel(target.status)}
              </Badge>
              <span className="text-[0.75rem] text-ink-faint">
                anterior: {validationLabel(target.evidence.validationStatus)}
              </span>
            </div>
            <p className="mt-2 text-[0.75rem] leading-relaxed text-ink-subtle">
              {target.status === 'accepted'
                ? 'A fonte será marcada como adequada para sustentar conclusões desta investigação.'
                : target.status === 'rejected'
                  ? 'A fonte deixará de ser considerada adequada. A justificativa é obrigatória e ficará no histórico.'
                  : 'A fonte ficará marcada como pendente de verificação adicional. Explique o que precisa ser conferido.'}
            </p>
          </div>
        ) : null}

        <Field
          label="Justificativa"
          optional={!requiresJustification}
          hint={
            requiresJustification
              ? 'Obrigatória: explique objetivamente o motivo da decisão.'
              : 'Opcional, mas recomendada para preservar o raciocínio da decisão.'
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
                ? 'Ex.: fonte sem data, sem autoria e sem metodologia descrita.'
                : target?.status === 'needs_review'
                  ? 'Ex.: confirmar se os dados de 2023 foram revisados após a mudança regulatória.'
                  : 'Ex.: relatório oficial com metodologia e dados primários.'
            }
            aria-label="Justificativa da decisão"
          />
        </Field>

        <Notice tone="info">
          A decisão é registrada com seu usuário, data e hora. Alterar a decisão depois cria um novo evento — nada é
          apagado.
        </Notice>
      </div>
    </Modal>
  )
}

function HistoryModal({ evidence, onClose }: { evidence: Evidence | null; onClose: () => void }) {
  const { data, error, loading } = useAsync<Validation[]>(
    () => (evidence ? api.get<Validation[]>(`/api/evidence/${evidence.id}/validations`) : Promise.resolve([])),
    [evidence?.id],
  )

  return (
    <Modal
      open={Boolean(evidence)}
      onClose={onClose}
      title="Histórico de validação"
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
          Nenhuma decisão registrada. A evidência está no estado inicial.
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
                <p className="mt-1.5 text-[0.75rem] italic text-ink-faint">Sem justificativa registrada.</p>
              )}
              <p className="mt-1 text-[0.75rem] text-ink-faint">{formatDateTime(item.createdAt)}</p>
            </li>
          ))}
        </ol>
      )}
    </Modal>
  )
}
