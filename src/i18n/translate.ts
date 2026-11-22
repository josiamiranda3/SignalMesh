import en from './en.json'
import ptBR from './pt-BR.json'
import { DEFAULT_LOCALE } from './locales'
import { getActiveLocale } from '@/lib/active'

/**
 * Translation outside React.
 *
 * Some user-facing strings are produced by plain functions rather than by a
 * component: option lists, toast text, export labels. They cannot call
 * `useI18n`. This module exposes the same lookup bound to the *active* locale,
 * which the provider keeps in sync, so those call sites stay hook-free without
 * hardcoding a language.
 *
 * Components should prefer `useI18n().t`: it re-renders on change. These
 * helpers are for places that are re-invoked anyway (a render of the parent, a
 * user action).
 */

export type Messages = typeof en

type Leaves<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${K}`
    : T[K] extends Record<string, unknown>
      ? Leaves<T[K], `${Prefix}${K}.`>
      : never
}[keyof T & string]

/** Every valid dotted key, derived from the English catalog. */
export type TranslationKey = Leaves<Messages>

/** Values accepted for interpolation. */
export type InterpolationValues = Record<string, string | number>

const CATALOGS: Record<string, Messages> = {
  en,
  'pt-BR': ptBR as Messages,
}

function resolve(catalog: Messages, key: string): string | undefined {
  let node: unknown = catalog
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return typeof node === 'string' ? node : undefined
}

function interpolate(template: string, values?: Record<string, string | number>): string {
  if (!values) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = values[name]
    return value === undefined ? match : String(value)
  })
}

/** Translate against the currently active locale. */
export function translate(key: TranslationKey, values?: InterpolationValues): string {
  const locale = getActiveLocale()
  const text = resolve(CATALOGS[locale] ?? CATALOGS[DEFAULT_LOCALE]!, key)
    ?? resolve(CATALOGS[DEFAULT_LOCALE]!, key)
    ?? key
  return interpolate(text, values)
}

/** The raw catalogs, for tests that check key parity. */
export const catalogs = CATALOGS
