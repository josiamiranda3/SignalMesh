import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import type { InvestigationStatus, ValidationStatus } from '@shared/domain'

/**
 * Badges communicate state. Colour is paired with a label and a dot, so state
 * is never conveyed by colour alone (WCAG 1.4.1).
 */

type Tone = 'neutral' | 'positive' | 'caution' | 'negative' | 'signal' | 'violet' | 'cyan'

const TONES: Record<Tone, string> = {
  neutral: 'border-hairline-strong/70 bg-raised/60 text-ink-muted',
  positive: 'border-positive/25 bg-positive/10 text-positive',
  caution: 'border-caution/25 bg-caution/10 text-caution',
  negative: 'border-negative/25 bg-negative/10 text-negative',
  signal: 'border-signal/30 bg-signal/10 text-signal-bright',
  violet: 'border-violet/30 bg-violet/10 text-[#b3a8ff]',
  cyan: 'border-cyan/25 bg-cyan/10 text-cyan',
}

const DOTS: Record<Tone, string> = {
  neutral: 'bg-ink-faint',
  positive: 'bg-positive',
  caution: 'bg-caution',
  negative: 'bg-negative',
  signal: 'bg-signal',
  violet: 'bg-violet',
  cyan: 'bg-cyan',
}

export function Badge({
  children,
  tone = 'neutral',
  dot = false,
  className,
}: {
  children: ReactNode
  tone?: Tone
  dot?: boolean
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[0.75rem] font-medium leading-5',
        TONES[tone],
        className,
      )}
    >
      {dot ? <span aria-hidden className={cn('size-1.5 rounded-full', DOTS[tone])} /> : null}
      {children}
    </span>
  )
}

const INVESTIGATION_TONES: Record<InvestigationStatus, Tone> = {
  draft: 'neutral',
  active: 'signal',
  completed: 'positive',
  archived: 'neutral',
}

const INVESTIGATION_LABELS: Record<InvestigationStatus, string> = {
  draft: 'Rascunho',
  active: 'Em andamento',
  completed: 'Concluída',
  archived: 'Arquivada',
}

export function InvestigationStatusBadge({ status }: { status: InvestigationStatus }) {
  return (
    <Badge tone={INVESTIGATION_TONES[status]} dot>
      {INVESTIGATION_LABELS[status]}
    </Badge>
  )
}

const VALIDATION_TONES: Record<ValidationStatus, Tone> = {
  pending: 'neutral',
  accepted: 'positive',
  rejected: 'negative',
  needs_review: 'caution',
}

const VALIDATION_LABELS: Record<ValidationStatus, string> = {
  pending: 'Pendente',
  accepted: 'Aprovada',
  rejected: 'Rejeitada',
  needs_review: 'Em revisão',
}

export function ValidationStatusBadge({ status }: { status: ValidationStatus }) {
  return (
    <Badge tone={VALIDATION_TONES[status]} dot>
      {VALIDATION_LABELS[status]}
    </Badge>
  )
}

export function validationLabel(status: ValidationStatus): string {
  return VALIDATION_LABELS[status]
}

export function investigationStatusLabel(status: InvestigationStatus): string {
  return INVESTIGATION_LABELS[status]
}

export function validationTone(status: ValidationStatus): Tone {
  return VALIDATION_TONES[status]
}
