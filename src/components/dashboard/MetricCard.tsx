import { ArrowDownRight, ArrowUpRight, Minus, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Metric card.
 *
 * The figure is the subject: it is set in the mono face, large, tabular and
 * tight, so a row of four cards scans as one calibrated readout. Everything
 * else in the card is deliberately quieter than the number.
 *
 * A metric with no data renders a dash, never a fabricated zero, and the
 * footnote explains what the number counts.
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
    neutral: 'text-ink-faint',
    signal: 'text-signal-bright',
    positive: 'text-positive',
    caution: 'text-caution',
    negative: 'text-negative',
  }[tone]

  return (
    <div
      className={cn(
        'panel group relative overflow-hidden p-5 transition-colors duration-200 hover:border-hairline-strong',
        className,
      )}
    >
      {/* A hairline accent on the top edge: the card's only decoration, and it
          marks the metric's state rather than the card itself. */}
      <span
        aria-hidden
        className={cn(
          'absolute inset-x-0 top-0 h-px',
          tone === 'neutral' ? 'bg-hairline' : 'bg-current opacity-40',
          accent,
        )}
      />

      <div className="flex items-start justify-between gap-3">
        <p className="meta-label">{label}</p>
        <Icon aria-hidden className={cn('size-3.5 shrink-0', accent)} />
      </div>

      <p className="figure mt-3.5 text-[1.875rem] leading-none text-ink">{value}</p>

      <div className="mt-3.5 flex items-center gap-2">
        {trend ? (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 font-mono text-[0.6875rem] font-medium',
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
        <p className="truncate text-[0.6875rem] text-ink-faint">{hint ?? (trend ? trend.label : '')}</p>
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
      <p className={cn('figure mt-1.5 text-[0.9375rem]', color)}>{value}</p>
    </div>
  )
}
