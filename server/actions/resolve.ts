import { lookupOwn } from 'deepspace/worker'
import type { ActionHandler } from './types.ts'

/**
 * Safe action resolution.
 *
 * ## The hazard
 *
 * An action name arrives from the URL (`/api/actions/:name`). Resolving it with
 * `actions[name]` walks the **prototype chain** as well as the object's own
 * properties, because the registry is a plain object literal. `constructor`,
 * `hasOwnProperty`, `toString` and `valueOf` are all reachable that way, and each
 * of them is a function.
 *
 * The SDK names this exact hole in its own migration guidance
 * (`2026-11-route-param-lookups`): *"replace `actions[name]` with
 * `lookupOwn(actions, name)` from 'deepspace/worker': plain indexing resolves
 * `constructor`, which returns the handler argument, env secrets included, as
 * the response."*
 *
 * ## Severity in this codebase, stated precisely
 *
 * With `ALLOWED_ACTIONS.has(name)` evaluated **first**, the old lookup was not
 * directly reachable: `constructor` was refused by the allowlist before the
 * indexing ran. The defect was latent — it depended on two lists staying in
 * sync, and the day the registry was widened or those lines were reordered, an
 * inherited function became callable. The SDK's advisory describes the general
 * pattern, not this file's execution order; both deserve the same fix.
 *
 * ## The strategy
 *
 * `lookupOwn` from the platform SDK — the official helper, not a local
 * reimplementation — followed by the allowlist. Using the SDK's version means
 * this cannot drift from the platform's own definition of "own property".
 */

/**
 * Resolve an action by name.
 *
 * Two independent gates, in this order:
 *
 *  1. `lookupOwn` — returns only a value stored as an **own** property of the
 *     registry. `__proto__`, `constructor` and every inherited method resolve to
 *     `undefined`.
 *  2. `ALLOWED_ACTIONS` — the reachable surface is declared explicitly, so
 *     widening the registry cannot silently widen what a URL can invoke.
 *
 * The allowlist is a `Set`, so its `has` is not an object lookup either.
 */
export function lookupOwnAction(
  registry: Readonly<Record<string, ActionHandler>>,
  name: string,
  allowed: ReadonlySet<string>,
): ActionHandler | undefined {
  // An empty or whitespace name is not a key at all.
  if (typeof name !== 'string' || name.trim() === '') return undefined

  // Own property only. This is what rejects `__proto__`, `constructor`, etc.
  const candidate = lookupOwn(registry as Record<string, ActionHandler>, name)

  // An own property that is not callable is not an action.
  if (typeof candidate !== 'function') return undefined

  // Declared reachable?
  if (!allowed.has(name)) return undefined

  return candidate
}
