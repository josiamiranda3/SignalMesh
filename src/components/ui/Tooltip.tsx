import { useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Tooltip.
 *
 * Hover/focus driven, keyboard accessible (shows on focus), and rendered in a
 * portal-free absolute layer so it never affects layout.
 */
export function Tooltip({
  content,
  children,
  side = 'top',
  className,
}: {
  content: string
  children: ReactNode
  side?: 'top' | 'bottom'
  className?: string
}) {
  const [visible, setVisible] = useState(false)

  return (
    <span
      className={cn('relative inline-flex', className)}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      {children}
      {visible ? (
        <span
          role="tooltip"
          className={cn(
            'animate-fade pointer-events-none absolute left-1/2 z-50 w-max max-w-64 -translate-x-1/2 rounded-md border border-hairline-strong bg-overlay px-2.5 py-1.5 text-[0.71875rem] leading-snug text-ink-muted shadow-lift',
            side === 'top' ? 'bottom-[calc(100%+8px)]' : 'top-[calc(100%+8px)]',
          )}
        >
          {content}
        </span>
      ) : null}
    </span>
  )
}
