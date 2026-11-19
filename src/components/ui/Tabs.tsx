import { cn } from '@/lib/utils'

/**
 * Tabs.
 *
 * Implemented with the ARIA tab pattern: roving tabindex, arrow-key navigation,
 * and a visible focus ring. Tabs that navigate keep their own URL semantics; this
 * component is for in-page panels.
 */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  className,
  ariaLabel,
}: {
  tabs: Array<{ value: T; label: string; count?: number; icon?: React.ReactNode }>
  value: T
  onChange: (value: T) => void
  className?: string
  ariaLabel: string
}) {
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((tab) => tab.value === value)
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      onChange(tabs[(index + 1) % tabs.length]!.value)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      onChange(tabs[(index - 1 + tabs.length) % tabs.length]!.value)
    } else if (event.key === 'Home') {
      event.preventDefault()
      onChange(tabs[0]!.value)
    } else if (event.key === 'End') {
      event.preventDefault()
      onChange(tabs[tabs.length - 1]!.value)
    }
  }

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      className={cn(
        'no-scrollbar -mx-1 flex gap-1 overflow-x-auto border-b border-hairline px-1 scroll-px-1',
        className,
      )}
    >
      {tabs.map((tab) => {
        const selected = tab.value === value
        return (
          <button
            key={tab.value}
            role="tab"
            type="button"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.value)}
            className={cn(
              'relative flex shrink-0 items-center gap-1.5 px-3 py-2.5 text-[0.8125rem] font-medium transition-colors',
              selected ? 'text-ink' : 'text-ink-subtle hover:text-ink-muted',
            )}
          >
            {tab.icon}
            {tab.label}
            {tab.count !== undefined ? (
              <span
                className={cn(
                  'tnum rounded px-1.5 py-px text-[0.75rem]',
                  selected ? 'bg-signal/15 text-signal-bright' : 'bg-raised text-ink-faint',
                )}
              >
                {tab.count}
              </span>
            ) : null}
            {selected ? (
              <span aria-hidden className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-signal" />
            ) : null}
          </button>
        )
      })}
    </div>
  )
}
