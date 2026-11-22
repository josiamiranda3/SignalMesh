/**
 * Supported locales.
 *
 * `en` is the product default: a new user, and any unauthenticated visitor,
 * starts in English. `pt-BR` is the alternative.
 */

export const LOCALES = ['en', 'pt-BR'] as const

export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'en'

/** Human labels for the language selector, each written in its own language. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  'pt-BR': 'Português (Brasil)',
}

/** Short labels for compact controls. */
export const LOCALE_SHORT: Record<Locale, string> = {
  en: 'EN',
  'pt-BR': 'PT',
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

/**
 * Map a locale to the BCP-47 tag handed to `Intl`.
 *
 * Identical to the locale id here, but kept as a function so date/number
 * formatting and message lookup have one place to diverge if that is ever
 * needed.
 */
export function intlLocale(locale: Locale): string {
  return locale
}
