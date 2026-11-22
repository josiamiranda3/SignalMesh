/**
 * Keyword rules.
 *
 * Shared by the creation form and the edit modal through `KeywordEditor`, and
 * kept in a plain `.ts` module (no JSX) so the rules can be unit-tested directly
 * under `node --test`, which cannot load `.tsx`.
 *
 * These are product rules, so there is exactly one copy:
 *  - how a pasted entry is split into terms,
 *  - how duplicates are folded,
 *  - the limits, which mirror `shared/schemas.ts`.
 */

/** Maximum number of keywords. Mirrors `keywordsSchema` in shared/schemas.ts. */
export const MAX_KEYWORDS = 20
/** Maximum length of a single keyword. Mirrors `keywordItem` in shared/schemas.ts. */
export const MAX_KEYWORD_LENGTH = 64

/**
 * Split one entry into individual terms.
 *
 * The field asks for one term per Enter press, but users paste lists and type
 * separators anyway. Treating `"fraude; machine learning"` as a *single* chip
 * stored a long "keyword" that polluted the search query and could trip the
 * 64-character limit as one item. Every separator a user plausibly types is
 * honoured, and each piece becomes its own chip.
 */
export function splitKeywords(raw: string): string[] {
  return raw
    .split(/[;,\n\t]+/)
    .map((part) => part.trim())
    .filter(Boolean)
}

/** Case-insensitive de-duplication, preserving the first spelling seen. */
export function dedupeKeywords(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

export interface KeywordMergeResult {
  /** The list after applying the entry (may equal the input). */
  next: string[]
  /** A user-facing problem, or null when the entry was fully accepted. */
  problem: string | null
}

/**
 * Merge a raw entry into an existing list.
 *
 * Pure, so the modal and the creation form apply identical semantics: split,
 * enforce the per-term length, enforce the list limit, drop case-insensitive
 * duplicates.
 */
export function mergeKeywords(existing: string[], raw: string): KeywordMergeResult {
  const parts = splitKeywords(raw)
  if (parts.length === 0) return { next: existing, problem: null }

  const next = [...existing]
  let problem: string | null = null

  for (const part of parts) {
    if (next.length >= MAX_KEYWORDS) {
      problem = `Máximo de ${MAX_KEYWORDS} palavras-chave. Remova algum termo para adicionar outro.`
      break
    }
    if (part.length > MAX_KEYWORD_LENGTH) {
      problem = `"${part.slice(0, 24)}…" tem ${part.length} caracteres. Cada palavra-chave deve ter no máximo ${MAX_KEYWORD_LENGTH}.`
      continue
    }
    if (!next.some((keyword) => keyword.toLowerCase() === part.toLowerCase())) next.push(part)
  }

  return { next, problem }
}

/**
 * Apply an in-place rename.
 *
 * Returns the new list, or `null` when the edit must be refused (empty after
 * trim is handled by the caller as a removal; a duplicate name is refused so
 * the same term cannot appear twice).
 */
export function renameKeyword(values: string[], index: number, raw: string): string[] | null {
  const trimmed = raw.trim()
  if (trimmed.length > MAX_KEYWORD_LENGTH) return null
  const clashes = values.some(
    (keyword, i) => i !== index && keyword.toLowerCase() === trimmed.toLowerCase(),
  )
  if (clashes) return null
  return values.map((keyword, i) => (i === index ? trimmed : keyword))
}
