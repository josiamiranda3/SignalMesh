import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/**
 * Form primitives.
 *
 * Inputs always render a visible label, a hint and an error slot wired through
 * aria-describedby/aria-invalid, so screen readers announce the same context a
 * sighted user sees.
 */

const FIELD_BASE =
  'w-full rounded-md border bg-[#0b1018] text-sm text-ink placeholder:text-ink-faint transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed'

const FIELD_STATE = {
  normal: 'border-hairline-strong hover:border-[#37425a] focus:border-signal focus:outline-none focus:ring-2 focus:ring-signal/20',
  invalid: 'border-negative/70 focus:border-negative focus:outline-none focus:ring-2 focus:ring-negative/20',
}

export interface FieldShellProps {
  label: string
  htmlFor: string
  hint?: ReactNode
  error?: string | null
  optional?: boolean
  className?: string
  children: ReactNode
  counter?: string
}

export function FieldShell({ label, htmlFor, hint, error, optional, className, children, counter }: FieldShellProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={htmlFor} className="text-[0.8125rem] font-medium text-ink-muted">
          {label}
          {optional ? <span className="ml-1.5 text-[0.75rem] font-normal text-ink-faint">opcional</span> : null}
        </label>
        {counter ? <span className="tnum text-[0.75rem] text-ink-faint">{counter}</span> : null}
      </div>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} role="alert" className="text-[0.75rem] leading-snug text-negative">
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="text-[0.75rem] leading-snug text-ink-faint">
          {hint}
        </p>
      ) : null}
    </div>
  )
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(FIELD_BASE, 'h-9.5 px-3', invalid ? FIELD_STATE.invalid : FIELD_STATE.normal, className)}
      {...rest}
    />
  )
})

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(FIELD_BASE, 'min-h-24 resize-y px-3 py-2.5 leading-relaxed', invalid ? FIELD_STATE.invalid : FIELD_STATE.normal, className)}
      {...rest}
    />
  )
})

export interface SelectProps extends InputHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean
  options: Array<{ value: string; label: string }>
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, invalid, options, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        FIELD_BASE,
        'h-9.5 appearance-none bg-[url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'12\' viewBox=\'0 0 12 12\'%3E%3Cpath fill=\'%236e7a93\' d=\'M6 8.5 1.5 4h9z\'/%3E%3C/svg%3E")] bg-[length:12px] bg-[right_0.75rem_center] bg-no-repeat px-3 pr-8',
        invalid ? FIELD_STATE.invalid : FIELD_STATE.normal,
        className,
      )}
      {...rest}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} className="bg-surface text-ink">
          {option.label}
        </option>
      ))}
    </select>
  )
})

/** A labelled field with all wiring done for you. */
export function Field({
  label,
  hint,
  error,
  optional,
  counter,
  className,
  children,
  id,
}: Omit<FieldShellProps, 'htmlFor'> & { id?: string }) {
  const generated = useId()
  const fieldId = id ?? generated
  return (
    <FieldShell
      label={label}
      htmlFor={fieldId}
      hint={hint}
      error={error}
      optional={optional}
      className={className}
      counter={counter}
    >
      {children}
    </FieldShell>
  )
}
