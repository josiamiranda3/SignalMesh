import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Button.
 *
 * Variants are named by intent, not colour, so the visual language stays
 * consistent as the palette evolves. Every interactive state is covered:
 * hover, active, focus-visible, disabled and loading (with an aria-busy label).
 */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet'
type Size = 'sm' | 'md' | 'lg' | 'icon'

const VARIANTS: Record<Variant, string> = {
  // White on Signal Red measures 5.11:1 — the only pairing that clears AA for a
  // solid red fill. A dark label on this red would land at 3.8:1 and fail.
  primary:
    'bg-signal text-white font-semibold hover:bg-signal-deep active:bg-signal-deep shadow-[0_8px_24px_-14px_rgba(182,75,80,0.85)]',
  secondary:
    'bg-raised text-ink border border-hairline-strong hover:bg-overlay hover:border-[#3d4756] active:bg-raised',
  ghost: 'text-ink-muted hover:text-ink hover:bg-raised active:bg-overlay',
  danger:
    'bg-negative-dim text-negative border border-[#5a2233] hover:bg-[#4a1a29] hover:border-[#7a2e43] active:bg-negative-dim',
  quiet: 'text-ink-subtle hover:text-ink-muted hover:bg-raised/70',
}

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-[0.8125rem] gap-1.5 rounded-md',
  md: 'h-9.5 px-4 text-sm gap-2 rounded-md',
  lg: 'h-11 px-5 text-sm gap-2 rounded-lg',
  icon: 'h-8.5 w-8.5 rounded-md justify-center',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
  iconLeft?: ReactNode
  iconRight?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading = false, iconLeft, iconRight, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex select-none items-center whitespace-nowrap transition-[background-color,border-color,color,box-shadow,transform] duration-150',
        // A disabled button keeps receiving pointer events so the cursor can
        // report `not-allowed` (see the pointer-affordance layer in styles.css).
        // `pointer-events: none` made the button invisible to hit-testing, so the
        // cursor stayed whatever the element underneath had — usually an arrow,
        // which reads as "this is not a control" rather than "this control is
        // unavailable". Clicks are already prevented by `disabled` itself.
        'disabled:cursor-not-allowed disabled:opacity-45',
        'active:translate-y-px',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : iconLeft}
      {children}
      {!loading && iconRight}
    </button>
  )
})
