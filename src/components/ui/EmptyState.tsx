import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Empty state.
 *
 * Every list, table and panel has a designed empty state with an icon, a
 * concrete explanation of what would appear here, and — when the user can act —
 * a primary action. No screen is ever blank on first use.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  secondary,
  className,
  compact = false,
}: {
  icon: ReactNode
  title: string
  description: string
  action?: ReactNode
  secondary?: ReactNode
  className?: string
  compact?: boolean
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-lg border border-dashed border-hairline-strong/70 bg-surface/40 text-center',
        compact ? 'px-6 py-10' : 'px-8 py-16',
        className,
      )}
    >
      <div className="relative mb-5">
        <div
          aria-hidden
          className="absolute inset-0 -z-10 rounded-2xl bg-signal/20 blur-2xl"
          style={{ transform: 'scale(1.6)' }}
        />
        <div className="flex size-12 items-center justify-center rounded-xl border border-hairline-strong bg-raised text-signal-bright">
          {icon}
        </div>
      </div>
      <h3 className={cn('text-balance font-semibold text-ink', compact ? 'text-base' : 'text-lg')}>{title}</h3>
      <p className="mt-2 max-w-md text-pretty text-[0.8125rem] leading-relaxed text-ink-subtle">{description}</p>
      {action || secondary ? (
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondary}
        </div>
      ) : null}
    </div>
  )
}
