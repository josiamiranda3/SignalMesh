import { useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Gauge,
  KeyRound,
  LogOut,
  ShieldCheck,
  Sparkles,
  XCircle,
} from 'lucide-react'
import type { SettingsResponse, UsageRecord } from '@shared/api'
import { api } from '@/lib/api'
import { useAsync } from '@/hooks/useAsync'
import { PageContainer, PageHeader, SectionHeader } from '@/components/layout/Page'
import {
  Badge,
  Button,
  Notice,
  Skeleton,
  useToast,
} from '@/components/ui'
import { useAuth } from '@/app/AuthProvider'
import { formatDateTime, formatNumber, formatRelative, untilReset } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * Settings.
 *
 * Honest configuration surface: it shows which providers are configured and
 * whether external calls are enabled, the active daily limits, the usage ledger
 * for this account, and the privacy disclosure. It does not offer to enter API
 * keys in the browser — those belong in the backend environment, and the screen
 * says so.
 */
export default function SettingsPage() {
  const toast = useToast()
  const { signOut } = useAuth()
  const { data, error, loading, reload } = useAsync<SettingsResponse>(
    () => api.get<SettingsResponse>('/api/settings'),
    [],
  )
  const [busy, setBusy] = useState<string | null>(null)

  const adjustLimit = async (field: 'researchDailyLimit' | 'analysisDailyLimit', delta: number) => {
    if (!data) return
    const current = field === 'researchDailyLimit' ? data.limits.researchDailyLimit : data.limits.analysisDailyLimit
    const next = Math.max(0, Math.min(100, current + delta))
    if (next === current) return
    setBusy(field)
    try {
      await api.patch('/api/settings/limits', { [field]: next })
      toast.success('Preferência registrada', 'O limite efetivo continua subordinado à configuração do servidor.')
      reload()
    } catch (caught) {
      toast.error('Não foi possível salvar', caught instanceof Error ? caught.message : undefined)
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return (
      <PageContainer>
        <Skeleton className="h-8 w-48" />
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-52 rounded-lg" />
          <Skeleton className="h-52 rounded-lg" />
        </div>
        <Skeleton className="mt-4 h-64 rounded-lg" />
      </PageContainer>
    )
  }

  if (error || !data) {
    return (
      <PageContainer>
        <PageHeader eyebrow="Sistema" title="Configurações" />
        <Notice
          tone="danger"
          title="Não foi possível carregar as configurações"
          action={
            <Button size="sm" onClick={reload}>
              Tentar novamente
            </Button>
          }
        >
          {error?.message ?? 'Erro inesperado'}
        </Notice>
      </PageContainer>
    )
  }

  return (
    <PageContainer>
      <PageHeader
        eyebrow="Sistema"
        title="Configurações"
        description="Estado dos provedores externos, limites de consumo e dados da sua conta neste ambiente."
      />

      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        {/* Providers */}
        <section className="panel p-5" aria-labelledby="providers-heading">
          <SectionHeader
            title="Provedores externos"
            description="Chaves são lidas apenas pelo backend"
            actions={<KeyRound className="size-4 text-ink-faint" aria-hidden />}
          />

          <div className="mt-4 space-y-3">
            <ProviderRow
              name="Exa"
              purpose="Pesquisa externa"
              configured={data.providers.exa.configured}
              enabled={data.providers.exa.enabled}
              detail={`Tipo de busca: ${data.providers.exa.searchType}`}
            />
            <ProviderRow
              name="Google Gemini"
              purpose="Análise estruturada"
              configured={data.providers.gemini.configured}
              enabled={data.providers.gemini.enabled}
              detail={`Modelo: ${data.providers.gemini.model}`}
            />
          </div>

          <div className="mt-4 space-y-2 border-t border-hairline pt-4">
            <FlagRow
              label="Chamadas externas (ENABLE_EXTERNAL_APIS)"
              enabled={data.providers.externalApisEnabled}
            />
            <FlagRow
              label="Operações pagas (ENABLE_PAID_OPERATIONS)"
              enabled={data.providers.paidOperationsEnabled}
              invertTone
            />
          </div>

          <Notice tone="info" className="mt-4">
            Para configurar as chaves, defina <code className="font-mono text-ink-muted">EXA_API_KEY</code> e{' '}
            <code className="font-mono text-ink-muted">GEMINI_API_KEY</code> no ambiente do backend e reinicie o
            servidor. Nenhuma credencial é enviada ao navegador nem armazenada no banco de dados.
          </Notice>
        </section>

        {/* Limits */}
        <section className="panel p-5" aria-labelledby="limits-heading">
          <SectionHeader
            title="Limites de consumo"
            description="Proteção de custo aplicada no servidor"
            actions={<Gauge className="size-4 text-ink-faint" aria-hidden />}
          />

          <div className="mt-4 space-y-4">
            <LimitRow
              label="Pesquisas por usuário / dia"
              value={data.limits.researchDailyLimit}
              used={data.quota.research.used}
              resetsAt={data.quota.research.resetsAt}
              busy={busy === 'researchDailyLimit'}
              onAdjust={(delta) => void adjustLimit('researchDailyLimit', delta)}
            />
            <LimitRow
              label="Análises por usuário / dia"
              value={data.limits.analysisDailyLimit}
              used={data.quota.analysis.used}
              resetsAt={data.quota.analysis.resetsAt}
              busy={busy === 'analysisDailyLimit'}
              onAdjust={(delta) => void adjustLimit('analysisDailyLimit', delta)}
            />
          </div>

          <dl className="mt-5 space-y-2 border-t border-hairline pt-4">
            <div className="flex items-center justify-between text-[0.75rem]">
              <dt className="text-ink-subtle">Limite global de pesquisas / dia</dt>
              <dd className="tnum text-ink-muted">{data.limits.researchGlobalDailyLimit}</dd>
            </div>
            <div className="flex items-center justify-between text-[0.75rem]">
              <dt className="text-ink-subtle">Limite global de análises / dia</dt>
              <dd className="tnum text-ink-muted">{data.limits.analysisGlobalDailyLimit}</dd>
            </div>
            <div className="flex items-center justify-between text-[0.75rem]">
              <dt className="text-ink-subtle">Uma operação simultânea por usuário</dt>
              <dd className="text-positive">ativo</dd>
            </div>
          </dl>

          <p className="mt-4 text-[0.75rem] leading-relaxed text-ink-faint">
            O contador reinicia à meia-noite UTC ({formatDateTime(data.quota.research.resetsAt)}). A preferência
            ajustada aqui nunca ultrapassa o limite configurado no servidor e é aplicada no backend.
          </p>
        </section>
      </div>

      {/* Account */}
      <section className="panel mt-5 p-5" aria-labelledby="account-heading">
        <SectionHeader
          title="Conta"
          description="Identidade usada nas decisões de validação"
          actions={<ShieldCheck className="size-4 text-ink-faint" aria-hidden />}
        />
        <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-full border border-hairline-strong bg-raised text-[0.8125rem] font-semibold text-ink-muted">
              {data.user.name.slice(0, 2).toUpperCase()}
            </div>
            <div>
              <p className="text-[0.875rem] font-medium text-ink">{data.user.name}</p>
              <p className="text-[0.75rem] text-ink-subtle">{data.user.email}</p>
              <p className="mt-0.5 font-mono text-[0.75rem] text-ink-faint">{data.user.id}</p>
            </div>
          </div>
          <Button variant="secondary" size="sm" onClick={() => void signOut()} iconLeft={<LogOut className="size-3.5" aria-hidden />}>
            Encerrar sessão
          </Button>
        </div>
      </section>

      {/* Usage ledger */}
      <section className="panel mt-5 overflow-hidden" aria-labelledby="usage-heading">
        <div className="flex items-center justify-between border-b border-hairline px-5 py-3.5">
          <div>
            <h2 id="usage-heading" className="text-[0.9375rem] font-semibold text-ink">
              Registro de consumo
            </h2>
            <p className="mt-0.5 text-[0.75rem] text-ink-subtle">
              Toda tentativa é registrada — incluindo bloqueios por limite.
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={reload}>
            Atualizar
          </Button>
        </div>

        {data.usageHistory.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="text-[0.8125rem] text-ink-muted">Nenhuma operação externa registrada.</p>
            <p className="mx-auto mt-1 max-w-md text-[0.75rem] leading-relaxed text-ink-faint">
              Pesquisas na Exa e análises no Gemini aparecem aqui com provedor, operação, resultado e data.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-hairline/60">
            {data.usageHistory.map((record) => (
              <UsageRow key={record.id} record={record} />
            ))}
          </ul>
        )}
      </section>

      {/* Privacy */}
      <section className="panel mt-5 p-5" aria-labelledby="privacy-heading">
        <SectionHeader title="Privacidade e uso de dados" description="O que sai do SignalMesh e por quê" />
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div>
            <p className="text-[0.8125rem] leading-relaxed text-ink-muted">
              Ao executar uma pesquisa, a consulta derivada do tema e do objetivo é enviada à Exa. Ao solicitar uma
              análise, o objetivo da investigação e o conteúdo das evidências armazenadas são enviados ao Google
              Gemini. Esses dados são processados pelos respectivos provedores conforme as políticas deles.
            </p>
            <p className="mt-3 text-[0.8125rem] leading-relaxed text-ink-muted">
              Nenhuma credencial, token de sessão ou dado de outro usuário é incluído nessas chamadas. O SignalMesh
              não usa IA gerenciada nem o proxy pago da plataforma de hospedagem para pesquisa ou análise.
            </p>
          </div>
          <ul className="space-y-2">
            {[
              'Conteúdo de fontes é tratado como dado não confiável, nunca como instrução.',
              'Referências inexistentes invalidam a análise inteira.',
              'Logs não registram credenciais nem corpos de requisição.',
              'Exportações incluem apenas dados da sua conta.',
            ].map((item) => (
              <li key={item} className="flex gap-2 text-[0.75rem] leading-relaxed text-ink-subtle">
                <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-positive" aria-hidden />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </PageContainer>
  )
}

function ProviderRow({
  name,
  purpose,
  configured,
  enabled,
  detail,
}: {
  name: string
  purpose: string
  configured: boolean
  enabled: boolean
  detail: string
}) {
  const state = enabled ? 'operacional' : configured ? 'bloqueado por interruptor' : 'sem chave'
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-hairline bg-raised/30 px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-[0.8125rem] font-medium text-ink">{name}</p>
        <p className="text-[0.75rem] text-ink-faint">
          {purpose} · {detail}
        </p>
      </div>
      <Badge tone={enabled ? 'positive' : configured ? 'caution' : 'neutral'} dot>
        {state}
      </Badge>
    </div>
  )
}

function FlagRow({ label, enabled, invertTone = false }: { label: string; enabled: boolean; invertTone?: boolean }) {
  const good = invertTone ? !enabled : enabled
  return (
    <div className="flex items-center justify-between text-[0.75rem]">
      <span className="text-ink-subtle">{label}</span>
      <span className={cn('flex items-center gap-1.5 font-medium', good ? 'text-positive' : 'text-caution')}>
        {enabled ? <CheckCircle2 className="size-3.5" aria-hidden /> : <Circle className="size-3.5" aria-hidden />}
        {enabled ? 'true' : 'false'}
      </span>
    </div>
  )
}

function LimitRow({
  label,
  value,
  used,
  resetsAt,
  busy,
  onAdjust,
}: {
  label: string
  value: number
  used: number
  resetsAt: string
  busy: boolean
  onAdjust: (delta: number) => void
}) {
  const exhausted = used >= value
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[0.75rem] text-ink-muted">{label}</p>
        <div className="flex items-center gap-1">
          <Button variant="quiet" size="sm" onClick={() => onAdjust(-1)} disabled={busy || value <= 0} aria-label={`Diminuir ${label}`}>
            −
          </Button>
          <span className="tnum w-8 text-center text-[0.875rem] font-semibold text-ink">{value}</span>
          <Button variant="quiet" size="sm" onClick={() => onAdjust(1)} disabled={busy || value >= 100} aria-label={`Aumentar ${label}`}>
            +
          </Button>
        </div>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[#161c29]">
        <div
          className={cn('h-full rounded-full', exhausted ? 'bg-negative' : 'bg-signal')}
          style={{ width: `${value > 0 ? Math.min(100, (used / value) * 100) : 100}%` }}
        />
      </div>
      <p className={cn('mt-1 text-[0.75rem]', exhausted ? 'text-negative' : 'text-ink-faint')}>
        {used} de {value} usada(s) hoje · reinicia {untilReset(resetsAt)}
      </p>
    </div>
  )
}

function UsageRow({ record }: { record: UsageRecord }) {
  const statusTone = record.status === 'success' ? 'positive' : record.status === 'blocked' ? 'caution' : 'negative'
  const statusLabel = record.status === 'success' ? 'sucesso' : record.status === 'blocked' ? 'bloqueado' : 'erro'

  return (
    <li className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-hairline-strong bg-raised">
          {record.operation === 'research' ? (
            <KeyRound className="size-3.5 text-ink-subtle" aria-hidden />
          ) : (
            <Sparkles className="size-3.5 text-ink-subtle" aria-hidden />
          )}
        </div>
        <div className="min-w-0">
          <p className="text-[0.8125rem] text-ink-muted">
            {record.provider === 'exa' ? 'Exa' : 'Gemini'} ·{' '}
            {record.operation === 'research' ? 'pesquisa' : 'análise'}
          </p>
          <p className="text-[0.75rem] text-ink-faint">
            {formatDateTime(record.createdAt)} · {formatRelative(record.createdAt)}
            {record.errorCode ? ` · ${record.errorCode}` : ''}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 pl-10 sm:pl-0">
        <span className="tnum text-[0.75rem] text-ink-faint">qtd {record.quantity}</span>
        <Badge tone={statusTone} dot>
          {statusLabel}
        </Badge>
      </div>
    </li>
  )
}

export const icons = { AlertTriangle, XCircle, formatNumber }
