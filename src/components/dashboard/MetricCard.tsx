import { ArrowDownRight, ArrowUpRight, Minus, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Metric card.
 *
 * Shows one number with its label and — when the data supports it — a
 * comparison against the previous period. A metric with no data renders a dash,
 * never a fabricated zero, and the footnote explains what the number counts.
 */
export function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
  trend,
  tone = 'neutral',
  className,
}: {
  label: string
  value: ReactNode
  hint?: string
  icon: LucideIcon
  trend?: { value: number; label: string }
  tone?: 'neutral' | 'signal' | 'positive' | 'caution' | 'negative'
  className?: string
}) {
  const accent = {
    neutral: 'text-ink-muted',
    signal: 'text-signal-bright',
    positive: 'text-positive',
    caution: 'text-caution',
    negative: 'text-negative',
  }[tone]

  return (
    <div className={cn('panel group relative overflow-hidden p-5 transition-colors hover:border-hairline-strong', className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[0.75rem] font-medium text-ink-subtle">{label}</p>
        <Icon aria-hidden className={cn('size-4 shrink-0', accent)} />
      </div>
      <p className="tnum mt-3 text-[1.75rem] font-semibold leading-none tracking-[-0.03em] text-ink">{value}</p>
      <div className="mt-3 flex items-center gap-2">
        {trend ? (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 text-[0.75rem] font-medium',
              trend.value > 0 ? 'text-positive' : trend.value < 0 ? 'text-negative' : 'text-ink-faint',
            )}
          >
            {trend.value > 0 ? (
              <ArrowUpRight className="size-3" aria-hidden />
            ) : trend.value < 0 ? (
              <ArrowDownRight className="size-3" aria-hidden />
            ) : (
              <Minus className="size-3" aria-hidden />
            )}
            {trend.value > 0 ? '+' : ''}
            {trend.value}%
          </span>
        ) : null}
        <p className="truncate text-[0.75rem] text-ink-faint">{hint ?? (trend ? trend.label : '')}</p>
      </div>
    </div>
  )
}

/** Compact stat used inside detail panels (no card chrome). */
export function InlineStat({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: ReactNode
  tone?: 'default' | 'positive' | 'caution' | 'negative' | 'signal'
}) {
  const color = {
    default: 'text-ink',
    positive: 'text-positive',
    caution: 'text-caution',
    negative: 'text-negative',
    signal: 'text-signal-bright',
  }[tone]
  return (
    <div>
      <p className="meta-label">{label}</p>
      <p className={cn('tnum mt-1 text-base font-semibold', color)}>{value}</p>
    </div>
  )
}
