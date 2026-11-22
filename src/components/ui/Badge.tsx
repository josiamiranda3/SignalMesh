import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { useI18n, type TranslationKey } from '@/i18n/I18nProvider'
import { translate } from '@/i18n/translate'
import type { InvestigationStatus, ValidationStatus } from '@shared/domain'

/**
 * Badges communicate state. Colour is paired with a label and a dot, so state
 * is never conveyed by colour alone (WCAG 1.4.1).
 */

type Tone = 'neutral' | 'positive' | 'caution' | 'negative' | 'signal' | 'accent'

/**
 * Investigation lifecycle tones.
 *
 * Separate from the generic semantic tones above on purpose: a project's stage
 * is not "good" or "bad", it is *where it is in the pipeline*, and each stage
 * needs its own hue so the four are distinguishable at a glance. Mapping them
 * onto `positive`/`caution`/`negative` would have made "archived" look like an
 * error and "completed" the same green as an approved evidence item.
 *
 * The `-line` token carries the dot and border (a solid, saturated hue); the
 * plain token carries the label text, which is 12px and therefore needs its own
 * AA-safe value. Both are declared in `src/styles.css`.
 */
const STATUS_TONES = {
  draft: {
    badge: 'border-status-draft-line/40 bg-status-draft-line/10 text-status-draft',
    dot: 'bg-status-draft-line',
  },
  active: {
    badge: 'border-status-active-line/40 bg-status-active-line/10 text-status-active',
    dot: 'bg-status-active-line',
  },
  completed: {
    badge: 'border-status-completed-line/40 bg-status-completed-line/10 text-status-completed',
    dot: 'bg-status-completed-line',
  },
  archived: {
    badge: 'border-status-archived-line/40 bg-status-archived-line/10 text-status-archived',
    dot: 'bg-status-archived-line',
  },
} as const

const TONES: Record<Tone, string> = {
  neutral: 'border-hairline-strong/70 bg-raised/60 text-ink-muted',
  positive: 'border-positive/25 bg-positive/10 text-positive',
  caution: 'border-caution/25 bg-caution/10 text-caution',
  negative: 'border-negative/25 bg-negative/10 text-negative',
  // `signal` is the live/current state; `accent` is a quieter emphasis that
  // still reads as SignalMesh without competing with a real status.
  signal: 'border-signal/35 bg-signal/10 text-signal-bright',
  accent: 'border-hairline-strong bg-raised text-ink-subtle',
}

const DOTS: Record<Tone, string> = {
  neutral: 'bg-ink-faint',
  positive: 'bg-positive',
  caution: 'bg-caution',
  negative: 'bg-negative',
  signal: 'bg-signal',
  accent: 'bg-ink-subtle',
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

const INVESTIGATION_TONES: Record<InvestigationStatus, keyof typeof STATUS_TONES> = {
  draft: 'draft',
  active: 'active',
  completed: 'completed',
  archived: 'archived',
}

/** Status labels are translation keys; the badge resolves them at render. */
const INVESTIGATION_LABELS: Record<InvestigationStatus, TranslationKey> = {
  draft: 'status.draft',
  active: 'status.active',
  completed: 'status.completed',
  archived: 'status.archived',
}

export function InvestigationStatusBadge({ status }: { status: InvestigationStatus }) {
  const { t } = useI18n()
  const tone = STATUS_TONES[INVESTIGATION_TONES[status]]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[0.75rem] font-medium leading-5',
        tone.badge,
      )}
    >
      <span aria-hidden className={cn('size-1.5 rounded-full', tone.dot)} />
      {t(INVESTIGATION_LABELS[status])}
    </span>
  )
}

const VALIDATION_TONES: Record<ValidationStatus, Tone> = {
  pending: 'neutral',
  accepted: 'positive',
  rejected: 'negative',
  needs_review: 'caution',
}

const VALIDATION_LABELS: Record<ValidationStatus, TranslationKey> = {
  pending: 'status.pending',
  accepted: 'status.accepted',
  rejected: 'status.rejected',
  needs_review: 'status.needs_review',
}

export function ValidationStatusBadge({ status }: { status: ValidationStatus }) {
  const { t } = useI18n()
  return (
    <Badge tone={VALIDATION_TONES[status]} dot>
      {t(VALIDATION_LABELS[status])}
    </Badge>
  )
}

/**
 * Translated label for a status.
 *
 * Non-hook callers (option lists, toast text, static data) use these instead of
 * `useI18n`, so they read the *active* locale via the module binding. A
 * component that renders them re-renders on language change because the
 * provider above it re-renders.
 */
export function validationLabel(status: ValidationStatus): string {
  return translate(VALIDATION_LABELS[status])
}

export function investigationStatusLabel(status: InvestigationStatus): string {
  return translate(INVESTIGATION_LABELS[status])
}

export function validationTone(status: ValidationStatus): Tone {
  return VALIDATION_TONES[status]
}
