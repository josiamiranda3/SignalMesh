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
import { api, ApiError, downloadFile } from '@/lib/api'
import { useAsync } from '@/hooks/useAsync'
import { PageContainer, PageHeader, SectionHeader } from '@/components/layout/Page'
import { InlineStat } from '@/components/dashboard/MetricCard'
import {
  Button,
  EmptyState,
  Field,
  Input,
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
        <div className="mt-7 grid gap-4 sm:grid-cols-4">
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
          title="Investigação não encontrada"
          description={
            error?.message ??
            'Esta investigação não existe ou não pertence à sua conta. Por segurança, o sistema não confirma a existência de registros de outros usuários.'
          }
          action={
            <Link to="/investigations">
              <Button variant="primary">Voltar para investigações</Button>
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
      toast.success('Status atualizado', `Agora como ${investigationStatusLabel(status).toLowerCase()}.`)
      reload()
    } catch (caught) {
      toast.error('Não foi possível alterar o status', caught instanceof Error ? caught.message : undefined)
    } finally {
      setBusy(null)
    }
  }

  const archive = async () => {
    setBusy('archive')
    try {
      await api.post(`/api/investigations/${id}/archive`)
      toast.success('Investigação arquivada', 'O histórico e as evidências permanecem disponíveis.')
      reload()
    } catch (caught) {
      toast.error('Não foi possível arquivar', caught instanceof Error ? caught.message : undefined)
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    setBusy('delete')
    try {
      await api.delete(`/api/investigations/${id}`)
      toast.success('Investigação excluída', 'Evidências, análises e validações relacionadas foram removidas.')
      navigate('/investigations', { replace: true })
    } catch (caught) {
      toast.error('Não foi possível excluir', caught instanceof Error ? caught.message : undefined)
      setBusy(null)
    }
  }

  return (
    <PageContainer>
      <div className="mb-5 flex min-h-9 items-center gap-1.5 text-[0.75rem] text-ink-faint">
        <Link to="/investigations" className="inline-flex min-h-9 items-center transition-colors hover:text-ink-muted">
          Investigações
        </Link>
        <span aria-hidden>/</span>
        <span className="truncate text-ink-muted">{investigation.title}</span>
      </div>

      <PageHeader
        eyebrow="Investigação"
        title={investigation.title}
        description={investigation.description || investigation.topic}
        meta={
          <>
            <InvestigationStatusBadge status={investigation.status} />
            <span className="text-[0.75rem] text-ink-subtle">Criada em {formatDate(investigation.createdAt)}</span>
            <span aria-hidden className="size-1 rounded-full bg-hairline-strong" />
            <span className="text-[0.75rem] text-ink-subtle">Atualizada {formatRelative(investigation.updatedAt)}</span>
          </>
        }
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => setEditOpen(true)} iconLeft={<Pencil className="size-3.5" aria-hidden />}>
              Editar
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setExportOpen(true)} iconLeft={<Download className="size-3.5" aria-hidden />}>
              Exportar
            </Button>
            <Link to={`/investigations/${id}/research`}>
              <Button variant="primary" size="sm" iconLeft={<Play className="size-3.5" aria-hidden />}>
                Pesquisar
              </Button>
            </Link>
          </>
        }
      />

      {/* Objective — the anchor of the whole investigation */}
      <section className="panel mt-6 p-5" aria-labelledby="objective-heading">
        <h2 id="objective-heading" className="eyebrow">
          Objetivo da pesquisa
        </h2>
        <p className="mt-2 text-pretty text-[0.875rem] leading-relaxed text-ink-muted">{investigation.objective}</p>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span className="text-[0.75rem] text-ink-subtle">
            <span className="meta-label mr-1.5">Tema</span>
            {investigation.topic}
          </span>
          {investigation.keywords.length > 0 ? (
            <span className="text-[0.75rem] text-ink-subtle">
              <span className="meta-label mr-1.5">Palavras-chave</span>
              {investigation.keywords.join(' · ')}
            </span>
          ) : null}
        </div>
      </section>

      {/* Counts */}
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="panel p-4">
          <InlineStat label="Evidências" value={formatNumber(counts.evidence)} />
          <p className="mt-2 text-[0.75rem] text-ink-faint">{pending} aguardando decisão</p>
        </div>
        <div className="panel p-4">
          <InlineStat label="Aprovadas" value={formatNumber(counts.byValidationStatus['accepted'] ?? 0)} tone="positive" />
          <p className="mt-2 text-[0.75rem] text-ink-faint">Decisão humana registrada</p>
        </div>
        <div className="panel p-4">
          <InlineStat label="Análises" value={formatNumber(counts.analyses)} tone="signal" />
          <p className="mt-2 text-[0.75rem] text-ink-faint">
            {latestAnalysis ? `Última em ${formatDate(latestAnalysis.createdAt)}` : 'Nenhuma análise concluída'}
          </p>
        </div>
        <div className="panel p-4">
          <InlineStat label="Validações" value={formatNumber(counts.validations)} />
          <p className="mt-2 text-[0.75rem] text-ink-faint">Eventos de decisão no histórico</p>
        </div>
      </div>

      {/* Workflow shortcuts */}
      <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <WorkflowCard
          to={`/investigations/${id}/research`}
          icon={<Play className="size-4" aria-hidden />}
          step="01"
          title="Pesquisa externa"
          description="Consulte a Exa com o tema e o objetivo desta investigação."
          footer={evidence.length === 0 ? 'Comece aqui' : 'Executar nova pesquisa'}
        />
        <WorkflowCard
          to={`/investigations/${id}/evidence`}
          icon={<Layers className="size-4" aria-hidden />}
          step="02"
          title="Evidências"
          description="Revise fontes coletadas, notas e o índice de priorização."
          footer={`${formatNumber(counts.evidence)} fonte(s)`}
        />
        <WorkflowCard
          to={`/investigations/${id}/analysis`}
          icon={<Sparkles className="size-4" aria-hidden />}
          step="03"
          title="Análise estruturada"
          description="Solicite ao Gemini descobertas, contradições e limitações."
          footer={latestAnalysis ? 'Ver última análise' : 'Nenhuma análise ainda'}
        />
        <WorkflowCard
          to={`/investigations/${id}/validation`}
          icon={<BadgeCheck className="size-4" aria-hidden />}
          step="04"
          title="Validação humana"
          description="Aprove, rejeite ou peça revisão com justificativa."
          footer={`${pending} pendente(s)`}
        />
      </div>

      {/* Recent evidence + activity */}
      <div className="mt-5 grid gap-5 lg:grid-cols-[1.35fr_1fr]">
        <section className="panel overflow-hidden" aria-labelledby="recent-evidence">
          <div className="flex items-center justify-between border-b border-hairline px-5 py-3.5">
            <h2 id="recent-evidence" className="text-[0.9375rem] font-semibold text-ink">
              Evidências recentes
            </h2>
            <Link
              to={`/investigations/${id}/evidence`}
              className="flex min-h-9 items-center gap-1 text-[0.75rem] text-ink-subtle transition-colors hover:text-ink"
            >
              Ver todas
              <ArrowRight className="size-3" aria-hidden />
            </Link>
          </div>
          {evidence.length === 0 ? (
            <div className="px-5 py-10">
              <EmptyState
                compact
                icon={<Layers className="size-5" aria-hidden />}
                title="Nenhuma evidência coletada"
                description="Execute uma pesquisa e selecione os resultados relevantes para transformá-los em evidências rastreáveis."
                action={
                  <Link to={`/investigations/${id}/research`}>
                    <Button variant="primary" size="sm">
                      Executar pesquisa
                    </Button>
                  </Link>
                }
              />
            </div>
          ) : (
            <ul className="divide-y divide-hairline/70">
              {evidence.slice(0, 5).map((item) => (
                <li key={item.id} className="px-5 py-3">
                  <p className="truncate text-[0.8125rem] font-medium text-ink">{item.title}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.75rem] text-ink-faint">
                    <span>{item.domain || 'domínio desconhecido'}</span>
                    <span aria-hidden>·</span>
                    <span>{validationLabel(item.validationStatus)}</span>
                    {item.relevanceScore !== null ? (
                      <>
                        <span aria-hidden>·</span>
                        <span className="tnum">prioridade {Math.round(item.relevanceScore * 100)}</span>
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
              Atividades
            </h2>
            <Link to="/history" className="inline-flex min-h-9 items-center text-[0.75rem] text-ink-subtle transition-colors hover:text-ink">
              Histórico
            </Link>
          </div>
          {data.activity.length === 0 ? (
            <p className="px-5 py-8 text-center text-[0.8125rem] text-ink-faint">Nenhum evento registrado.</p>
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
          title="Gerenciar investigação"
          description="Alterações de status e ações destrutivas ficam registradas no histórico."
        />
        <div id="manage-heading" className="mt-4 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="w-full max-w-xs">
            <Field label="Status" hint="Concluída indica que a investigação atingiu seu objetivo.">
              <Select
                aria-label="Alterar status da investigação"
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
              Arquivar
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => setDeleteOpen(true)}
              iconLeft={<Trash2 className="size-3.5" aria-hidden />}
            >
              Excluir investigação
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
          toast.success('Investigação atualizada')
        }}
      />

      <ExportModal
        open={exportOpen}
        investigationId={id}
        onClose={() => setExportOpen(false)}
        onExported={(filename) => toast.success('Exportação gerada', filename)}
        onError={(message) => toast.error('Falha na exportação', message)}
      />

      <Modal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Excluir esta investigação?"
        description="Esta ação não pode ser desfeita."
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)}>
              Cancelar
            </Button>
            <Button variant="danger" onClick={() => void remove()} loading={busy === 'delete'}>
              Excluir definitivamente
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-[0.8125rem] leading-relaxed text-ink-muted">
          <p>
            Serão removidos <strong className="text-ink">{formatNumber(counts.evidence)}</strong> evidência(s),{' '}
            <strong className="text-ink">{formatNumber(counts.analyses)}</strong> análise(s) e{' '}
            <strong className="text-ink">{formatNumber(counts.validations)}</strong> registro(s) de validação
            vinculados a esta investigação.
          </p>
          <Notice tone="caution">
            Se você quiser preservar o conteúdo, gere uma exportação JSON antes de excluir. O evento de exclusão
            permanece no histórico da sua conta.
          </Notice>
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
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const submit = async () => {
    setFormError(null)
    const parsed = investigationUpdateSchema.safeParse({ title, topic, objective, description })
    if (!parsed.success) {
      const fieldErrors: Record<string, string> = {}
      for (const issue of parsed.error.issues) {
        const key = issue.path.join('.') || 'form'
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
        setFormError('Não foi possível salvar as alterações.')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Editar investigação"
      description="Alterar o objetivo afeta a próxima consulta e as próximas análises; evidências já coletadas mantêm a nota calculada no momento da coleta."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={() => void submit()} loading={saving}>
            Salvar alterações
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
        <Field label="Título" error={errors['title']}>
          <Input value={title} maxLength={160} onChange={(event) => setTitle(event.target.value)} invalid={Boolean(errors['title'])} />
        </Field>
        <Field label="Tema" error={errors['topic']}>
          <Input value={topic} maxLength={300} onChange={(event) => setTopic(event.target.value)} invalid={Boolean(errors['topic'])} />
        </Field>
        <Field label="Objetivo" error={errors['objective']}>
          <Textarea
            value={objective}
            maxLength={2000}
            rows={4}
            onChange={(event) => setObjective(event.target.value)}
            invalid={Boolean(errors['objective'])}
          />
        </Field>
        <Field label="Descrição" optional error={errors['description']}>
          <Textarea
            value={description}
            maxLength={4000}
            rows={3}
            onChange={(event) => setDescription(event.target.value)}
            invalid={Boolean(errors['description'])}
          />
        </Field>
      </form>
    </Modal>
  )
}

const EXPORT_SCOPES = [
  { value: 'investigation', label: 'Investigação completa', description: 'Todos os dados relacionados' },
  { value: 'evidence', label: 'Somente evidências', description: 'Fontes com notas e prioridade' },
  { value: 'analyses', label: 'Somente análises', description: 'Descobertas, contradições e limitações' },
  { value: 'validations', label: 'Somente validações', description: 'Decisões humanas e justificativas' },
  { value: 'history', label: 'Somente histórico', description: 'Trilha de auditoria de eventos' },
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

  const download = async () => {
    setDownloading(true)
    try {
      const filename = await downloadFile(`/api/investigations/${investigationId}/export`, { format, scope })
      onExported(filename)
      onClose()
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'Erro inesperado')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Exportar investigação"
      description="Arquivos incluem identificadores e relações para reconstruir os dados."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            onClick={() => void download()}
            loading={downloading}
            iconLeft={<Download className="size-4" aria-hidden />}
          >
            Baixar arquivo
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <p className="meta-label mb-2">Formato</p>
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
                    : 'border-hairline-strong bg-raised/40 text-ink-muted hover:border-[#39445c]'
                }`}
              >
                <FileJson className="size-4" aria-hidden />
                <span>
                  <span className="block text-[0.8125rem] font-medium uppercase">{value}</span>
                  <span className="block text-[0.75rem] text-ink-faint">
                    {value === 'json' ? 'Estrutura completa' : 'Planilha achatada'}
                  </span>
                </span>
                {format === value ? <CheckCircle2 className="ml-auto size-4 text-signal-bright" aria-hidden /> : null}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="meta-label mb-2">Escopo</p>
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
                  {scope === item.value ? <span className="size-1.5 rounded-full bg-[#050912]" /> : null}
                </span>
                <span className="min-w-0">
                  <span className="block text-[0.8125rem] text-ink">{item.label}</span>
                  <span className="block text-[0.75rem] text-ink-faint">{item.description}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        <Notice tone="info">
          A exportação inclui apenas dados da sua conta nesta investigação. Credenciais, tokens de sessão e dados
          de outros usuários nunca são incluídos.
        </Notice>
      </div>
    </Modal>
  )
}
