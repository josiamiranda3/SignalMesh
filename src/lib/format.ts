import { getActiveLocale, getActiveIntlLocale } from './active'

/**
 * Human-facing formatting helpers.
 *
 * Every date and number renders in the locale the user selected. The cached
 * `Intl` formatters are keyed by locale, so switching language re-formats
 * instantly without paying to construct a formatter per call.
 *
 * The active locale is read from a module-level binding (`./active`) rather than
 * from React context, because these helpers are called from plain functions and
 * from components outside the provider tree. `I18nProvider` keeps that binding
 * in sync with its state, so a language change re-renders and re-formats.
 */

const dateFormatters = new Map<string, Intl.DateTimeFormat>()
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>()
const shortDateFormatters = new Map<string, Intl.DateTimeFormat>()
const numberFormatters = new Map<string, Intl.NumberFormat>()
const percentFormatters = new Map<string, Intl.NumberFormat>()

function dateFormatter(locale: string): Intl.DateTimeFormat {
  let formatter = dateFormatters.get(locale)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric' })
    dateFormatters.set(locale, formatter)
  }
  return formatter
}

function dateTimeFormatter(locale: string): Intl.DateTimeFormat {
  let formatter = dateTimeFormatters.get(locale)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
    dateTimeFormatters.set(locale, formatter)
  }
  return formatter
}

function shortDateFormatter(locale: string): Intl.DateTimeFormat {
  let formatter = shortDateFormatters.get(locale)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { day: '2-digit', month: '2-digit' })
    shortDateFormatters.set(locale, formatter)
  }
  return formatter
}

function numberFormatter(locale: string): Intl.NumberFormat {
  let formatter = numberFormatters.get(locale)
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale)
    numberFormatters.set(locale, formatter)
  }
  return formatter
}

function percentFormatter(locale: string): Intl.NumberFormat {
  let formatter = percentFormatters.get(locale)
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 })
    percentFormatters.set(locale, formatter)
  }
  return formatter
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : dateFormatter(getActiveIntlLocale()).format(date)
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : dateTimeFormatter(getActiveIntlLocale()).format(date)
}

export function formatShortDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : shortDateFormatter(getActiveIntlLocale()).format(date)
}

export function formatNumber(value: number): string {
  return numberFormatter(getActiveIntlLocale()).format(value)
}

export function formatPercent(value: number): string {
  return percentFormatter(getActiveIntlLocale()).format(value)
}

/**
 * Relative time ("3 min ago" / "há 3 min").
 *
 * `Intl.RelativeTimeFormat` supplies the wording so the phrase is never
 * hand-translated, and the plural rules come from the locale itself.
 */
export function formatRelative(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  const locale = getActiveIntlLocale()
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' })
  const seconds = Math.round((Date.now() - date.getTime()) / 1000)
  if (seconds < 45) return relative.format(0, 'second')
  if (seconds < 3600) return relative.format(-Math.round(seconds / 60), 'minute')
  if (seconds < 86400) return relative.format(-Math.round(seconds / 3600), 'hour')
  if (seconds < 2_592_000) return relative.format(-Math.round(seconds / 86400), 'day')
  return formatDate(value)
}

/** Seconds until an ISO instant, for quota reset copy. */
export function untilReset(resetsAt: string): string {
  const ms = new Date(resetsAt).getTime() - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return getActiveLocale() === 'pt-BR' ? 'em instantes' : 'in moments'
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  if (hours > 0) {
    return getActiveLocale() === 'pt-BR' ? `em ${hours}h ${minutes}min` : `in ${hours}h ${minutes}min`
  }
  return getActiveLocale() === 'pt-BR' ? `em ${minutes}min` : `in ${minutes}min`
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Only http(s) links may be rendered as anchors. */
export function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    return null
  }
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max).trimEnd()}…`
}

export function pluralize(count: number, singular: string, plural: string): string {
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase()
}
