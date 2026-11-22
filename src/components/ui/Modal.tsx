import { useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/I18nProvider'

/**
 * Modal dialog.
 *
 * Implements the dialog contract: focus moves in on open, Escape closes, focus
 * returns to the trigger on close, background scroll is locked, and the
 * backdrop is clickable. The `danger` variant colours the confirm action.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md' | 'lg'
}) {
  const { t } = useI18n()
  const dialogRef = useRef<HTMLDivElement>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    previouslyFocused.current = document.activeElement as HTMLElement | null
    const timer = window.setTimeout(() => {
      const focusable = dialogRef.current?.querySelector<HTMLElement>(
        'input, textarea, select, button:not([data-autofocus-skip]), [tabindex]:not([tabindex="-1"])',
      )
      focusable?.focus()
    }, 30)

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
      if (event.key === 'Tab' && dialogRef.current) {
        const focusables = [
          ...dialogRef.current.querySelectorAll<HTMLElement>(
            'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
          ),
        ].filter((element) => element.offsetParent !== null)
        if (focusables.length === 0) return
        const first = focusables[0]!
        const last = focusables[focusables.length - 1]!
        if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        }
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      previouslyFocused.current?.focus?.()
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-90 flex items-end justify-center p-0 sm:items-center sm:p-6">
      <button
        type="button"
        aria-label={t('common.close')}
        tabIndex={-1}
        onClick={onClose}
        className="animate-fade absolute inset-0 cursor-default bg-black/70 backdrop-blur-[2px]"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        aria-describedby={description ? 'modal-description' : undefined}
        className={cn(
          'animate-scale-in relative z-10 w-full overflow-hidden rounded-t-xl border border-hairline-strong bg-overlay shadow-lift sm:rounded-xl',
          size === 'sm' && 'sm:max-w-sm',
          size === 'md' && 'sm:max-w-lg',
          size === 'lg' && 'sm:max-w-2xl',
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-hairline px-5 py-4">
          <div className="min-w-0">
            <h2 id="modal-title" className="text-[0.9375rem] font-semibold text-ink">
              {title}
            </h2>
            {description ? (
              <p id="modal-description" className="mt-1 text-[0.8125rem] leading-relaxed text-ink-subtle">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="-mr-1.5 -mt-1 size-7 shrink-0 rounded text-ink-faint transition-colors hover:bg-white/5 hover:text-ink-muted"
          >
            <X aria-hidden className="mx-auto size-4" />
          </button>
        </div>
        {children ? <div className="max-h-[65vh] overflow-y-auto px-5 py-4">{children}</div> : null}
        {footer ? <div className="flex justify-end gap-2 border-t border-hairline px-5 py-3.5">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  )
}
