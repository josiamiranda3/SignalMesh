import { Loader2 } from 'lucide-react'
import { Logo } from '@/components/brand/Logo'

/** Full-viewport loading state used while the session resolves. */
export function FullPageLoading({ label = 'Carregando' }: { label?: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-canvas">
      <Logo size={34} />
      <div className="flex items-center gap-2 text-[0.8125rem] text-ink-subtle">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        {label}…
      </div>
    </div>
  )
}
