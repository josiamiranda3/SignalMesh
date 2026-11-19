/**
 * Minimal .env loader for the local runtime.
 *
 * Node can read `.env` with --env-file, but the dev script needs to work the
 * same way whether or not a file exists, and must never overwrite variables
 * that were already set in the real environment (CI, hosting panel, shell).
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function loadEnvFile(file = '.env'): void {
  const path = resolve(file)
  if (!existsSync(path)) return

  const content = readFileSync(path, 'utf8')
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const separator = line.indexOf('=')
    if (separator === -1) continue

    const key = line.slice(0, separator).trim()
    if (!key || process.env[key] !== undefined) continue

    let value = line.slice(separator + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}
