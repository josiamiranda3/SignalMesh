import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const appDir = fileURLToPath(new URL('.', import.meta.url))

/**
 * Vite configuration.
 *
 * The build has two modes, decided by whether the app has been registered on the
 * platform yet:
 *
 *  - **Platform build** — `wrangler.toml` carries a real `DEEPSPACE_APP_ID`
 *    (minted by `npx deepspace app init`). The Cloudflare plugin and
 *    `deepspaceBuild()` run, producing the SPA *and* `worker.ts`, with the app id
 *    injected into the browser bundle.
 *  - **Local build** — no registered id. Only the SPA is built, and it talks to
 *    the Node runtime through `/api/*`.
 *
 * The distinction is not a convenience. `deepspaceBuild()` deliberately refuses
 * to build when the id is the `__APP_ID__` placeholder, because the browser keys
 * its RecordRooms to that id: shipping a wrong or empty one would point the
 * client at another app's data. Registering mints the id server-side and claims
 * the app's source origin permanently, so it is a deliberate, authorized step —
 * never something a build should do implicitly.
 */

const APP_ID_PLACEHOLDER = '__APP_ID__'

/** Read `DEEPSPACE_APP_ID` from wrangler.toml without loading a TOML parser. */
function readAppId(): string | null {
  let source: string
  try {
    source = readFileSync(fileURLToPath(new URL('./wrangler.toml', import.meta.url)), 'utf8')
  } catch {
    return null
  }
  const match = /^\s*DEEPSPACE_APP_ID\s*=\s*"([^"]*)"/m.exec(source)
  const value = match?.[1]?.trim()
  if (!value || value === APP_ID_PLACEHOLDER) return null
  // Platform ids look like `app_<ULID>`; anything else is a hand-written value
  // the platform would reject at deploy time.
  if (!/^app_[0-9A-Za-z]{10,}$/.test(value)) return null
  return value
}

export default defineConfig(async () => {
  const plugins: PluginOption[] = [react(), tailwindcss()]
  const appId = readAppId()

  if (appId) {
    plugins.push(...(await loadPlatformPlugins()))
  } else if (process.env.SIGNALMESS_REQUIRE_PLATFORM === '1') {
    throw new Error(
      'SIGNALMESS_REQUIRE_PLATFORM=1 but wrangler.toml has no registered DEEPSPACE_APP_ID. ' +
        'Run `npx deepspace app init` (this registers the app) before building for the platform.',
    )
  }

  return {
    root: appDir,
    plugins,
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
      chunkSizeWarningLimit: 900,
    },
    server: {
      port: 5273,
      strictPort: true,
      // Used by `npm run dev:web`, the local Node workflow. Under
      // `deepspace dev start` the platform serves the SPA and the worker from
      // one origin, so no proxy is needed there.
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:8787',
          changeOrigin: false,
        },
      },
    },
  }
})

/**
 * Load the platform plugins.
 *
 * Called only when a registered app id exists. The SDK is a production
 * dependency, so a failure to load it here is a real error and propagates.
 */
async function loadPlatformPlugins(): Promise<PluginOption[]> {
  const buildMod = (await import('deepspace/build')) as {
    deepspaceBuild: (options: { appDir: string }) => PluginOption
  }
  const cfMod = (await import('@cloudflare/vite-plugin')) as {
    cloudflare: (options?: { inspectorPort?: number | false }) => PluginOption
  }

  return [
    // The plugin otherwise probes every network interface for a free inspector
    // port, which restricted environments reject. Inspector debugging is
    // optional; disabling the probe keeps startup deterministic.
    cfMod.cloudflare({ inspectorPort: false }),
    buildMod.deepspaceBuild({ appDir }),
  ]
}
