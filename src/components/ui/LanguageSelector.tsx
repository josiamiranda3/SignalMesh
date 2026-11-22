import { Check, Languages } from 'lucide-react'
import { useI18n } from '@/i18n/I18nProvider'
import { LOCALES, LOCALE_LABELS, type Locale } from '@/i18n/locales'
import { cn } from '@/lib/utils'

/**
 * Language selector.
 *
 * A radio group, not a dropdown: with exactly two options, both are visible at
 * once and the current choice is obvious without opening anything. It is a
 * native radio group (keyboard arrows, focus ring and screen-reader semantics
 * come from the platform), and each option is labelled in its own language so a
 * user who landed in the wrong locale can always recognise their own.
 *
 * Switching is immediate — no reload, no navigation — and persists through
 * `localStorage` (see the provider).
 */
export function LanguageSelector({ className }: { className?: string }) {
  const { locale, setLocale } = useI18n()

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {LOCALES.map((option) => (
        <LanguageOption
          key={option}
          value={option}
          checked={locale === option}
          label={LOCALE_LABELS[option]}
          onSelect={() => setLocale(option)}
        />
      ))}
    </div>
  )
}

function LanguageOption({
  value,
  checked,
  label,
  onSelect,
}: {
  value: Locale
  checked: boolean
  label: string
  onSelect: () => void
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-center gap-3 rounded-lg border px-3.5 py-2.5 transition-colors duration-150',
        checked
          ? 'border-signal/45 bg-signal/[0.07]'
          : 'border-hairline hover:border-hairline-strong hover:bg-raised/50',
      )}
    >
      <input
        type="radio"
        name="locale"
        value={value}
        checked={checked}
        onChange={onSelect}
        className="sr-only"
        aria-label={label}
      />
      {/* The visual control is decorative: the native radio above owns the
          semantics and the keyboard behaviour. */}
      <span
        aria-hidden
        className={cn(
          'flex size-4 shrink-0 items-center justify-center rounded-full border',
          checked ? 'border-signal bg-signal text-white' : 'border-hairline-strong',
        )}
      >
        {checked ? <Check className="size-2.5" strokeWidth={3} /> : null}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <Languages aria-hidden className={cn('size-3.5 shrink-0', checked ? 'text-signal-bright' : 'text-ink-faint')} />
        <span className={cn('text-[0.8125rem] font-medium', checked ? 'text-ink' : 'text-ink-muted')}>{label}</span>
      </span>
    </label>
  )
}
