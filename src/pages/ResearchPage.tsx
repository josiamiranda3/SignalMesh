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
        toast.info('Pesquisa concluída sem resultados', 'A Exa não retornou fontes para esta consulta.')
      } else {
        toast.success('Pesquisa concluída', `${response.results.length} resultado(s) retornado(s).`)
      }
    } catch (caught) {
      setFailure(caught instanceof Error ? caught : new Error('Falha desconhecida'))
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
        `${outcome.added.length} evidência(s) adicionada(s)`,
        outcome.skipped.length > 0
          ? `${outcome.skipped.length} ignorada(s): ${outcome.skipped[0]?.reason ?? ''}`
          : 'Agora você pode solicitar uma análise estruturada.',
      )
    } catch (caught) {
      toast.error('Não foi possível adicionar as evidências', caught instanceof Error ? caught.message : undefined)
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
          title="Investigação indisponível"
          description={detailError?.message ?? 'Não foi possível carregar esta investigação.'}
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
        {investigation.title}
      </Link>

      <PageHeader
        eyebrow="Pesquisa externa"
        title="Buscar fontes na web"
        description="A consulta é montada a partir do tema, das palavras-chave e do objetivo desta investigação. Os resultados vêm diretamente da API da Exa."
        meta={
          quota ? (
            <>
              <span className="text-[0.75rem] text-ink-subtle">
                Pesquisas hoje: <span className="tnum">{quota.research.used}/{quota.research.limit}</span>
              </span>
              <span aria-hidden className="size-1 rounded-full bg-hairline-strong" />
              <span className="text-[0.75rem] text-ink-subtle">
                {exhausted ? `Limite atingido · ${untilReset(quota.research.resetsAt)}` : `${quota.research.remaining} restante(s)`}
              </span>
            </>
          ) : null
        }
        actions={
          <Link to={`/investigations/${id}/evidence`}>
            <Button variant="secondary" size="md" iconLeft={<Layers className="size-4" aria-hidden />}>
              Ver evidências ({detail.evidence.length})
            </Button>
          </Link>
        }
      />

      {externalDisabled ? (
        <div className="mt-6">
          <Notice
            tone="caution"
            title="Pesquisa externa desativada"
            action={
              <Link to="/settings">
                <Button size="sm" variant="secondary">
                  Ver configuração
                </Button>
              </Link>
            }
          >
            As chamadas a provedores externos estão desligadas (ENABLE_EXTERNAL_APIS=false) ou a chave da Exa
            não está configurada no backend. Nenhuma requisição é enviada enquanto isso.
          </Notice>
        </div>
      ) : exhausted ? (
        <div className="mt-6">
          <Notice tone="caution" title="Limite diário de pesquisas atingido">
            O contador reinicia {untilReset(quota!.research.resetsAt)}. Seus dados existentes, o histórico e as
            exportações continuam disponíveis.
          </Notice>
        </div>
      ) : null}

      {/* Query form */}
      <form onSubmit={runSearch} className="panel mt-5 p-5">
        <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
          <Field
            label="Consulta"
            hint="Deixe em branco para usar o tema, as palavras-chave e o objetivo da investigação."
            counter={`${(query || suggestedQuery).length}/400`}
          >
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={suggestedQuery || 'Consulta de pesquisa'}
              maxLength={400}
              aria-label="Consulta de pesquisa"
              disabled={externalDisabled}
            />
          </Field>

          <div className="flex items-end gap-2">
            <Field label="Resultados">
              <select
                value={numResults}
                onChange={(event) => setNumResults(Number(event.target.value))}
                aria-label="Número de resultados"
                disabled={externalDisabled}
                className="h-9.5 w-[92px] rounded-md border border-hairline-strong bg-[#0b1018] px-3 text-sm text-ink focus:border-signal focus:outline-none focus:ring-2 focus:ring-signal/20"
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
              {running ? 'Pesquisando…' : 'Pesquisar'}
            </Button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
          <label className="flex min-h-9 cursor-pointer items-center gap-2 text-[0.75rem] text-ink-muted">
            <input
              type="checkbox"
              checked={includeContent}
              onChange={(event) => setIncludeContent(event.target.checked)}
              className="size-4.5 shrink-0 accent-[#5b8cff]"
              disabled={externalDisabled}
            />
            Solicitar conteúdo integral das páginas
          </label>
          <label className="flex min-h-9 cursor-pointer items-center gap-2 text-[0.75rem] text-ink-muted">
            <input
              type="checkbox"
              checked={repeat}
              onChange={(event) => setRepeat(event.target.checked)}
              className="size-4.5 shrink-0 accent-[#5b8cff]"
              disabled={externalDisabled}
            />
            Repetir mesmo que idêntica recente
          </label>
          <span className="text-[0.75rem] text-ink-faint">
            Cada execução consome uma pesquisa da sua cota diária.
          </span>
        </div>
      </form>

      {/* Failure state */}
      {failure ? (
        <div className="mt-5">
          <Notice
            tone="danger"
            title={titleForFailure(failure)}
            action={
              <Button size="sm" variant="secondary" onClick={() => setFailure(null)}>
                Dispensar
              </Button>
            }
          >
            <p>{failure.message}</p>
            {failure instanceof ApiError && failure.code === 'rate_limited' ? (
              <p className="mt-2 text-[0.75rem] text-ink-subtle">
                Para repetir conscientemente, marque “Repetir mesmo que idêntica recente” e execute novamente.
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
            title="Nenhuma pesquisa executada nesta sessão"
            description="Execute uma consulta para ver fontes reais retornadas pela Exa. Os resultados não são armazenados até que você selecione e adicione como evidência."
            action={
              suggestedQuery ? (
                <Button variant="secondary" size="sm" onClick={() => setQuery(suggestedQuery)}>
                  Usar consulta sugerida
                </Button>
              ) : undefined
            }
          />
        ) : results.length === 0 ? (
          <EmptyState
            icon={<Search className="size-5" aria-hidden />}
            title="A pesquisa não retornou resultados"
            description="A Exa não encontrou fontes para esta consulta. Tente termos mais amplos, remova restrições ou reformule o objetivo da investigação."
            compact
          />
        ) : (
          <div className="space-y-4">
            <div className="panel flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-[0.8125rem] text-ink">
                  <span className="tnum font-medium">{results.length}</span> resultado(s) · consulta executada{' '}
                  {formatRelative(result.executedAt)}
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
                  Selecionar todos
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
                  Limpar
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => void addSelected()}
                  loading={adding}
                  disabled={selected.size === 0}
                  iconLeft={<Layers className="size-3.5" aria-hidden />}
                >
                  Adicionar {selected.size > 0 ? `${selected.size} ` : ''}como evidência
                </Button>
              </div>
            </div>

            <Notice tone="info" title="Conteúdo retornado pelo provedor">
              {result.contentNotice}
              {result.costUsd !== null ? (
                <span className="ml-1 text-ink-subtle">Custo informado pela Exa: US$ {result.costUsd.toFixed(4)}.</span>
              ) : null}
            </Notice>

            {addedCount !== null && addedCount > 0 ? (
              <Notice
                tone="positive"
                title={`${addedCount} evidência(s) adicionada(s)`}
                action={
                  <Link to={`/investigations/${id}/analysis`}>
                    <Button size="sm" variant="secondary" iconRight={<ArrowRight className="size-3.5" aria-hidden />}>
                      Solicitar análise
                    </Button>
                  </Link>
                }
              >
                As fontes foram persistidas com URL, trecho, conteúdo disponível e índice de priorização.
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
        <Notice tone="info" title="Sobre os resultados">
          O SignalMesh exibe exatamente o que a API da Exa retorna. Quando apenas título e trecho estão
          disponíveis, isso é indicado em cada resultado — o sistema não preenche lacunas com texto inventado.
          Conteúdo de páginas é tratado como dado não confiável e nunca como instrução.
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
          aria-label={selected ? `Desmarcar ${item.title}` : `Selecionar ${item.title}`}
          className={cn(
            'mt-0.5 flex size-4.5 shrink-0 items-center justify-center rounded border transition-colors',
            item.alreadyAdded
              ? 'cursor-not-allowed border-positive/40 bg-positive/15 text-positive'
              : selected
                ? 'border-signal bg-signal text-[#050912]'
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
                    Já adicionada
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
                  <span className="text-ink-faint">sem data de publicação</span>
                )}
                {item.author ? (
                  <span className="flex items-center gap-1">
                    <User className="size-3" aria-hidden />
                    {item.author}
                  </span>
                ) : null}
                <span className="flex items-center gap-1">
                  <FileText className="size-3" aria-hidden />
                  {hasFullText ? 'conteúdo integral' : item.contentAvailability.includes('highlights') ? 'apenas trechos' : 'apenas metadados'}
                </span>
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-3">
              <div className="text-right">
                <p className="meta-label">Prioridade</p>
                <p className={cn('tnum text-[0.8125rem] font-semibold', score >= 70 ? 'text-positive' : score >= 45 ? 'text-signal-bright' : 'text-caution')}>
                  {score}
                </p>
              </div>
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="rounded-md border border-hairline-strong bg-raised p-1.5 text-ink-subtle transition-colors hover:border-[#39445c] hover:text-ink"
                  aria-label={`Abrir fonte original: ${item.title}`}
                  title="Abrir fonte original"
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
            <p className="mt-2.5 text-[0.8125rem] italic text-ink-faint">Nenhum trecho retornado pelo provedor.</p>
          )}

          <div className="mt-2.5 flex flex-wrap items-center gap-3">
            {item.retrievedContent ? (
              <button
                type="button"
                onClick={onExpand}
                className="text-[0.75rem] font-medium text-signal-bright transition-colors hover:text-signal"
                aria-expanded={expanded}
              >
                {expanded ? 'Ocultar conteúdo recuperado' : 'Ver conteúdo recuperado'}
              </button>
            ) : null}
            <span className="truncate text-[0.75rem] text-ink-faint">{item.url}</span>
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(item.url)}
              className="flex items-center gap-1 text-[0.75rem] text-ink-faint transition-colors hover:text-ink-muted"
              aria-label="Copiar URL"
            >
              <Copy className="size-3" aria-hidden />
              copiar
            </button>
          </div>

          {expanded && item.retrievedContent ? (
            <div className="mt-3 max-h-72 overflow-y-auto rounded-md border border-hairline bg-[#0a0e16] p-3">
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
  return (
    <div className="space-y-2.5">
      <div className="panel flex items-center gap-3 px-5 py-3.5">
        <Loader2 className="size-4 animate-spin text-signal" aria-hidden />
        <p className="text-[0.8125rem] text-ink-muted">Consultando a Exa…</p>
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

function titleForFailure(failure: Error): string {
  if (failure instanceof ApiError) {
    switch (failure.code) {
      case 'external_disabled':
        return 'Pesquisa externa desativada'
      case 'quota_exceeded':
        return 'Limite de consumo atingido'
      case 'rate_limited':
        return 'Pesquisa duplicada ou em andamento'
      case 'provider_auth_failed':
        return 'Falha de autenticação no provedor'
      case 'provider_rate_limited':
        return 'Limite do provedor atingido'
      case 'provider_timeout':
        return 'O provedor demorou demais para responder'
      case 'provider_unavailable':
        return 'Provedor indisponível'
      case 'invalid_provider_response':
        return 'Resposta inválida do provedor'
      default:
        return 'Não foi possível concluir a pesquisa'
    }
  }
  return 'Não foi possível concluir a pesquisa'
}
