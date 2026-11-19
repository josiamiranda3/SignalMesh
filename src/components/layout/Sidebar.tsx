import { useEffect, useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { ChevronsLeft, LogOut, Menu, Plus, X } from 'lucide-react'
import { Logo, Wordmark } from '@/components/brand/Logo'
import { Button } from '@/components/ui'
import { useAuth } from '@/app/AuthProvider'
import { cn } from '@/lib/utils'
import { initialsOf } from '@/lib/format'
import { PRIMARY_NAV, SECONDARY_NAV, type NavItem } from './navigation'

/**
 * App shell sidebar.
 *
 * Desktop: fixed 248px rail that can collapse to icons. Mobile: an off-canvas
 * drawer opened from the header. The same component renders both so navigation
 * cannot drift between breakpoints.
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

  useEffect(() => {
    onMobileClose()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])

  return (
    <>
      {mobileOpen ? (
        <button
          type="button"
          aria-label="Fechar menu"
          onClick={onMobileClose}
          className="fixed inset-0 z-40 bg-black/70 backdrop-blur-[2px] lg:hidden"
        />
      ) : null}

      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-[264px] flex-col border-r border-hairline bg-base/95 backdrop-blur-xl transition-transform duration-200 lg:static lg:z-auto lg:translate-x-0 lg:bg-base/60',
          collapsed ? 'lg:w-[76px]' : 'lg:w-[264px]',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className={cn('flex h-14 shrink-0 items-center gap-2.5 border-b border-hairline px-4', collapsed && 'lg:justify-center lg:px-0')}>
          <Link
            to="/dashboard"
            className="group flex min-h-9 items-center gap-2.5 rounded-md pr-1 transition-opacity hover:opacity-90"
            aria-label="SignalMesh — visão geral"
          >
            <Logo size={26} />
            <Wordmark className={cn('text-[0.9375rem]', collapsed && 'lg:hidden')} />
          </Link>
          <button
            type="button"
            onClick={onMobileClose}
            className="ml-auto flex size-10 items-center justify-center rounded-md text-ink-subtle hover:bg-white/5 hover:text-ink lg:hidden"
            aria-label="Fechar menu"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

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
            <span className={cn(collapsed && 'lg:hidden')}>Nova investigação</span>
          </Button>
        </div>

        <nav aria-label="Navegação principal" className="mt-5 flex-1 overflow-y-auto px-3 pb-4">
          <p className={cn('eyebrow px-2 pb-2', collapsed && 'lg:hidden')}>Pesquisa</p>
          <ul className="space-y-0.5">
            {PRIMARY_NAV.map((item) => (
              <li key={item.to}>
                <NavItemLink item={item} collapsed={collapsed} pendingReview={pendingReview} />
              </li>
            ))}
          </ul>

          <div className="my-4 h-px bg-hairline/70" />

          <p className={cn('eyebrow px-2 pb-2', collapsed && 'lg:hidden')}>Sistema</p>
          <ul className="space-y-0.5">
            {SECONDARY_NAV.map((item) => (
              <li key={item.to}>
                <NavItemLink item={item} collapsed={collapsed} pendingReview={pendingReview} />
              </li>
            ))}
          </ul>
        </nav>

        <div className="border-t border-hairline p-3">
          <div className={cn('flex items-center gap-2.5 rounded-lg px-1 py-1.5', collapsed && 'lg:justify-center')}>
            <div className="flex size-8 shrink-0 items-center justify-center rounded-full border border-hairline-strong bg-raised text-[0.75rem] font-semibold text-ink-muted">
              {user ? initialsOf(user.name) : '··'}
            </div>
            <div className={cn('min-w-0 flex-1', collapsed && 'lg:hidden')}>
              <p className="truncate text-[0.8125rem] font-medium text-ink">{user?.name ?? '—'}</p>
              <p className="truncate text-[0.75rem] text-ink-faint">{user?.email ?? ''}</p>
            </div>
            <button
              type="button"
              onClick={() => void signOut()}
              className={cn(
                'flex size-9 items-center justify-center rounded-md text-ink-faint transition-colors hover:bg-white/5 hover:text-negative',
                collapsed && 'lg:hidden',
              )}
              aria-label="Sair da conta"
              title="Sair"
            >
              <LogOut className="size-4" aria-hidden />
            </button>
          </div>
          <button
            type="button"
            onClick={() => setCollapsed((value) => !value)}
            className="mt-2 hidden min-h-9 w-full items-center justify-center gap-2 rounded-md px-2 text-[0.75rem] text-ink-faint transition-colors hover:bg-white/5 hover:text-ink-muted lg:flex"
            aria-label={collapsed ? 'Expandir menu lateral' : 'Recolher menu lateral'}
          >
            <ChevronsLeft className={cn('size-3.5 transition-transform', collapsed && 'rotate-180')} aria-hidden />
            <span className={cn(collapsed && 'hidden')}>Recolher</span>
          </button>
        </div>
      </aside>
    </>
  )
}

function NavItemLink({
  item,
  collapsed,
  pendingReview,
}: {
  item: NavItem
  collapsed: boolean
  pendingReview: number
}) {
  const Icon = item.icon
  const badgeValue = item.badgeKey === 'pendingReview' ? pendingReview : 0

  return (
    <NavLink
      to={item.to}
      end={item.end}
      title={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        cn(
          'group relative flex items-center gap-2.5 rounded-md px-2 py-2 text-[0.8125rem] font-medium transition-colors',
          collapsed && 'lg:justify-center lg:px-0',
          isActive
            ? 'bg-signal/10 text-ink'
            : 'text-ink-subtle hover:bg-white/[0.035] hover:text-ink-muted',
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive ? (
            <span aria-hidden className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-signal" />
          ) : null}
          <Icon aria-hidden className={cn('size-4 shrink-0', isActive ? 'text-signal-bright' : 'text-ink-faint group-hover:text-ink-subtle')} />
          <span className={cn('truncate', collapsed && 'lg:hidden')}>{item.label}</span>
          {badgeValue > 0 ? (
            <span
              className={cn(
                'tnum ml-auto rounded bg-caution/15 px-1.5 py-px text-[0.75rem] font-semibold text-caution',
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
  return (
    <div className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-hairline bg-base/90 px-4 backdrop-blur-xl lg:hidden">
      <button
        type="button"
        onClick={onOpenMenu}
        aria-label="Abrir menu"
        className="rounded-md p-1.5 text-ink-muted hover:bg-white/5 hover:text-ink"
      >
        <Menu className="size-5" aria-hidden />
      </button>
      <Logo size={22} />
      <Wordmark className="text-sm" />
    </div>
  )
}
