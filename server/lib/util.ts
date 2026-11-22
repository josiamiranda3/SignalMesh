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

/** Query parameters that identify a campaign, not a different resource. */
const TRACKING_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
  'ref',
]

/**
 * URL normalisation used for duplicate detection.
 *
 * Lives here, next to `extractDomain`, because it is a pure string transform
 * with no storage dependency. It used to live in `repositories/sqlite.ts`,
 * whose module-level `node:sqlite` import then dragged the whole SQLite
 * adapter into the Worker bundle: `research.ts`, `evidence.ts` and the records
 * adapter all need this function, and every one of them runs in production.
 * A pure helper must not be able to pull a Node-only runtime into the edge
 * build, so the dependency points away from the adapter, never toward it.
 *
 * The normalisation drops the fragment and campaign parameters, lowercases the
 * host and strips a trailing slash. Two URLs that differ only in those respects
 * address the same content and must collide on `uniqueOn`.
 */
export function normalizeUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.hash = ''
    for (const param of TRACKING_PARAMS) url.searchParams.delete(param)
    const path = url.pathname.replace(/\/+$/, '') || '/'
    return `${url.protocol}//${url.host.toLowerCase()}${path}${url.search}`
  } catch {
    return raw.trim().toLowerCase()
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
