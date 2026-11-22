import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useI18n } from '@/i18n/I18nProvider'

/**
 * Toast system.
 *
 * Action feedback always goes through here so the placement, timing and
 * semantics are consistent. Toasts are announced politely (role=status), except
 * errors which use role=alert.
 */

type ToastTone = 'success' | 'error' | 'info' | 'warning'

interface Toast {
  id: string
  tone: ToastTone
  title: string
  detail?: string
}

interface ToastApi {
  success: (title: string, detail?: string) => void
  error: (title: string, detail?: string) => void
  info: (title: string, detail?: string) => void
  warning: (title: string, detail?: string) => void
}

const ToastContext = createContext<ToastApi | null>(null)

const TONE_STYLE: Record<ToastTone, { border: string; icon: string; Icon: typeof Info }> = {
  success: { border: 'border-positive/30', icon: 'text-positive', Icon: CheckCircle2 },
  error: { border: 'border-negative/35', icon: 'text-negative', Icon: XCircle },
  warning: { border: 'border-caution/35', icon: 'text-caution', Icon: AlertTriangle },
  info: { border: 'border-signal/30', icon: 'text-signal-bright', Icon: Info },
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n()
  const [toasts, setToasts] = useState<Toast[]>([])

  const push = useCallback((tone: ToastTone, title: string, detail?: string) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    setToasts((current) => [...current.slice(-3), { id, tone, title, detail }])
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id))
    }, tone === 'error' ? 9000 : 5200)
  }, [])

  const api = useMemo<ToastApi>(
    () => ({
      success: (title, detail) => push('success', title, detail),
      error: (title, detail) => push('error', title, detail),
      info: (title, detail) => push('info', title, detail),
      warning: (title, detail) => push('warning', title, detail),
    }),
    [push],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-100 flex flex-col items-center gap-2 p-4 sm:items-end sm:p-6"
      >
        {toasts.map((toast) => {
          const style = TONE_STYLE[toast.tone]
          return (
            <div
              key={toast.id}
              role={toast.tone === 'error' ? 'alert' : 'status'}
              className={cn(
                'animate-scale-in pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-lg border bg-overlay/95 p-3.5 shadow-lift backdrop-blur',
                style.border,
              )}
            >
              <style.Icon aria-hidden className={cn('mt-0.5 size-4 shrink-0', style.icon)} />
              <div className="min-w-0 flex-1">
                <p className="text-[0.8125rem] font-medium leading-snug text-ink">{toast.title}</p>
                {toast.detail ? (
                  <p className="mt-1 text-[0.75rem] leading-relaxed text-ink-subtle">{toast.detail}</p>
                ) : null}
              </div>
              <button
                type="button"
                aria-label={t('common.closeToast')}
                onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}
                className="-mr-1 -mt-1 size-6 shrink-0 rounded text-ink-faint transition-colors hover:bg-white/5 hover:text-ink-muted"
              >
                <X aria-hidden className="mx-auto size-3.5" />
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext)
  if (!context) throw new Error('useToast precisa estar dentro de <ToastProvider>')
  return context
}
