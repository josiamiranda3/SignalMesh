import { useState, type KeyboardEvent } from 'react'
import { Check, Pencil, Plus, Tag, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  MAX_KEYWORDS,
  MAX_KEYWORD_LENGTH,
  mergeKeywords,
  renameKeyword,
} from '@/lib/keywords'
import { Button, Input } from '@/components/ui'
import { useI18n } from '@/i18n/I18nProvider'

/**
 * Keyword editor.
 *
 * The single implementation of "edit the keyword list", used by both the
 * creation form and the edit modal. Having one owner matters here: the
 * normalisation rules (how a pasted list is split) and the limits (20 terms, 64
 * characters each) are product rules, and two copies would drift — the modal
 * would accept something the creation form rejects, or silently join terms.
 *
 * The rules themselves live in `src/lib/keywords.ts`; this component is only
 * the UI around them.
 *
 * The component is controlled: it owns only the draft input and which chip is
 * being edited. The list itself lives in the parent form, so the parent decides
 * when it is submitted.
 */

export { MAX_KEYWORDS, MAX_KEYWORD_LENGTH, splitKeywords, dedupeKeywords } from '@/lib/keywords'

export interface KeywordEditorProps {
  value: string[]
  onChange: (next: string[]) => void
  /** Field-level error to show under the editor. */
  error?: string | null
  /** Adds `aria-invalid` / `aria-describedby` to the input for a11y wiring. */
  errorId?: string
  disabled?: boolean
  inputRef?: React.Ref<HTMLInputElement>
  /** Labels the input; the creation form and the modal can differ. */
  label?: string
  /**
   * Reports a rule violation the editor detected while merging an entry
   * (a term over the length limit, or the list full). The parent owns the error
   * state, so the message must travel up — otherwise the problem is silently
   * dropped and the user sees nothing.
   *
   * Called with `null` when an attempt was fully accepted, so the parent can
   * clear a stale message.
   */
  onProblem?: (problem: string | null) => void
}

export function KeywordEditor({
  value,
  onChange,
  error,
  errorId,
  disabled = false,
  inputRef,
  label,
  onProblem,
}: KeywordEditorProps) {
  const [draft, setDraft] = useState('')
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editingValue, setEditingValue] = useState('')
  const { t } = useI18n()
  // The default label is resolved here, not in the parameter list, because a
  // default value cannot call a hook.
  const resolvedLabel = label ?? t('common.addKeyword')

  /**
   * Commit the draft. Returns true when everything was accepted, so the caller
   * can clear an error only when the attempt actually succeeded.
   */
  const commitDraft = (): boolean => {
    const { next, problem } = mergeKeywords(value, draft)
    if (next !== value) onChange(next)
    setDraft('')
    onProblem?.(problem)
    return problem === null
  }

  const startEditing = (index: number) => {
    setEditingIndex(index)
    setEditingValue(value[index] ?? '')
  }

  const commitEditing = () => {
    if (editingIndex === null) return
    const trimmed = editingValue.trim()
    if (!trimmed) {
      // An emptied term is a removal, which is what the user expressed.
      onChange(value.filter((_, index) => index !== editingIndex))
      setEditingIndex(null)
      setEditingValue('')
      return
    }
    const renamed = renameKeyword(value, editingIndex, trimmed)
    // `null` means the rename was refused (duplicate or too long): keep editing.
    if (renamed === null) return
    onChange(renamed)
    setEditingIndex(null)
    setEditingValue('')
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      // Enter adds a term and must never submit the surrounding form.
      event.preventDefault()
      commitDraft()
    }
  }

  const atLimit = value.length >= MAX_KEYWORDS

  return (
    <div>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Tag
            className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint"
            aria-hidden
          />
          <Input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => {
              // A term typed but not confirmed with Enter is not thrown away.
              if (draft.trim()) commitDraft()
            }}
            placeholder={atLimit ? t('common.keywordLimitPlaceholder') : t('common.keywordPlaceholder')}
            className="pl-9"
            aria-label={resolvedLabel}
            aria-invalid={error ? true : undefined}
            aria-describedby={error && errorId ? errorId : undefined}
            disabled={disabled || atLimit}
          />
        </div>
        <Button
          variant="secondary"
          onClick={() => commitDraft()}
          iconLeft={<Plus className="size-3.5" aria-hidden />}
          disabled={disabled || atLimit}
        >
          {t('common.add')}
        </Button>
      </div>

      <p className="mt-1.5 text-[0.75rem] text-ink-faint">
        {value.length} de {MAX_KEYWORDS} termos.
      </p>

      {value.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {value.map((keyword, index) => {
            const isEditing = editingIndex === index
            return (
              <li
                key={`${keyword}-${index}`}
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border py-0.5 pl-2.5 pr-1 text-[0.75rem]',
                  isEditing
                    ? 'border-signal/50 bg-signal/10 text-ink'
                    : 'border-hairline-strong bg-raised text-ink-muted',
                )}
              >
                {isEditing ? (
                  <>
                    <input
                      autoFocus
                      value={editingValue}
                      onChange={(event) => setEditingValue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          commitEditing()
                        }
                        if (event.key === 'Escape') {
                          event.preventDefault()
                          setEditingIndex(null)
                          setEditingValue('')
                        }
                      }}
                      onBlur={commitEditing}
                      maxLength={MAX_KEYWORD_LENGTH}
                      aria-label={t('common.editKeyword', { keyword })}
                      className="w-32 rounded-sm border border-hairline-strong bg-canvas/80 px-1.5 py-0.5 text-[0.75rem] text-ink focus:border-signal focus:outline-none"
                    />
                    <button
                      type="button"
                      // `onMouseDown` runs before the input's blur, so the click
                      // is not swallowed by commit-on-blur.
                      onMouseDown={(event) => {
                        event.preventDefault()
                        commitEditing()
                      }}
                      aria-label={t('common.confirmKeywordEdit', { keyword })}
                      className="rounded-full p-0.5 text-positive transition-colors hover:bg-white/5"
                    >
                      <Check className="size-3" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault()
                        setEditingIndex(null)
                        setEditingValue('')
                      }}
                      aria-label={t('common.cancelKeywordEdit', { keyword })}
                      className="rounded-full p-0.5 text-ink-faint transition-colors hover:bg-white/5 hover:text-ink-muted"
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  </>
                ) : (
                  <>
                    <span>{keyword}</span>
                    <button
                      type="button"
                      onClick={() => startEditing(index)}
                      disabled={disabled}
                      aria-label={t('common.editKeyword', { keyword })}
                      className="rounded-full p-0.5 text-ink-faint transition-colors hover:bg-white/5 hover:text-ink-muted disabled:opacity-40"
                    >
                      <Pencil className="size-3" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => onChange(value.filter((_, i) => i !== index))}
                      disabled={disabled}
                      aria-label={t('common.removeKeyword', { keyword })}
                      className="rounded-full p-0.5 text-ink-faint transition-colors hover:bg-white/5 hover:text-negative disabled:opacity-40"
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  </>
                )}
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="mt-2 text-[0.75rem] text-ink-faint">{t('common.noKeywords')}</p>
      )}
    </div>
  )
}
