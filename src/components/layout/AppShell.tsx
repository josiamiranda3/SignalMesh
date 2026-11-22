import { useEffect, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { api } from '@/lib/api'
import { useAuth } from '@/app/AuthProvider'
import { useI18n } from '@/i18n/I18nProvider'
import { MobileHeader, Sidebar } from './Sidebar'
import { APP_NAME } from '@/app/constants'
import { ToastProvider } from '@/components/ui'

/**
 * Authenticated application shell.
 *
 * The route tree decides access; this component only renders chrome and keeps
 * the sidebar badge in sync with the real validation queue. It also sets the
 * document title per route so browser history is legible.
 */
export default function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [pendingReview, setPendingReview] = useState(0)
  const location = useLocation()
  const { user } = useAuth()
  const { t, locale } = useI18n()

  useEffect(() => {
    let active = true
    api
      .get<Array<{ evidence: { validationStatus: string } }>>('/api/validations', { status: 'needs_review' })
      .then((rows) => {
        if (active) setPendingReview(rows.length)
      })
      .catch(() => {
        /* the badge is decorative; a failure must not break the shell */
      })
    return () => {
      active = false
    }
  }, [location.pathname, locale, t])

  useEffect(() => {
    document.title = `${titleForPath(location.pathname)} · ${APP_NAME}`
  }, [location.pathname, locale, t])

  return (
    <ToastProvider>
      <div className="relative z-10 flex min-h-screen bg-transparent">
        <Sidebar pendingReview={pendingReview} mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />
        <div className="flex min-w-0 flex-1 flex-col">
          <MobileHeader onOpenMenu={() => setMobileOpen(true)} />
          <main id="main" className="min-w-0 flex-1">
            <Outlet />
          </main>
          <footer className="border-t border-hairline/70 px-5 py-5 sm:px-7 lg:px-10">
            <div className="mx-auto flex max-w-[1560px] flex-wrap items-center justify-between gap-2 font-mono text-[0.625rem] uppercase tracking-[0.12em] text-ink-faint">
              <span className="flex items-center gap-2">
                <span aria-hidden className="size-1 rounded-full bg-signal" />
                {t('nav.footerTagline')}
              </span>
              <span className="normal-case tracking-normal">
                {t('nav.footerSession', { name: user?.name ?? '—' })}
              </span>
            </div>
          </footer>
        </div>
      </div>
    </ToastProvider>
  )
}

function titleForPath(pathname: string): string {
  if (pathname.startsWith('/dashboard')) return 'Visão geral'
  if (pathname.startsWith('/investigations/new')) return 'Nova investigação'
  if (pathname.includes('/research')) return 'Pesquisa'
  if (pathname.includes('/evidence')) return 'Evidências'
  if (pathname.includes('/analysis')) return 'Análise'
  if (pathname.includes('/validation')) return 'Validação'
  if (pathname.startsWith('/investigations')) return 'Investigações'
  if (pathname.startsWith('/validation')) return 'Validação'
  if (pathname.startsWith('/history')) return 'Histórico'
  if (pathname.startsWith('/settings')) return 'Configurações'
  return 'SignalMesh'
}
