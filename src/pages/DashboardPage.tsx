import { Link } from 'react-router-dom'
import {
  Activity,
  ArrowRight,
  BadgeCheck,
  CircleDashed,
  FlaskConical,
  Gauge,
  Layers,
  Plus,
  Sparkles,
} from 'lucide-react'
import type { DashboardSummary } from '@shared/api'
import { api } from '@/lib/api'
import { useAsync } from '@/hooks/useAsync'
import { PageContainer, PageHeader, SectionHeader } from '@/components/layout/Page'
import { MetricCard } from '@/components/dashboard/MetricCard'
import { Sparkline, BarDistribution } from '@/components/charts/Charts'
import {
  Button,
  EmptyState,
  InvestigationStatusBadge,
  Meter,
  Notice,
  Skeleton,
  SkeletonStats,
  validationLabel,
} from '@/components/ui'
import { formatNumber, formatRelative, formatDate, untilReset } from '@/lib/format'
import { useAuth } from '@/app/AuthProvider'

/**
 * Dashboard.
 *
 * Every figure comes from `/api/dashboard`, which aggregates persisted rows for
 * the signed-in user. A brand-new account sees zeros plus designed empty states
 * that explain what will appear here and how to start — never sample numbers.
 */
export default function DashboardPage() {
  const { user } = useAuth()
  const { data, error, loading, reload } = useAsync<DashboardSummary>(
    () => api.get<DashboardSummary>('/api/dashboard'),
    [],
  )

  if (loading) {
    return (
      <PageContainer>
        <PageHeader eyebrow="Operação" title="Visão geral" description="Carregando indicadores…" />
        <div className="mt-7 space-y-5">
          <SkeletonStats />
          <div className="grid gap-5 lg:grid-cols-3">
            <Skeleton className="h-72 rounded-lg lg:col-span-2" />
            <Skeleton className="h-72 rounded-lg" />
          </div>
        </div>
      </PageContainer>
    )
  }

  if (error || !data) {
    return (
      <PageContainer>
        <PageHeader eyebrow="Operação" title="Visão geral" />
        <Notice
          tone="danger"
          title="Não foi possível carregar os indicadores"
          action={
            <Button size="sm" onClick={reload}>
              Tentar novamente
            </Button>
          }
        >
          {error?.message ?? 'Erro inesperado ao consultar o servidor.'}
        </Notice>
      </PageContainer>
    )
  }

  const isEmpty = data.investigations.total === 0
  const accepted = data.evidence.byStatus['accepted'] ?? 0
  const rejected = data.evidence.byStatus['rejected'] ?? 0
  const pending = data.evidence.byStatus['pending'] ?? 0
  const review = data.evidence.byStatus['needs_review'] ?? 0
  const totalEvidence = data.evidence.total

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Operação"
        title={`Bom trabalho, ${firstName(user?.name)}`}
        description="Panorama das suas investigações, evidências e decisões de validação. Todos os números são calculados a partir dos dados persistidos."
        actions={
          <>
            <Button variant="secondary" size="md" onClick={reload} loading={false}>
              Atualizar
            </Button>
            <Link to="/investigations/new">
              <Button variant="primary" size="md" iconLeft={<Plus className="size-4" aria-hidden />}>
                Nova investigação
              </Button>
            </Link>
          </>
        }
      />

      <div className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Investigações"
          value={formatNumber(data.investigations.total)}
          hint={`${data.investigations.byStatus['active'] ?? 0} em andamento · ${data.investigations.byStatus['draft'] ?? 0} rascunho(s)`}
          icon={FlaskConical}
          tone="signal"
        />
        <MetricCard
          label="Evidências coletadas"
          value={formatNumber(totalEvidence)}
          hint={totalEvidence === 0 ? 'Nenhuma fonte adicionada ainda' : `${formatNumber(pending + review)} aguardando decisão`}
          icon={Layers}
        />
        <MetricCard
          label="Evidências aprovadas"
          value={formatNumber(accepted)}
          hint={
            totalEvidence > 0
              ? `${Math.round((accepted / totalEvidence) * 100)}% do total coletado`
              : 'Aprovação é uma decisão humana registrada'
          }
          icon={BadgeCheck}
          tone="positive"
        />
        <MetricCard
          label="Análises realizadas"
          value={formatNumber(data.analyses)}
          hint={`${formatNumber(data.validations)} decisão(ões) de validação registradas`}
          icon={Sparkles}
          tone="signal"
        />
      </div>

      {isEmpty ? (
        <div className="mt-5">
          <EmptyState
            icon={<FlaskConical className="size-5" aria-hidden />}
            title="Nenhuma investigação ainda"
            description="Uma investigação começa com um tema e um objetivo explícito. É esse objetivo que orienta a pesquisa externa, a análise por IA e o cálculo de alinhamento de cada fonte."
            action={
              <Link to="/investigations/new">
                <Button variant="primary" iconLeft={<Plus className="size-4" aria-hidden />}>
                  Criar primeira investigação
                </Button>
              </Link>
            }
            secondary={
              <Link to="/settings">
                <Button variant="ghost">Verificar configuração dos provedores</Button>
              </Link>
            }
          />
        </div>
      ) : (
        <>
          <div className="mt-5 grid gap-5 lg:grid-cols-3">
            {/* Evidence distribution */}
            <section className="panel p-5 lg:col-span-1" aria-labelledby="distribution-title">
              <SectionHeader
                title="Distribuição de evidências"
                description="Por status de validação"
              />
              <div className="mt-5">
                <Meter
                  ariaLabel={`Distribuição de ${totalEvidence} evidências por status`}
                  segments={[
                    { value: accepted, tone: 'bg-positive', label: 'Aprovadas' },
                    { value: review, tone: 'bg-caution', label: 'Em revisão' },
                    { value: rejected, tone: 'bg-negative', label: 'Rejeitadas' },
                    { value: pending, tone: 'bg-[#3a4560]', label: 'Pendentes' },
                  ]}
                />
              </div>
              <BarDistribution
                className="mt-5"
                rows={[
                  { label: validationLabel('accepted'), value: accepted, tone: 'bg-positive' },
                  { label: validationLabel('needs_review'), value: review, tone: 'bg-caution' },
                  { label: validationLabel('rejected'), value: rejected, tone: 'bg-negative' },
                  { label: validationLabel('pending'), value: pending, tone: 'bg-[#3a4560]' },
                ]}
              />
              <div className="mt-5 border-t border-hairline pt-4">
                <p className="text-[0.75rem] leading-relaxed text-ink-faint">
                  Aprovação humana indica que o pesquisador considerou a fonte adequada para a
                  investigação. Não é atestado de veracidade científica ou jurídica.
                </p>
              </div>
            </section>

            {/* 30-day trend */}
            <section className="panel p-5 lg:col-span-2" aria-labelledby="trend-title">
              <SectionHeader
                title="Evolução das investigações"
                description="Criações nos últimos 30 dias"
                actions={
                  <div className="flex items-center gap-3 text-[0.75rem] text-ink-faint">
                    <span className="flex items-center gap-1.5">
                      <span className="size-1.5 rounded-full bg-signal" aria-hidden />
                      Investigações
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="size-1.5 rounded-full bg-cyan" aria-hidden />
                      Evidências
                    </span>
                  </div>
                }
              />
              <div className="mt-6 space-y-5">
                <div>
                  <div className="flex items-baseline justify-between">
                    <p className="text-[0.75rem] text-ink-subtle">Investigações criadas</p>
                    <p className="tnum text-[0.75rem] text-ink-muted">
                      {formatNumber(data.investigationTrend.reduce((sum, point) => sum + point.count, 0))} nos últimos 30 dias
                    </p>
                  </div>
                  <Sparkline
                    data={data.investigationTrend}
                    ariaLabel="Investigações criadas por dia nos últimos 30 dias"
                    height={82}
                    tone="signal"
                  />
                </div>
                <div>
                  <div className="flex items-baseline justify-between">
                    <p className="text-[0.75rem] text-ink-subtle">Evidências coletadas</p>
                    <p className="tnum text-[0.75rem] text-ink-muted">
                      {formatNumber(data.evidenceTrend.reduce((sum, point) => sum + point.count, 0))} nos últimos 30 dias
                    </p>
                  </div>
                  <Sparkline
                    data={data.evidenceTrend}
                    ariaLabel="Evidências coletadas por dia nos últimos 30 dias"
                    height={82}
                    tone="cyan"
                  />
                </div>
              </div>
            </section>
          </div>

          <div className="mt-5 grid gap-5 lg:grid-cols-[1.4fr_1fr]">
            {/* Recent investigations */}
            <section className="panel overflow-hidden" aria-labelledby="recent-investigations">
              <div className="flex items-center justify-between border-b border-hairline px-5 py-3.5">
                <h2 id="recent-investigations" className="text-[0.9375rem] font-semibold text-ink">
                  Investigações recentes
                </h2>
                <Link
                  to="/investigations"
                  className="flex min-h-8 items-center gap-1 text-[0.75rem] text-ink-subtle transition-colors hover:text-ink"
                >
                  Ver todas
                  <ArrowRight className="size-3" aria-hidden />
                </Link>
              </div>
              {data.recentInvestigations.length === 0 ? (
                <div className="px-5 py-10 text-center text-[0.8125rem] text-ink-faint">
                  Nenhuma investigação cadastrada.
                </div>
              ) : (
                <ul className="divide-y divide-hairline/70">
                  {data.recentInvestigations.map((investigation) => (
                    <li key={investigation.id}>
                      <Link
                        to={`/investigations/${investigation.id}`}
                        className="group flex items-start gap-3 px-5 py-3.5 transition-colors hover:bg-white/[0.02]"
                      >
                        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-hairline-strong bg-raised">
                          <FlaskConical className="size-3.5 text-ink-subtle" aria-hidden />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-[0.8125rem] font-medium text-ink group-hover:text-white">
                              {investigation.title}
                            </p>
                            <InvestigationStatusBadge status={investigation.status} />
                          </div>
                          <p className="mt-0.5 truncate text-[0.75rem] text-ink-faint">{investigation.topic}</p>
                        </div>
                        <span className="shrink-0 text-[0.75rem] text-ink-faint">
                          {formatRelative(investigation.updatedAt)}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Recent activity + quota */}
            <div className="space-y-5">
              <section className="panel overflow-hidden" aria-labelledby="recent-activity">
                <div className="flex items-center justify-between border-b border-hairline px-5 py-3.5">
                  <h2 id="recent-activity" className="text-[0.9375rem] font-semibold text-ink">
                    Atividades recentes
                  </h2>
                  <Activity className="size-3.5 text-ink-faint" aria-hidden />
                </div>
                {data.recentActivity.length === 0 ? (
                  <div className="px-5 py-8 text-center text-[0.8125rem] text-ink-faint">
                    Nenhum evento registrado.
                  </div>
                ) : (
                  <ul className="divide-y divide-hairline/60">
                    {data.recentActivity.slice(0, 5).map((entry) => (
                      <li key={entry.id} className="px-5 py-3">
                        <p className="text-[0.78125rem] leading-snug text-ink-muted">{entry.description}</p>
                        <p className="mt-0.5 text-[0.75rem] text-ink-faint">{formatRelative(entry.createdAt)}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="panel p-5" aria-labelledby="quota-title">
                <div className="flex items-center justify-between">
                  <h2 id="quota-title" className="text-[0.9375rem] font-semibold text-ink">
                    Consumo de hoje
                  </h2>
                  <Gauge className="size-3.5 text-ink-faint" aria-hidden />
                </div>
                <div className="mt-4 space-y-3.5">
                  <QuotaRow
                    label="Pesquisas Exa"
                    used={data.quota.research.used}
                    limit={data.quota.research.limit}
                    resetsAt={data.quota.research.resetsAt}
                  />
                  <QuotaRow
                    label="Análises Gemini"
                    used={data.quota.analysis.used}
                    limit={data.quota.analysis.limit}
                    resetsAt={data.quota.analysis.resetsAt}
                  />
                </div>
                {!data.quota.externalApisEnabled ? (
                  <p className="mt-4 flex items-start gap-2 rounded-md border border-hairline bg-raised/50 px-3 py-2 text-[0.75rem] leading-relaxed text-ink-subtle">
                    <CircleDashed className="mt-0.5 size-3.5 shrink-0 text-caution" aria-hidden />
                    Chamadas externas desativadas. Pesquisa e análise permanecem bloqueadas até
                    configuração das chaves e do interruptor.
                  </p>
                ) : null}
                <Link
                  to="/settings"
                  className="mt-4 inline-flex min-h-9 items-center gap-1 text-[0.75rem] text-signal-bright transition-colors hover:text-signal"
                >
                  Configurar limites
                  <ArrowRight className="size-3" aria-hidden />
                </Link>
              </section>
            </div>
          </div>
        </>
      )}
    </PageContainer>
  )
}

function QuotaRow({
  label,
  used,
  limit,
  resetsAt,
}: {
  label: string
  used: number
  limit: number
  resetsAt: string
}) {
  const ratio = limit > 0 ? used / limit : 0
  const tone = ratio >= 1 ? 'negative' : ratio >= 0.7 ? 'caution' : 'signal'
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[0.75rem] text-ink-muted">{label}</span>
        <span className="tnum text-[0.75rem] text-ink-subtle">
          {used}/{limit}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#161c29]">
        <div
          className={`h-full rounded-full transition-[width] ${
            tone === 'negative' ? 'bg-negative' : tone === 'caution' ? 'bg-caution' : 'bg-signal'
          }`}
          style={{ width: `${Math.min(100, ratio * 100)}%` }}
        />
      </div>
      {used >= limit ? (
        <p className="mt-1 text-[0.75rem] text-negative">Limite atingido · reinicia {untilReset(resetsAt)}</p>
      ) : null}
    </div>
  )
}

function firstName(name: string | undefined): string {
  if (!name) return 'pesquisador'
  return name.trim().split(/\s+/)[0] ?? 'pesquisador'
}

/** Re-exported for tests that import the trend formatter. */
export const dashboardDate = formatDate
