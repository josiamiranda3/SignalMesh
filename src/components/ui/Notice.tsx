import { AlertTriangle, Info, ShieldAlert, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Inline notice.
 *
 * Used for provider failures, cost-protection messages, privacy disclosures and
 * limitations. Tone never changes the wording: an error always says what
 * happened and what the user can do next.
 */
export function Notice({
  tone = 'info',
  title,
  children,
  action,
  onDismiss,
  className,
}: {
  tone?: 'info' | 'caution' | 'danger' | 'positive'
  title?: string
  children?: ReactNode
  action?: ReactNode
  onDismiss?: () => void
  className?: string
}) {
  const styles = {
    info: { box: 'border-signal/25 bg-signal/[0.07]', icon: 'text-signal-bright', Icon: Info },
    caution: { box: 'border-caution/30 bg-caution/[0.07]', icon: 'text-caution', Icon: AlertTriangle },
    danger: { box: 'border-negative/30 bg-negative/[0.07]', icon: 'text-negative', Icon: ShieldAlert },
    positive: { box: 'border-positive/25 bg-positive/[0.07]', icon: 'text-positive', Icon: Info },
  }[tone]

  return (
    <div className={cn('flex gap-3 rounded-lg border px-4 py-3', styles.box, className)} role={tone === 'danger' ? 'alert' : 'status'}>
      <styles.Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', styles.icon)} />
      <div className="min-w-0 flex-1">
        {title ? <p className="text-[0.8125rem] font-semibold text-ink">{title}</p> : null}
        {children ? (
          <div className={cn('text-[0.8125rem] leading-relaxed text-ink-muted', title && 'mt-1')}>{children}</div>
        ) : null}
        {action ? <div className="mt-3">{action}</div> : null}
      </div>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dispensar aviso"
          className="-mr-1 -mt-0.5 size-6 shrink-0 rounded text-ink-faint transition-colors hover:bg-white/5 hover:text-ink-muted"
        >
          <X aria-hidden className="mx-auto size-3.5" />
        </button>
      ) : null}
    </div>
  )
}
