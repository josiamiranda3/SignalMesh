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
import { cn } from '@/lib/utils'

/**
 * Evidence list.
 *
 * Every row shows the source, its provenance (domain, dates, content
 * availability) and the prioritisation index with an expandable explanation.
 * Notes and deletion live here; the validation decision lives on the dedicated
 * validation screen so the workflow stays legible.
 */
export default function EvidencePage() {
  const { id = '' } = useParams()
  const toast = useToast()
  const { data, error, loading, reload } = useAsync<InvestigationDetail>(
    () => api.get<InvestigationDetail>(`/api/investigations/${id}`),
    [id],
  )

  const [statusFilter, setStatusFilter] = useState<'' | ValidationStatus>('')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [noteTarget, setNoteTarget] = useState<Evidence | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Evidence | null>(null)
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

  const saveNote = async (note: string) => {
    if (!noteTarget) return
    setBusy(true)
    try {
      await api.patch(`/api/evidence/${noteTarget.id}`, { note })
      toast.success('Observação salva')
      setNoteTarget(null)
      reload()
    } catch (caught) {
      toast.error('Não foi possível salvar a observação', caught instanceof Error ? caught.message : undefined)
    } finally {
      setBusy(false)
    }
  }

  const removeEvidence = async () => {
    if (!deleteTarget) return
    setBusy(true)
    try {
      await api.delete(`/api/evidence/${deleteTarget.id}`)
      toast.success('Evidência excluída', 'O evento foi registrado no histórico da investigação.')
      setDeleteTarget(null)
      reload()
    } catch (caught) {
      toast.error('Não foi possível excluir', caught instanceof Error ? caught.message : undefined)
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
          title="Investigação indisponível"
          description={error?.message ?? 'Não foi possível carregar as evidências.'}
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
        eyebrow="Evidências"
        title="Fontes coletadas"
        description="Cada evidência preserva a URL original, o conteúdo efetivamente recuperado e o índice de priorização calculado no momento da coleta."
        meta={
          <>
            <span className="text-[0.75rem] text-ink-subtle">{formatNumber(evidence.length)} evidência(s)</span>
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
            <Link to={`/investigations/${id}/research`}>
              <Button variant="secondary" size="md" iconLeft={<Search className="size-4" aria-hidden />}>
                Pesquisar mais
              </Button>
            </Link>
            <Link to={`/investigations/${id}/validation`}>
              <Button variant="primary" size="md">
                Validar evidências
              </Button>
            </Link>
          </>
        }
      />

      {evidence.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={<Layers className="size-5" aria-hidden />}
            title="Nenhuma evidência nesta investigação"
            description="Execute uma pesquisa externa e selecione os resultados que sustentam o objetivo da investigação. Evidências só existem depois de serem explicitamente adicionadas por você."
            action={
              <Link to={`/investigations/${id}/research`}>
                <Button variant="primary" iconLeft={<Search className="size-4" aria-hidden />}>
                  Executar pesquisa
                </Button>
              </Link>
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
                placeholder="Buscar por título, domínio ou trecho"
                aria-label="Buscar evidências"
                className="pl-9"
              />
              {search ? (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  aria-label="Limpar busca"
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-ink-faint hover:bg-white/5 hover:text-ink-muted"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              ) : null}
            </div>
            <div className="relative sm:w-[188px]">
              <Filter className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" aria-hidden />
              <Select
                aria-label="Filtrar por status de validação"
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
                title="Nenhuma evidência corresponde aos filtros"
                description="Ajuste a busca ou o status para ver outras fontes desta investigação."
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

      <NoteModal
        evidence={noteTarget}
        busy={busy}
        onClose={() => setNoteTarget(null)}
        onSave={(note) => void saveNote(note)}
      />

      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        title="Excluir evidência?"
        description="A fonte e sua análise de prioridade serão removidas desta investigação."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              Cancelar
            </Button>
            <Button variant="danger" onClick={() => void removeEvidence()} loading={busy}>
              Excluir
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-[0.8125rem] leading-relaxed text-ink-muted">
          <p className="font-medium text-ink">{deleteTarget?.title}</p>
          <p className="break-all text-[0.75rem] text-ink-faint">{deleteTarget?.url}</p>
          <Notice tone="caution">
            Análises já geradas que citam esta evidência mantêm a referência no registro histórico, mas a fonte não
            estará mais disponível para consulta. O evento de exclusão é registrado no histórico.
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
                    {evidence.domain || 'domínio desconhecido'}
                  </span>
                  <span className="flex items-center gap-1">
                    <CalendarDays className="size-3" aria-hidden />
                    {evidence.publishedAt ? formatDateTime(evidence.publishedAt) : 'sem data de publicação'}
                  </span>
                  <span>coletada {formatRelative(evidence.collectedAt)}</span>
                  <span className="flex items-center gap-1">
                    <FileText className="size-3" aria-hidden />
                    {hasContent ? 'conteúdo integral' : 'apenas trecho'}
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
                    Abrir fonte
                  </Button>
                </a>
              ) : (
                <Badge tone="negative">URL inválida</Badge>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={onExpand}
                aria-expanded={expanded}
                iconLeft={<Lightbulb className="size-3" aria-hidden />}
              >
                {expanded ? 'Ocultar prioridade' : 'Por que esta prioridade'}
              </Button>
              <Button variant="ghost" size="sm" onClick={onNote} iconLeft={<MessageSquare className="size-3" aria-hidden />}>
                {evidence.note ? 'Editar observação' : 'Adicionar observação'}
              </Button>
              <Link to={`/investigations/${investigationId}/validation`}>
                <Button variant="ghost" size="sm">
                  Validar
                </Button>
              </Link>
              <Button
                variant="quiet"
                size="sm"
                onClick={onDelete}
                className="ml-auto text-ink-faint hover:text-negative"
                iconLeft={<Trash2 className="size-3" aria-hidden />}
              >
                Excluir
              </Button>
            </div>
          </div>
        </div>

        {expanded ? (
          <div className="mt-4 grid gap-4 border-t border-hairline pt-4 lg:grid-cols-2">
            <div>
              <p className="meta-label mb-2">Composição do índice</p>
              {evidence.relevanceBreakdown ? (
                <dl className="space-y-2">
                  {[
                    { key: 'topical', label: 'Relevância temática', value: evidence.relevanceBreakdown.topical },
                    { key: 'recency', label: 'Atualidade', value: evidence.relevanceBreakdown.recency },
                    { key: 'sourceQuality', label: 'Qualidade da fonte', value: evidence.relevanceBreakdown.sourceQuality },
                    { key: 'objectiveAlignment', label: 'Alinhamento ao objetivo', value: evidence.relevanceBreakdown.objectiveAlignment },
                  ].map((component) => (
                    <div key={component.key} className="flex items-center gap-2.5">
                      <dt className="w-40 shrink-0 text-[0.75rem] text-ink-subtle">{component.label}</dt>
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#161c29]">
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
                <p className="text-[0.75rem] text-ink-faint">Sem dados de priorização para esta fonte.</p>
              )}
            </div>

            <div>
              <p className="meta-label mb-2">Justificativa</p>
              <ul className="space-y-1.5">
                {(evidence.relevanceBreakdown?.rationale ?? ['Nenhuma justificativa registrada.']).map((reason, index) => (
                  <li key={index} className="flex gap-2 text-[0.75rem] leading-relaxed text-ink-subtle">
                    <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-hairline-strong" />
                    {reason}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-[0.75rem] leading-relaxed text-ink-faint">
                Este índice ordena a atenção do pesquisador. Ele não é uma probabilidade de veracidade nem um
                julgamento sobre a qualidade científica da fonte.
              </p>
            </div>
          </div>
        ) : null}

        {expanded && evidence.retrievedContent ? (
          <div className="mt-3 max-h-64 overflow-y-auto rounded-md border border-hairline bg-[#0a0e16] p-3">
            <p className="whitespace-pre-wrap text-[0.75rem] leading-relaxed text-ink-subtle">
              {truncate(evidence.retrievedContent, 6000)}
            </p>
          </div>
        ) : null}
      </div>
    </li>
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
  return (
    <Modal
      open={Boolean(evidence)}
      onClose={onClose}
      title="Observação da evidência"
      description="Registre por que esta fonte é relevante, ressalvas ou o que ainda precisa ser verificado."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" type="submit" form="evidence-note-form" loading={busy}>
            Salvar observação
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
        <Field label="Observação">
          <Textarea
            name="note"
            defaultValue={evidence?.note ?? ''}
            rows={5}
            maxLength={4000}
            placeholder="Ex.: dado de 2023, precisa de confirmação em fonte primária."
          />
        </Field>
      </form>
    </Modal>
  )
}
