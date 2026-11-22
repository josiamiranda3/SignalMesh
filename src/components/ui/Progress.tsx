import { cn } from '@/lib/utils'

/** Thin progress bar used for quota consumption and pipeline steps. */
export function Progress({
  value,
  max = 1,
  className,
  tone = 'signal',
  label,
}: {
  value: number
  max?: number
  className?: string
  tone?: 'signal' | 'positive' | 'caution' | 'negative'
  label?: string
}) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0
  const barTone = {
    signal: 'bg-signal',
    positive: 'bg-positive',
    caution: 'bg-caution',
    negative: 'bg-negative',
  }[tone]

  return (
    <div
      role="progressbar"
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-[#1a222c]', className)}
    >
      <div
        className={cn('h-full rounded-full transition-[width] duration-500 ease-out', barTone)}
        style={{ width: `${ratio * 100}%` }}
      />
    </div>
  )
}

/** Segmented meter for multi-category distributions (evidence by status). */
export function Meter({
  segments,
  className,
  ariaLabel,
}: {
  segments: Array<{ value: number; tone: string; label: string }>
  className?: string
  ariaLabel: string
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0)

  return (
    <div className={cn('flex h-2 w-full overflow-hidden rounded-full bg-[#1a222c]', className)} role="img" aria-label={ariaLabel}>
      {total === 0 ? (
        <div className="h-full w-full bg-[#1a222c]" />
      ) : (
        segments
          .filter((segment) => segment.value > 0)
          .map((segment, index) => (
            <div
              key={index}
              className={cn('h-full', segment.tone)}
              style={{ width: `${(segment.value / total) * 100}%` }}
              title={`${segment.label}: ${segment.value}`}
            />
          ))
      )}
    </div>
  )
}
