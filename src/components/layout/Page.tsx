import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/I18nProvider'

/**
 * Page container.
 *
 * The single source of page gutters and vertical rhythm. Every screen is
 * composed inside it, so the left edge of a page title, a metric card and a
 * table all agree — across routes and across breakpoints.
 *
 * Width: a wide reading measure (1560px) because this is a data product viewed
 * on large displays; the gutters step down on smaller screens rather than the
 * content stretching edge to edge.
 */
export function PageContainer({
  children,
  className,
  width = 'default',
}: {
  children: ReactNode
  className?: string
  /** `wide` for tables and multi-column boards, `narrow` for forms and prose. */
  width?: 'default' | 'wide' | 'narrow'
}) {
  return (
    <div
      className={cn(
        'mx-auto w-full px-5 pb-14 pt-7 sm:px-7 sm:pt-8 lg:px-10 lg:pt-9',
        width === 'default' && 'max-w-[1560px]',
        width === 'wide' && 'max-w-[1720px]',
        width === 'narrow' && 'max-w-[880px]',
        className,
      )}
    >
      {children}
    </div>
  )
}

export function Breadcrumbs({ items }: { items: Array<{ label: string; to?: string }> }) {
  const { t } = useI18n()
  return (
    <nav aria-label={t('common.breadcrumb')} className="mb-5">
      <ol className="flex flex-wrap items-center gap-1 font-mono text-[0.6875rem] uppercase tracking-[0.1em] text-ink-faint">
        {items.map((item, index) => (
          <li key={`${item.label}-${index}`} className="flex items-center gap-1">
            {index > 0 ? <ChevronRight className="size-3 text-ink-faint/60" aria-hidden /> : null}
            {item.to ? (
              <Link
                to={item.to}
                className="inline-flex min-h-9 items-center transition-colors hover:text-ink-muted"
              >
                {item.label}
              </Link>
            ) : (
              <span aria-current="page" className="text-ink-subtle">
                {item.label}
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}

/**
 * Page header.
 *
 * One predictable structure for every screen: eyebrow → title → description →
 * meta → actions. Keeping it in a single component is what makes the app feel
 * like one product rather than a collection of pages.
 *
 * The title is deliberately large and tight (tracking -0.03em): at this scale
 * the type itself does the work of establishing hierarchy, so the header needs
 * no decorative rule or background to read as a header.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  meta,
  className,
}: {
  eyebrow?: string
  title: string
  description?: ReactNode
  actions?: ReactNode
  meta?: ReactNode
  className?: string
}) {
  return (
    <header className={cn('border-b border-hairline pb-6', className)}>
      <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          {eyebrow ? (
            <div className="mb-3 flex items-center gap-2.5">
              <span aria-hidden className="h-px w-5 bg-signal" />
              <p className="eyebrow">{eyebrow}</p>
            </div>
          ) : null}
          <h1 className="text-balance text-[1.625rem] font-semibold leading-[1.15] tracking-[-0.03em] text-ink sm:text-[1.875rem]">
            {title}
          </h1>
          {description ? (
            <div className="mt-2.5 max-w-2xl text-pretty text-[0.8125rem] leading-relaxed text-ink-subtle">
              {description}
            </div>
          ) : null}
          {meta ? <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">{meta}</div> : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2 lg:pb-0.5">{actions}</div>
        ) : null}
      </div>
    </header>
  )
}

/**
 * Section heading inside a page body.
 *
 * Sits above a panel group. The optional index is a mono ordinal that gives
 * long pages a scannable spine ("01 — Evidências").
 */
export function SectionHeader({
  title,
  description,
  actions,
  index,
  className,
}: {
  title: string
  description?: string
  actions?: ReactNode
  index?: number
  className?: string
}) {
  return (
    <div className={cn('flex items-end justify-between gap-4', className)}>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2.5">
          {index !== undefined ? (
            <span className="font-mono text-[0.6875rem] tabular-nums text-ink-faint/80" aria-hidden>
              {String(index).padStart(2, '0')}
            </span>
          ) : null}
          <h2 className="text-[0.9375rem] font-semibold tracking-[-0.012em] text-ink">{title}</h2>
        </div>
        {description ? (
          <p className={cn('text-[0.75rem] text-ink-subtle', index !== undefined ? 'mt-1 pl-7' : 'mt-1')}>
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}

/** Key/value meta pair used under page titles. */
export function MetaItem({ label, value }: { label: string; value: ReactNode }) {
  return (
    <span className="flex items-baseline gap-2">
      <span className="meta-label">{label}</span>
      <span className="text-[0.8125rem] font-medium text-ink-muted">{value}</span>
    </span>
  )
}

/**
 * Section wrapper.
 *
 * A vertical group with a consistent internal gap. Using it instead of ad-hoc
 * `space-y-*` is what keeps the rhythm identical between pages.
 */
export function Section({
  children,
  className,
  gap = 'default',
}: {
  children: ReactNode
  className?: string
  gap?: 'default' | 'tight'
}) {
  return (
    <section className={cn('flex flex-col', gap === 'tight' ? 'gap-3' : 'gap-4', className)}>
      {children}
    </section>
  )
}
