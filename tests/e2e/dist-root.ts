import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Locate the built SPA.
 *
 * The build output directory depends on whether the app is registered:
 *
 *  - **Unregistered** — `vite.config.ts` does not load the platform plugins, so
 *    Vite writes the SPA to `dist/`.
 *  - **Registered** — `deepspaceBuild()` runs, and the platform layout is
 *    `dist/client/` (assets that ship) plus `dist/server/` (the Worker), because
 *    the deploy needs to tell them apart.
 *
 * Every browser-driven test harness serves this directory over HTTP. Hardcoding
 * `./dist` silently breaks the whole suite the moment the app is registered —
 * which is exactly what happened after the first deploy, and it looks like a page
 * failure rather than a path failure.
 *
 * Returns the directory containing `index.html`, or `./dist` as a last resort so
 * the failure surfaces as a readable 404 instead of a crash here.
 */
export function spaRoot(): { root: string; index: string } {
  const candidates = [join(process.cwd(), 'dist/client'), join(process.cwd(), 'dist')]
  for (const root of candidates) {
    const index = join(root, 'index.html')
    if (existsSync(index)) return { root, index }
  }
  const fallback = candidates[0]!
  return { root: fallback, index: join(fallback, 'index.html') }
}
