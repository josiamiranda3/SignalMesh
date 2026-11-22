import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { getActiveLocale, setActiveLocale } from '../lib/active'
import { DEFAULT_LOCALE, isLocale, type Locale } from './locales'
import { catalogs, type InterpolationValues, type TranslationKey } from './translate'

export type { TranslationKey, InterpolationValues }

/**
 * Runtime translation.
 *
 * ## Why no dependency
 *
 * The project already ships zod, React and Hono; adding `i18next` + plugins for
 * two locales and a flat key space would add ~40 kB to the bundle for
 * `Intl`-based formatting that the platform already provides natively. The whole
 * mechanism is a lookup, an interpolation and an `Intl` cache, so it lives here.
 *
 * ## Shape of a catalog
 *
 * `en.json` is the *source of truth*: its type defines every valid key, so a
 * missing key is a TypeScript error, not a runtime fallback. `pt-BR.json` is
 * typed as the same shape, which is what guarantees the two files cannot drift.
 *
 * ## Lookup
 *
 * Keys are dotted paths (`nav.dashboard`). Values may contain `{placeholders}`.
 * Interpolation escapes nothing — every interpolation site passes either a
 * number, a formatted date, or a user name that React already escapes when
 * rendering — so no HTML is ever injected.
 */

/** Resolve a dotted key against a catalog. */
function resolve(catalog: Record<string, unknown>, key: string): string | undefined {
  let node: unknown = catalog
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return typeof node === 'string' ? node : undefined
}

/** Replace `{name}` with the supplied value. */
function interpolate(template: string, values?: InterpolationValues): string {
  if (!values) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = values[name]
    return value === undefined ? match : String(value)
  })
}

// ---------------------------------------------------------------------------
// Preference persistence
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'signalmess.locale'

/**
 * Read the stored preference.
 *
 * The value survives a reload (localStorage) and a new session in the same
 * browser. It is deliberately *not* written to the server: the language is a
 * presentation preference, and storing it would mean touching the settings
 * contract and the persistence layer, which this change must not do.
 */
function readStoredLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY)
    if (isLocale(stored)) return stored
  } catch {
    // Private mode or a blocked storage API: fall through to the default.
  }
  return DEFAULT_LOCALE
}

function writeStoredLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, locale)
  } catch {
    // Non-fatal: the session keeps the in-memory value.
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface I18nValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  /** Translate a key, optionally interpolating values. */
  t: (key: TranslationKey, values?: InterpolationValues) => string
  /** Locale tag for `Intl` date/number formatting. */
  intlLocale: string
}

const I18nContext = createContext<I18nValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => readStoredLocale())

  // Keep <html lang> and the module-level locale in sync, so screen readers, the
  // browser, and the non-React formatters all agree with the rendered copy.
  useEffect(() => {
    document.documentElement.lang = locale
    setActiveLocale(locale)
  }, [locale])

  // Apply the initial value during the first render as well, so a formatter
  // called before the effect runs already has the right locale.
  if (getActiveLocale() !== locale) setActiveLocale(locale)

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    writeStoredLocale(next)
  }, [])

  const t = useCallback(
    (key: TranslationKey, values?: InterpolationValues) => {
      // English is the reference catalog: a key present there is authoritative.
      const text = resolve(catalogs[locale] as Record<string, unknown>, key)
        ?? resolve(catalogs[DEFAULT_LOCALE] as Record<string, unknown>, key)
        ?? key
      return interpolate(text, values)
    },
    [locale],
  )

  const value = useMemo<I18nValue>(
    () => ({ locale, setLocale, t, intlLocale: locale }),
    [locale, setLocale, t],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  const context = useContext(I18nContext)
  if (!context) throw new Error('useI18n must be used inside <I18nProvider>')
  return context
}

/** Convenience: just the translate function. */
export function useTranslation(): I18nValue['t'] {
  return useI18n().t
}

/** Convenience: the active locale and its setter. */
export function useLocale(): { locale: Locale; setLocale: (locale: Locale) => void } {
  const { locale, setLocale } = useI18n()
  return { locale, setLocale }
}
