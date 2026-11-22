/**
 * Map a validation path onto the key a form reads.
 *
 * Pure and DOM-free on purpose: it is imported by the browser client *and* by
 * server-side tests, so it must not pull `document`/`window` into the Node
 * typecheck. (`src/lib/api.ts` does reference the DOM, so a helper needed by
 * both lives here instead.)
 */

/**
 * Collapse zod issue paths onto the keys a form actually reads.
 *
 * Zod reports an invalid array *element* as `['keywords', 0]`, which
 * `path.join('.')` renders as `keywords.0`. A form holding one message per
 * field looks up `errors['keywords']` and therefore finds nothing — the field
 * stays unmarked and the user only sees the generic banner. Folding the index
 * away is what makes "the 3rd keyword is too long" show up on the keyword field.
 *
 * Nested object paths keep their full key (`source.url`), because those *are*
 * separate inputs.
 */
export function fieldErrorKey(path: ReadonlyArray<PropertyKey> | string): string {
  // Accept the wire form too ("keywords.0"), so both zod issues and an API
  // error detail resolve through the same rule.
  const parts: ReadonlyArray<PropertyKey> = typeof path === 'string' ? path.split('.') : path
  const kept: string[] = []
  for (const part of parts) {
    // Numeric segments are array indices, not field names.
    if (typeof part === 'number') continue
    if (typeof part === 'string' && /^\d+$/.test(part)) continue
    kept.push(String(part))
  }
  return kept.join('.') || 'form'
}
