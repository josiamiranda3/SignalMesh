import { Link } from 'react-router-dom'
import { ArrowLeft, Compass } from 'lucide-react'
import { Logo, Wordmark } from '@/components/brand/Logo'
import { Button } from '@/components/ui'
import { useI18n } from '@/i18n/I18nProvider'

/** 404. Keeps the brand and offers the two routes a lost visitor actually wants. */
export default function NotFoundPage() {
  const { t } = useI18n()
  return (
    <div className="relative z-10 flex min-h-screen flex-col">
      <header className="mx-auto flex h-16 w-full max-w-6xl items-center px-6">
        <Link to="/" className="flex min-h-9 items-center gap-2.5">
          <Logo size={24} />
          <Wordmark className="text-[0.875rem]" />
        </Link>
      </header>

      <main className="flex flex-1 items-center justify-center px-6 py-16">
        <div className="max-w-md text-center">
          <div className="mx-auto flex size-12 items-center justify-center rounded-xl border border-hairline-strong bg-raised text-signal-bright">
            <Compass className="size-5" aria-hidden />
          </div>
          <p className="eyebrow mt-6">{t('notFound.code')}</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-[-0.02em]">{t('notFound.title')}</h1>
          <p className="mt-3 text-[0.875rem] leading-relaxed text-ink-muted">
            {t('notFound.description')}
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
            <Link to="/dashboard">
              <Button variant="primary">{t('notFound.goDashboard')}</Button>
            </Link>
            <Link to="/">
              <Button variant="ghost" iconLeft={<ArrowLeft className="size-3.5" aria-hidden />}>
                {t('notFound.goHome')}
              </Button>
            </Link>
          </div>
        </div>
      </main>
    </div>
  )
}
