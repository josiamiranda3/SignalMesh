import { cn } from '@/lib/utils'

/** Signature chart: an area sparkline for a 30-day series. */
export function Sparkline({
  data,
  height = 64,
  className,
  ariaLabel,
  tone = 'signal',
}: {
  data: Array<{ date: string; count: number }>
  height?: number
  className?: string
  ariaLabel: string
  tone?: 'signal' | 'cyan'
}) {
  const width = 320
  const max = Math.max(1, ...data.map((point) => point.count))
  const step = data.length > 1 ? width / (data.length - 1) : width

  const points = data.map((point, index) => ({
    x: index * step,
    y: height - (point.count / max) * (height - 8) - 4,
  }))

  const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')
  const area = `${line} L${width},${height} L0,${height} Z`
  const stroke = tone === 'cyan' ? '#43d9d0' : '#5b8cff'
  const gradientId = `spark-${tone}-${data.length}-${max}`

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={cn('w-full', className)}
      style={{ height }}
      role="img"
      aria-label={ariaLabel}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <path d={line} fill="none" stroke={stroke} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      {points.length > 0 ? (
        <circle cx={points[points.length - 1]!.x} cy={points[points.length - 1]!.y} r="2.6" fill={stroke} />
      ) : null}
    </svg>
  )
}

/** Horizontal bar distribution used for "evidence by status". */
export function BarDistribution({
  rows,
  className,
}: {
  rows: Array<{ label: string; value: number; tone: string }>
  className?: string
}) {
  const max = Math.max(1, ...rows.map((row) => row.value))
  return (
    <div className={cn('space-y-3', className)}>
      {rows.map((row) => (
        <div key={row.label}>
          <div className="mb-1.5 flex items-baseline justify-between gap-3">
            <span className="text-[0.75rem] text-ink-muted">{row.label}</span>
            <span className="tnum text-[0.75rem] font-medium text-ink">{row.value}</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#161c29]">
            <div
              className={cn('h-full rounded-full transition-[width] duration-500', row.tone)}
              style={{ width: `${(row.value / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * Relevance gauge: a 0–100 index with the explicit caveat that it is a
 * prioritisation aid, not a truth score.
 */
export function ScoreDial({ score, size = 44 }: { score: number | null; size?: number }) {
  if (score === null) {
    return (
      <div
        className="flex items-center justify-center rounded-full border border-hairline-strong text-[0.75rem] text-ink-faint"
        style={{ width: size, height: size }}
        title="Sem dados suficientes para calcular prioridade"
      >
        n/d
      </div>
    )
  }
  const percent = Math.round(score * 100)
  const color = percent >= 70 ? '#34d399' : percent >= 45 ? '#5b8cff' : '#f5b544'
  return (
    <div
      className="relative flex items-center justify-center rounded-full"
      style={{
        width: size,
        height: size,
        background: `conic-gradient(${color} ${percent * 3.6}deg, #1b2231 0deg)`,
      }}
      title={`Índice de priorização: ${percent}/100`}
    >
      <div className="flex items-center justify-center rounded-full bg-surface" style={{ width: size - 7, height: size - 7 }}>
        <span className="tnum text-[0.75rem] font-semibold text-ink">{percent}</span>
      </div>
    </div>
  )
}
