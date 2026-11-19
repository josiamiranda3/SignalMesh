/**
 * Small, dependency-free helpers used across the server.
 */

let counter = 0

/**
 * Sortable, collision-resistant id. The timestamp prefix keeps ids ordered by
 * creation time in logs and exports; the random suffix prevents guessing.
 */
export function createId(prefix: string): string {
  counter = (counter + 1) % 0xffff
  const time = Date.now().toString(36).padStart(9, '0')
  const random = Math.floor(Math.random() * 0xffffffff).toString(36).padStart(7, '0')
  const seq = counter.toString(36).padStart(4, '0')
  return `${prefix}_${time}${seq}${random}`
}

export function nowIso(): string {
  return new Date().toISOString()
}

/** Start of the current UTC day, used for daily quota windows. */
export function startOfUtcDay(reference = new Date()): Date {
  return new Date(Date.UTC(reference.getUTCFullYear(), reference.getUTCMonth(), reference.getUTCDate()))
}

export function nextUtcMidnight(reference = new Date()): Date {
  const start = startOfUtcDay(reference)
  return new Date(start.getTime() + 86_400_000)
}

/** Extract a registrable-ish domain label for display and grouping. */
export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase()
  } catch {
    return ''
  }
}

/** Collapse whitespace and cut on a word boundary where possible. */
export function excerpt(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  const slice = normalized.slice(0, maxLength)
  const lastSpace = slice.lastIndexOf(' ')
  return `${(lastSpace > maxLength * 0.6 ? slice.slice(0, lastSpace) : slice).trimEnd()}…`
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Only http(s) URLs may be opened from the UI. This blocks javascript:, data:
 * and file: payloads that could arrive inside provider metadata.
 */
export function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/** Basic HTML tag stripping for provider text that will be shown as plain text. */
export function stripHtml(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/** Next UTC midnight, exposed so tests can assert the quota window boundary. */
export function untilNextMidnight(reference = new Date()): Date {
  const start = startOfUtcDay(reference)
  return new Date(start.getTime() + 86_400_000)
}
