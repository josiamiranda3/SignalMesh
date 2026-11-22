import { Link } from 'react-router-dom'
import {
  ArrowRight,
  BadgeCheck,
  Blocks,
  FileJson,
  Fingerprint,
  Gauge,
  Link2,
  ScanSearch,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { Logo, Wordmark } from '@/components/brand/Logo'
import { APP_TAGLINE } from '@/app/constants'
import { useI18n } from '@/i18n/I18nProvider'

/**
 * Landing page.
 *
 * Static and fully server-renderable: no data fetch, no auth call. It explains
 * the product in concrete terms (what goes in, what comes out, what the system
 * refuses to do), and it makes no claims about customers, volumes or results —
 * everything stated here describes capabilities that exist in the app.
 */
export default function LandingPage() {
  const { t } = useI18n()
  return (
    <div className="relative z-10 min-h-screen">
      <header className="mx-auto flex h-[4.5rem] max-w-6xl items-center justify-between px-6">
        <Link to="/" className="flex min-h-9 items-center gap-2.5" aria-label={t('landing.homeAria')}>
          <Logo size={26} />
          <Wordmark className="text-[0.9375rem]" />
        </Link>
        <nav className="flex items-center gap-2" aria-label={t('landing.navAria')}>
          <span className="hidden font-mono text-[0.625rem] uppercase tracking-[0.14em] text-ink-faint sm:inline">
            {APP_TAGLINE}
          </span>
          <Link
            to="/login"
            className="ml-2 inline-flex h-9 items-center gap-1.5 rounded-md border border-hairline-strong bg-raised px-4 text-[0.8125rem] font-medium text-ink transition-colors hover:border-hairline-strong hover:bg-overlay"
          >
            {t('landing.signIn')}
            <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        </nav>
      </header>

      <main>
        {/* Hero */}
        <section className="relative overflow-hidden px-6 pb-24 pt-16 sm:pt-24">
          <div aria-hidden className="grid-fade pointer-events-none absolute inset-0 -z-10" />
          <div className="mx-auto max-w-6xl">
            <div className="max-w-3xl">
              <p className="inline-flex items-center gap-2 rounded-full border border-hairline-strong bg-raised/60 px-3 py-1 font-mono text-[0.625rem] uppercase tracking-[0.12em] text-ink-muted">
                <span className="size-1.5 rounded-full bg-signal" aria-hidden />
                {t('landing.heroBadge')}
              </p>

              <h1 className="mt-7 text-balance text-[2.125rem] font-semibold leading-[1.06] tracking-[-0.035em] sm:text-[2.75rem] lg:text-[3.5rem]">
                <span className="text-gradient">{t('landing.heroTitleLine1')}</span>
                <br />
                {t('landing.heroTitleLine2')}
                <br className="hidden sm:block" /> {t('landing.heroTitleLine3')}
              </h1>

              <p className="mt-6 max-w-2xl text-pretty text-[0.9375rem] leading-[1.75] text-ink-muted">
                {t('landing.heroBody')}
              </p>

              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Link
                  to="/login"
                  className="inline-flex h-11 items-center gap-2 rounded-lg bg-signal px-5 text-sm font-semibold text-white shadow-[0_16px_40px_-20px_rgba(182,75,80,0.9)] transition-colors hover:bg-signal-deep"
                >
                  {t('landing.heroCta')}
                  <ArrowRight className="size-4" aria-hidden />
                </Link>
                <a
                  href="#como-funciona"
                  className="inline-flex h-11 items-center gap-2 rounded-lg border border-hairline-strong px-5 text-sm font-medium text-ink-muted transition-colors hover:border-hairline-strong hover:text-ink"
                >
                  {t('landing.heroSecondary')}
                </a>
              </div>

              <p className="mt-5 flex items-center gap-2 font-mono text-[0.625rem] uppercase tracking-[0.1em] text-ink-faint">
                <ShieldCheck className="size-3.5 shrink-0" aria-hidden />
                {t('landing.heroTrust')}
              </p>
            </div>

            {/* Pipeline diagram — the actual data flow of the product */}
            <div className="mt-20 overflow-hidden rounded-xl border border-hairline bg-surface/70 shadow-[0_40px_80px_-60px_rgba(0,0,0,0.9)]">
              <div className="flex items-center justify-between border-b border-hairline px-5 py-3">
                <p className="eyebrow">{t('landing.pipelineTitle')}</p>
                <p className="font-mono text-[0.625rem] uppercase tracking-[0.1em] text-ink-faint">
                  {t('landing.pipelineNote')}
                </p>
              </div>
              <ol className="grid divide-y divide-hairline sm:grid-cols-5 sm:divide-x sm:divide-y-0">
                {[
                  { icon: ScanSearch, title: t('landing.stepSearch'), body: t('landing.stepSearchBody') },
                  { icon: Link2, title: t('landing.stepCollect'), body: t('landing.stepCollectBody') },
                  { icon: Sparkles, title: t('landing.stepAnalyse'), body: t('landing.stepAnalyseBody') },
                  { icon: BadgeCheck, title: t('landing.stepValidate'), body: t('landing.stepValidateBody') },
                  { icon: FileJson, title: t('landing.stepExport'), body: t('landing.stepExportBody') },
                ].map((step, index) => (
                  <li key={step.title} className="flex flex-col gap-2 px-5 py-5">
                    <div className="flex items-center gap-2">
                      <step.icon className="size-4 text-signal-bright" aria-hidden />
                      <span className="font-mono text-[0.6875rem] font-semibold tabular-nums text-ink-faint">
                        0{index + 1}
                      </span>
                    </div>
                    <p className="text-[0.8125rem] font-medium text-ink">{step.title}</p>
                    <p className="text-[0.75rem] leading-relaxed text-ink-subtle">{step.body}</p>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        </section>

        {/* Capabilities */}
        <section id="como-funciona" className="border-t border-hairline/70 px-6 py-24">
          <div className="mx-auto max-w-6xl">
            <div className="max-w-2xl">
              <p className="eyebrow">{t('landing.capabilitiesEyebrow')}</p>
              <h2 className="mt-3 text-balance text-2xl font-semibold tracking-[-0.02em] sm:text-3xl">
                {t('landing.capabilitiesTitle')}
              </h2>
              <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-muted">
                {t('landing.capabilitiesBody')}
              </p>
            </div>

            <div className="mt-10 grid gap-px overflow-hidden rounded-xl border border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-3">
              {[
                {
                  icon: Link2,
                  title: t('landing.featureEvidenceTitle'),
                  body: t('landing.featureEvidenceBody'),
                },
                {
                  icon: Sparkles,
                  title: t('landing.featureAnalysisTitle'),
                  body: t('landing.featureAnalysisBody'),
                },
                {
                  icon: BadgeCheck,
                  title: t('landing.featureValidationTitle'),
                  body: t('landing.featureValidationBody'),
                },
                {
                  icon: Gauge,
                  title: t('landing.featurePriorityTitle'),
                  body: t('landing.featurePriorityBody'),
                },
                {
                  icon: Fingerprint,
                  title: t('landing.featureIsolationTitle'),
                  body: t('landing.featureIsolationBody'),
                },
                {
                  icon: Blocks,
                  title: t('landing.featureQuotaTitle'),
                  body: t('landing.featureQuotaBody'),
                },
              ].map((feature, index) => (
                <div
                  key={feature.title}
                  className="group bg-surface/95 p-6 transition-colors duration-200 hover:bg-raised/70"
                >
                  <div className="flex items-center justify-between">
                    <feature.icon
                      className="size-4 text-ink-faint transition-colors duration-200 group-hover:text-signal-bright"
                      aria-hidden
                    />
                    <span className="font-mono text-[0.625rem] tabular-nums text-ink-faint/60" aria-hidden>
                      {String(index + 1).padStart(2, "0")}
                    </span>
                  </div>
                  <h3 className="mt-4 text-[0.875rem] font-semibold text-ink">{feature.title}</h3>
                  <p className="mt-2 text-[0.8125rem] leading-relaxed text-ink-subtle">{feature.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Principle */}
        <section className="border-t border-hairline/70 px-6 py-24">
          <div className="mx-auto grid max-w-6xl gap-12 lg:grid-cols-[1fr_1.1fr] lg:items-center">
            <div>
              <p className="eyebrow">{t('landing.principleEyebrow')}</p>
              <h2 className="mt-3 text-balance text-2xl font-semibold tracking-[-0.02em] sm:text-3xl">
                {t('landing.principleTitle')}
              </h2>
              <p className="mt-4 text-[0.9375rem] leading-relaxed text-ink-muted">
                {t('landing.principleBody')}
              </p>
            </div>

            <div className="rounded-xl border border-hairline bg-surface/80 p-7">
              <p className="text-[0.8125rem] font-medium text-ink">{t('landing.refusesTitle')}</p>
              <ul className="mt-4 space-y-3">
                {[
                  t('landing.refuseUrls'),
                  t('landing.refuseInference'),
                  t('landing.refuseContradiction'),
                  t('landing.refuseQuota'),
                  t('landing.refuseFakeNumbers'),
                ].map((item) => (
                  <li key={item} className="flex gap-2.5 text-[0.8125rem] leading-relaxed text-ink-muted">
                    <span aria-hidden className="mt-1.5 size-1 shrink-0 rounded-full bg-negative" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="border-t border-hairline/70 px-6 py-24">
          <div className="relative mx-auto max-w-3xl overflow-hidden rounded-2xl border border-hairline-strong bg-surface/80 px-8 py-14 text-center">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 -top-24 h-48 bg-[radial-gradient(40rem_18rem_at_50%_0%,rgba(182,75,80,0.16),transparent_70%)]"
            />
            <h2 className="relative text-balance text-2xl font-semibold tracking-[-0.02em]">
              {t('landing.ctaTitle')}
            </h2>
            <p className="relative mx-auto mt-3 max-w-xl text-[0.875rem] leading-relaxed text-ink-muted">
              {t('landing.ctaBody')}
            </p>
            <Link
              to="/login"
              className="relative mt-7 inline-flex h-11 items-center gap-2 rounded-lg bg-signal px-6 text-sm font-semibold text-white transition-colors hover:bg-signal-deep"
            >
              {t('landing.ctaAction')}
              <ArrowRight className="size-4" aria-hidden />
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-hairline/70 px-6 py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
          <div className="flex min-h-9 items-center gap-2.5">
            <Logo size={20} />
            <Wordmark className="text-[0.8125rem]" />
          </div>
          <p className="max-w-xl font-mono text-[0.625rem] leading-relaxed tracking-[0.04em] text-ink-faint">
            {t('landing.footerNote')}
          </p>
        </div>
      </footer>
    </div>
  )
}
