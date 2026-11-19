import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Page container with consistent max width and responsive gutters. */
export function PageContainer({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('mx-auto w-full max-w-[1400px] px-5 py-7 sm:px-7 lg:px-9', className)}>{children}</div>
}

export function Breadcrumbs({ items }: { items: Array<{ label: string; to?: string }> }) {
  return (
    <nav aria-label="Trilha de navegação" className="mb-4">
      <ol className="flex flex-wrap items-center gap-1 text-[0.75rem] text-ink-faint">
        {items.map((item, index) => (
          <li key={`${item.label}-${index}`} className="flex items-center gap-1">
            {index > 0 ? <ChevronRight className="size-3 text-ink-faint" aria-hidden /> : null}
            {item.to ? (
              <Link to={item.to} className="inline-flex min-h-9 items-center transition-colors hover:text-ink-muted">
                {item.label}
              </Link>
            ) : (
              <span aria-current="page" className="text-ink-muted">
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
 * A single, predictable structure for every screen: eyebrow → title →
 * description → actions. Keeping it in one component is what makes the app feel
 * like one product rather than a set of pages.
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
    <header className={cn('flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between', className)}>
      <div className="min-w-0">
        {eyebrow ? <p className="eyebrow mb-2">{eyebrow}</p> : null}
        <h1 className="text-balance text-[1.375rem] font-semibold tracking-[-0.022em] text-ink sm:text-[1.5rem]">
          {title}
        </h1>
        {description ? (
          <div className="mt-1.5 max-w-2xl text-pretty text-[0.8125rem] leading-relaxed text-ink-subtle">
            {description}
          </div>
        ) : null}
        {meta ? <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">{meta}</div> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  )
}

/** Section heading inside a page body. */
export function SectionHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string
  description?: string
  actions?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex items-end justify-between gap-4', className)}>
      <div>
        <h2 className="text-[0.9375rem] font-semibold tracking-[-0.01em] text-ink">{title}</h2>
        {description ? <p className="mt-1 text-[0.75rem] text-ink-subtle">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}

/** Key/value meta pair used under page titles. */
export function MetaItem({ label, value }: { label: string; value: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5 text-[0.75rem] text-ink-subtle">
      <span className="meta-label">{label}</span>
      <span className="text-ink-muted">{value}</span>
    </span>
  )
}
