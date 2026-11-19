/**
 * Re-export of the small pure helpers under a stable name for tests and
 * services that predate the `util` module split.
 */
export {
  extractDomain,
  excerpt,
  isSafeHttpUrl,
  stripHtml,
  truncate,
  untilNextMidnight,
} from './util.ts'
