import { useEffect, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { ChevronsLeft, LogOut, Menu, Plus, X } from 'lucide-react'
import { Logo, Wordmark } from '@/components/brand/Logo'
import { Button } from '@/components/ui'
import { useAuth } from '@/app/AuthProvider'
import { useI18n } from '@/i18n/I18nProvider'
import { cn } from '@/lib/utils'
import { initialsOf } from '@/lib/format'
import { PRIMARY_NAV, SECONDARY_NAV, type NavItem } from './navigation'

/**
 * App shell sidebar.
 *
 * ## Design intent
 *
 * The rail is the instrument panel of the product, not a menu bolted to the
 * side. Three deliberate choices carry that:
 *
 *  1. **A numbered index.** Each destination carries its position (`01`,
 *     `02`…), the way an editorial contents page does. It gives the eye a
 *     stable vertical rhythm and makes the rail feel composed rather than
 *     enumerated.
 *  2. **A live marker, not a filled pill.** The active item is marked by a
 *     Signal Red bar on the rail edge plus a lifted label — colour marks *where
 *     you are*, and nothing else in the rail competes for it.
 *  3. **Monospace meta.** Section headings and the environment stamp use the
 *     mono voice, separating navigation chrome from content copy.
 *
 * Desktop is a fixed rail that can collapse to icons. Mobile is an off-canvas
 * drawer opened from the header. Both render from this one component so the
 * navigation cannot drift between breakpoints.
 */
export function Sidebar({
  pendingReview,
  mobileOpen,
  onMobileClose,
}: {
  pendingReview: number
  mobileOpen: boolean
  onMobileClose: () => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const location = useLocation()
  const { user, signOut } = useAuth()
  const { t } = useI18n()

  useEffect(() => {
    onMobileClose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])

  return (
    <>
      {mobileOpen ? (
        <button
          type="button"
          aria-label={t('common.closeMenu')}
          onClick={onMobileClose}
          className="animate-fade fixed inset-0 z-40 bg-black/75 backdrop-blur-[2px] lg:hidden"
        />
      ) : null}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-[268px] flex-col border-r border-hairline bg-base/95 backdrop-blur-xl transition-[transform,width] duration-200 ease-out lg:static lg:z-auto lg:translate-x-0 lg:bg-base/55',
          collapsed ? 'lg:w-[78px]' : 'lg:w-[268px]',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        {/* --- Brand block ------------------------------------------------- */}
        <div
          className={cn(
            'flex h-16 shrink-0 items-center gap-3 border-b border-hairline px-4',
            collapsed && 'lg:justify-center lg:px-0',
          )}
        >
          <Link
            to="/dashboard"
            className="group flex min-h-9 items-center gap-2.5 rounded-md transition-opacity hover:opacity-90"
            aria-label={`${t('common.appName')} — ${t('nav.dashboard')}`}
          >
            <Logo size={28} />
            <span className={cn('flex flex-col gap-1', collapsed && 'lg:hidden')}>
              <Wordmark className="text-[0.9375rem] leading-none" />
              <span className="font-mono text-[0.625rem] uppercase tracking-[0.16em] text-ink-faint">
                {t('common.tagline')}
              </span>
            </span>
          </Link>
          <button
            type="button"
            onClick={onMobileClose}
            className="ml-auto flex size-10 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-white/5 hover:text-ink lg:hidden"
            aria-label={t('common.closeMenu')}
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        {/* --- Primary action ---------------------------------------------- */}
        <div className={cn('px-3 pt-4', collapsed && 'lg:px-2')}>
          <Button
            variant="primary"
            size="md"
            className={cn('w-full justify-center', collapsed && 'lg:px-0')}
            onClick={() => {
              window.location.assign('/investigations/new')
            }}
            iconLeft={<Plus className="size-4" aria-hidden />}
          >
            <span className={cn(collapsed && 'lg:hidden')}>{t('nav.newInvestigation')}</span>
          </Button>
        </div>

        {/* --- Navigation --------------------------------------------------- */}
        <nav
          aria-label={t('common.mainNavigation')}
          className="mt-6 flex-1 overflow-y-auto px-3 pb-4"
        >
          <NavSectionLabel collapsed={collapsed}>{t('nav.sectionResearch')}</NavSectionLabel>
          <ul className="mt-1 space-y-0.5">
            {PRIMARY_NAV.map((item, index) => (
              <li key={item.to}>
                <NavItemLink
                  item={item}
                  index={index + 1}
                  collapsed={collapsed}
                  pendingReview={pendingReview}
                />
              </li>
            ))}
          </ul>

          <div className="my-5 h-px bg-hairline/70" />

          <NavSectionLabel collapsed={collapsed}>{t('nav.sectionSystem')}</NavSectionLabel>
          <ul className="mt-1 space-y-0.5">
            {SECONDARY_NAV.map((item, index) => (
              <li key={item.to}>
                <NavItemLink
                  item={item}
                  index={PRIMARY_NAV.length + index + 1}
                  collapsed={collapsed}
                  pendingReview={pendingReview}
                />
              </li>
            ))}
          </ul>
        </nav>

        {/* --- Account ------------------------------------------------------ */}
        <div className="border-t border-hairline p-3">
          <div
            className={cn(
              'flex items-center gap-2.5 rounded-lg px-1 py-1.5',
              collapsed && 'lg:justify-center',
            )}
          >
            <div className="flex size-8 shrink-0 items-center justify-center rounded-full border border-hairline-strong bg-raised font-mono text-[0.6875rem] font-semibold text-ink-muted">
              {user ? initialsOf(user.name) : '··'}
            </div>
            <div className={cn('min-w-0 flex-1', collapsed && 'lg:hidden')}>
              <p className="truncate text-[0.8125rem] font-medium leading-tight text-ink">
                {user?.name ?? '—'}
              </p>
              <p className="truncate text-[0.6875rem] text-ink-faint">{user?.email ?? ''}</p>
            </div>
            <button
              type="button"
              onClick={() => void signOut()}
              className={cn(
                'flex size-8 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-white/5 hover:text-negative',
                collapsed && 'lg:hidden',
              )}
              aria-label={t('common.signOut')}
              title={t('common.signOut')}
            >
              <LogOut className="size-3.5" aria-hidden />
            </button>
          </div>
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            className="mt-2 hidden min-h-9 w-full items-center justify-center gap-2 rounded-md px-2 font-mono text-[0.625rem] uppercase tracking-[0.12em] text-ink-faint transition-colors hover:bg-white/5 hover:text-ink-muted lg:flex"
            aria-label={collapsed ? t('common.expandMenu') : t('common.collapseMenu')}
          >
            <ChevronsLeft
              className={cn('size-3.5 transition-transform', collapsed && 'rotate-180')}
              aria-hidden
            />
            <span className={cn(collapsed && 'hidden')}>{t('common.collapseMenu')}</span>
          </button>
        </div>
      </aside>
    </>
  )
}

/** Mono, tracked-out section heading that separates nav groups. */
function NavSectionLabel({
  children,
  collapsed,
}: {
  children: React.ReactNode
  collapsed: boolean
}) {
  return (
    <p
      className={cn(
        'px-2 font-mono text-[0.625rem] uppercase tracking-[0.16em] text-ink-faint',
        collapsed && 'lg:sr-only',
      )}
    >
      {children}
    </p>
  )
}

function NavItemLink({
  item,
  index,
  collapsed,
  pendingReview,
}: {
  item: NavItem
  index: number
  collapsed: boolean
  pendingReview: number
}) {
  const Icon = item.icon
  const badgeValue = item.badgeKey === 'pendingReview' ? pendingReview : 0
  const { t } = useI18n()

  return (
    <NavLink
      to={item.to}
      end={item.end}
      title={collapsed ? t(item.labelKey) : undefined}
      className={({ isActive }) =>
        cn(
          'group relative flex items-center gap-2.5 rounded-md px-2 py-2 text-[0.8125rem] font-medium transition-colors',
          collapsed && 'lg:justify-center lg:px-0',
          isActive ? 'text-ink' : 'text-ink-subtle hover:bg-white/[0.035] hover:text-ink-muted',
        )
      }
    >
      {({ isActive }) => (
        <>
          {/* The live marker: a red bar on the rail edge. */}
          {isActive ? (
            <span
              aria-hidden
              className="absolute inset-y-1 -left-3 w-[2px] rounded-r-full bg-signal"
            />
          ) : null}
          <span
            className={cn(
              'w-[1.125rem] shrink-0 font-mono text-[0.625rem] tabular-nums tracking-tight',
              collapsed && 'lg:hidden',
              isActive ? 'text-signal-bright' : 'text-ink-faint/70',
            )}
            aria-hidden
          >
            {String(index).padStart(2, '0')}
          </span>
          <Icon
            aria-hidden
            className={cn(
              'size-4 shrink-0',
              collapsed && 'lg:size-[1.125rem]',
              isActive ? 'text-signal-bright' : 'text-ink-faint group-hover:text-ink-subtle',
            )}
          />
          <span className={cn('truncate', collapsed && 'lg:hidden')}>{t(item.labelKey)}</span>
          {badgeValue > 0 ? (
            <span
              className={cn(
                'tnum ml-auto rounded-full border border-caution/30 bg-caution/10 px-1.5 py-px text-[0.625rem] font-semibold text-caution',
                collapsed && 'lg:hidden',
              )}
            >
              {badgeValue > 99 ? '99+' : badgeValue}
            </span>
          ) : null}
        </>
      )}
    </NavLink>
  )
}

/** Mobile top bar with the drawer trigger. */
export function MobileHeader({ onOpenMenu }: { onOpenMenu: () => void }) {
  const { t } = useI18n()
  return (
    <div className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-hairline bg-base/92 px-4 backdrop-blur-xl lg:hidden">
      <button
        type="button"
        onClick={onOpenMenu}
        aria-label={t('common.openMenu')}
        className="-ml-1 rounded-md p-2 text-ink-muted transition-colors hover:bg-white/5 hover:text-ink"
      >
        <Menu className="size-5" aria-hidden />
      </button>
      <Logo size={22} />
      <Wordmark className="text-sm" />
    </div>
  )
}
