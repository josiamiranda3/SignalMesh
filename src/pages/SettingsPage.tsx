import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Gauge,
  KeyRound,
  Languages,
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
} from '@/components/ui'
import { useAuth } from '@/app/AuthProvider'
import { useI18n } from '@/i18n/I18nProvider'
import { LanguageSelector } from '@/components/ui/LanguageSelector'
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
  const { signOut } = useAuth()
  const { t } = useI18n()
  const { data, error, loading, reload } = useAsync<SettingsResponse>(
    () => api.get<SettingsResponse>('/api/settings'),
    [],
  )

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
        <PageHeader eyebrow={t('settings.eyebrow')} title={t('settings.title')} />
        <Notice
          tone="danger"
          title={t('settings.loadError')}
          action={
            <Button size="sm" onClick={reload}>
              {t('common.retry')}
            </Button>
          }
        >
          {error?.message ?? t('settings.loadErrorFallback')}
        </Notice>
      </PageContainer>
    )
  }

  return (
    <PageContainer>
      <PageHeader
        eyebrow={t('settings.eyebrow')}
        title={t('settings.title')}
        description={t('settings.description')}
      />

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        {/* Providers */}
        <section className="panel p-5" aria-labelledby="providers-heading">
          <SectionHeader
            title={t('settings.providersTitle')}
            description={t('settings.providersDescription')}
            actions={<KeyRound className="size-4 text-ink-faint" aria-hidden />}
          />

          <div className="mt-4 space-y-3">
            <ProviderRow
              name="Exa"
              purpose={t('settings.providerResearchPurpose')}
              configured={data.providers.exa.configured}
              enabled={data.providers.exa.enabled}
              detail={t('settings.providerSearchType', { type: data.providers.exa.searchType })}
            />
            <ProviderRow
              name="Google Gemini"
              purpose={t('settings.providerAnalysisPurpose')}
              configured={data.providers.gemini.configured}
              enabled={data.providers.gemini.enabled}
              detail={t('settings.providerModel', { model: data.providers.gemini.model })}
            />
          </div>

          <div className="mt-4 space-y-2 border-t border-hairline pt-4">
            <FlagRow
              label={t('settings.flagExternalApis')}
              enabled={data.providers.externalApisEnabled}
            />
            <FlagRow
              label={t('settings.flagPaidOperations')}
              enabled={data.providers.paidOperationsEnabled}
              invertTone
            />
          </div>

          <Notice tone="info" className="mt-4">
            {t('settings.providerKeysNote')}
          </Notice>
        </section>

        {/* Limits */}
        <section className="panel p-5" aria-labelledby="limits-heading">
          <SectionHeader
            title={t('settings.limitsTitle')}
            description={t('settings.limitsDescription')}
            actions={<Gauge className="size-4 text-ink-faint" aria-hidden />}
          />

          <div className="mt-4 space-y-4">
            <LimitRow
              label={t('settings.limitResearchPerUser')}
              limit={data.limits.researchDailyLimit}
              used={data.quota.research.used}
              resetsAt={data.quota.research.resetsAt}
            />
            <LimitRow
              label={t('settings.limitAnalysisPerUser')}
              limit={data.limits.analysisDailyLimit}
              used={data.quota.analysis.used}
              resetsAt={data.quota.analysis.resetsAt}
            />
          </div>

          <dl className="mt-5 space-y-2 border-t border-hairline pt-4">
            <div className="flex items-center justify-between text-[0.75rem]">
              <dt className="text-ink-subtle">{t('settings.limitResearchGlobal')}</dt>
              <dd className="tnum text-ink-muted">{data.limits.researchGlobalDailyLimit}</dd>
            </div>
            <div className="flex items-center justify-between text-[0.75rem]">
              <dt className="text-ink-subtle">{t('settings.limitAnalysisGlobal')}</dt>
              <dd className="tnum text-ink-muted">{data.limits.analysisGlobalDailyLimit}</dd>
            </div>
            <div className="flex items-center justify-between text-[0.75rem]">
              <dt className="text-ink-subtle">{t('settings.singleOperation')}</dt>
              <dd className="text-positive">{t('settings.activeLabel')}</dd>
            </div>
          </dl>

          <p className="mt-4 text-[0.75rem] leading-relaxed text-ink-faint">
            {t('settings.limitsNote', { date: formatDateTime(data.quota.research.resetsAt) })}
          </p>
        </section>
      </div>

      {/* Account */}
      <section className="panel mt-5 p-5" aria-labelledby="account-heading">
        <SectionHeader
          title={t('settings.accountTitle')}
          description={t('settings.accountDescription')}
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
            {t('settings.signOut')}
          </Button>
        </div>
      </section>

      {/* Language */}
      <section className="panel mt-5 p-5" aria-labelledby="language-heading">
        <SectionHeader
          title={t('common.language')}
          description={t('common.languageDescription')}
          actions={<Languages className="size-4 text-ink-faint" aria-hidden />}
        />
        <div className="mt-4">
          <LanguageSelector />
        </div>
        <p className="mt-3 font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-ink-faint">
          {t('common.languageDescription')}
        </p>
      </section>

      {/* Usage ledger */}
      <section className="panel mt-5 overflow-hidden" aria-labelledby="usage-heading">
        <div className="flex items-center justify-between border-b border-hairline px-5 py-3.5">
          <div>
            <h2 id="usage-heading" className="text-[0.9375rem] font-semibold text-ink">
              {t('settings.usageTitle')}
            </h2>
            <p className="mt-0.5 text-[0.75rem] text-ink-subtle">
              {t('settings.usageDescription')}
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={reload}>
            {t('common.refresh')}
          </Button>
        </div>

        {data.usageHistory.length === 0 ? (
          <div className="px-5 py-10 text-center">
            <p className="text-[0.8125rem] text-ink-muted">{t('settings.usageEmpty')}</p>
            <p className="mx-auto mt-1 max-w-md text-[0.75rem] leading-relaxed text-ink-faint">
              {t('settings.usageEmptyDescription')}
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
        <SectionHeader title={t('settings.privacyTitle')} description={t('settings.privacyDescription')} />
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div>
            <p className="text-[0.8125rem] leading-relaxed text-ink-muted">
              {t('settings.privacyBody1')}
            </p>
            <p className="mt-3 text-[0.8125rem] leading-relaxed text-ink-muted">
              {t('settings.privacyBody2')}
            </p>
          </div>
          <ul className="space-y-2">
            {[
              t('settings.privacyRuleUntrusted'),
              t('settings.privacyRuleReferences'),
              t('settings.privacyRuleLogs'),
              t('settings.privacyRuleExports'),
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
  const { t } = useI18n()
  const state = enabled
    ? t('settings.providerStateOperational')
    : configured
      ? t('settings.providerStateBlocked')
      : t('settings.providerStateNoKey')
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

/**
 * One per-user daily limit.
 *
 * The value is read-only on purpose. The limit is a server-side cost control
 * (`RESEARCH_DAILY_LIMIT` / `ANALYSIS_DAILY_LIMIT` in the environment), and the
 * enforcement in `UsageService` reads that configuration directly — nothing ever
 * reads the per-user preference the old +/- controls wrote, so moving them
 * changed nothing but the counter on screen. Showing the effective number and
 * the real consumption is honest; offering a control that cannot change the
 * outcome is not.
 */
function LimitRow({
  label,
  limit,
  used,
  resetsAt,
}: {
  label: string
  limit: number
  used: number
  resetsAt: string
}) {
  const { t } = useI18n()
  const exhausted = used >= limit
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[0.75rem] text-ink-muted">{label}</p>
        {/* Static readout: the effective server limit. */}
        <p className="flex items-baseline gap-1.5">
          <span className="figure text-[0.9375rem] text-ink">{limit}</span>
          <span className="text-[0.6875rem] text-ink-faint">{t('settings.perDay')}</span>
        </p>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[#1a222c]">
        <div
          className={cn('h-full rounded-full', exhausted ? 'bg-negative' : 'bg-signal')}
          style={{ width: `${limit > 0 ? Math.min(100, (used / limit) * 100) : 100}%` }}
        />
      </div>
      <p className={cn('mt-1 text-[0.75rem]', exhausted ? 'text-negative' : 'text-ink-faint')}>
        {t('settings.limitUsage', { used, limit, when: untilReset(resetsAt) })}
      </p>
    </div>
  )
}

function UsageRow({ record }: { record: UsageRecord }) {
  const statusTone = record.status === 'success' ? 'positive' : record.status === 'blocked' ? 'caution' : 'negative'
  const { t } = useI18n()
  const statusLabel =
    record.status === 'success'
      ? t('settings.statusSuccess')
      : record.status === 'blocked'
        ? t('settings.statusBlocked')
        : t('settings.statusError')

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
            {record.operation === 'research'
              ? t('settings.operationResearch')
              : t('settings.operationAnalysis')}
          </p>
          <p className="text-[0.75rem] text-ink-faint">
            {formatDateTime(record.createdAt)} · {formatRelative(record.createdAt)}
            {record.errorCode ? ` · ${record.errorCode}` : ''}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 pl-10 sm:pl-0">
        <span className="tnum text-[0.75rem] text-ink-faint">
          {t('settings.quantity', { count: record.quantity })}
        </span>
        <Badge tone={statusTone} dot>
          {statusLabel}
        </Badge>
      </div>
    </li>
  )
}

export const icons = { AlertTriangle, XCircle, formatNumber }
