import { DEFAULT_LOCALE, intlLocale, type Locale } from '../i18n/locales'

/**
 * Active locale, readable outside React.
 *
 * Formatters in `./format` are called from plain functions and from module
 * scope, not only inside components, so they cannot read React context. This
 * module holds the single source of truth for "what language is the app in":
 * `I18nProvider` writes it on every change and re-renders the tree, so anything
 * that formats a date during render sees the value that matches the copy on
 * screen.
 *
 * It is deliberately mutable state rather than a React ref so non-React callers
 * (export builders, error mapping) can use it too.
 */

let activeLocale: Locale = DEFAULT_LOCALE

export function setActiveLocale(locale: Locale): void {
  activeLocale = locale
}

export function getActiveLocale(): Locale {
  return activeLocale
}

export function getActiveIntlLocale(): string {
  return intlLocale(activeLocale)
}
