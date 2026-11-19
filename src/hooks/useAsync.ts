import { useCallback, useEffect, useState } from 'react'

/**
 * Async data hook.
 *
 * Covers the three states every screen must render (loading, error, empty) plus
 * a refetch that keeps the previous data visible during a refresh, so a table
 * does not collapse into a skeleton on every filter change.
 *
 * `loader` is captured inside the effect (not stored in a ref during render),
 * and the effect depends only on the explicit `deps` the caller supplies plus
 * the reload counter — so the hook never re-runs because an inline arrow
 * function identity changed.
 */
export interface AsyncState<T> {
  data: T | null
  error: Error | null
  loading: boolean
  refreshing: boolean
  reload: () => void
}

export function useAsync<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: readonly unknown[],
): AsyncState<T> {
  const [state, setState] = useState<{
    data: T | null
    error: Error | null
    loading: boolean
    refreshing: boolean
    loadedOnce: boolean
  }>({ data: null, error: null, loading: true, refreshing: false, loadedOnce: false })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    let active = true

    // `loading` / `refreshing` are derived from whether a result already exists,
    // so they are set only in the settled callbacks — never synchronously in the
    // effect body, which would cause a cascading render on every deps change.
    loader(controller.signal)
      .then((result) => {
        if (!active) return
        setState({ data: result, error: null, loading: false, refreshing: false, loadedOnce: true })
      })
      .catch((caught: unknown) => {
        if (!active) return
        if ((caught as Error).name === 'AbortError') return
        setState((current) => ({
          ...current,
          error: caught instanceof Error ? caught : new Error(String(caught)),
          loading: false,
          refreshing: false,
        }))
      })

    return () => {
      active = false
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  const reload = useCallback(() => {
    setState((current) => ({ ...current, loading: !current.loadedOnce, refreshing: current.loadedOnce }))
    setNonce((value) => value + 1)
  }, [])

  return { ...state, reload }
}

/** Debounce a value (search inputs, filter typing). */
export function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])
  return debounced
}

/**
 * Media query hook.
 *
 * The initial value is read during render (this module is client-only), and the
 * effect only subscribes to changes — it never calls setState synchronously,
 * which would cause a cascading render.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)

  useEffect(() => {
    const media = window.matchMedia(query)
    const listener = (event: MediaQueryListEvent) => setMatches(event.matches)
    media.addEventListener('change', listener)
    return () => media.removeEventListener('change', listener)
  }, [query])

  return matches
}
