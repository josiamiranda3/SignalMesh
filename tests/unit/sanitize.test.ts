import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
// The pure module, not `repositories/sqlite.ts`: this suite runs under Node but
// must not depend on the SQLite adapter to test a string transform. The adapter
// re-exports the same function, and `normalizeUrl is shared` below pins that.
import { normalizeUrl } from '../../server/lib/util.ts'
import { normalizeUrl as normalizeUrlFromAdapter } from '../../server/repositories/sqlite.ts'
import { extractDomain, excerpt, isSafeHttpUrl, stripHtml, untilNextMidnight } from '../../server/lib/sanitize.ts'

describe('normalizeUrl (duplicate detection)', () => {
  it('is the same implementation the SQLite adapter re-exports', () => {
    // One implementation, two import paths: a divergence would silently change
    // duplicate detection between runtimes.
    assert.equal(normalizeUrl, normalizeUrlFromAdapter)
  })

  it('ignores tracking parameters', () => {
    assert.equal(
      normalizeUrl('https://example.org/a?utm_source=news&utm_medium=email&gclid=1'),
      normalizeUrl('https://example.org/a'),
    )
  })

  it('ignores a trailing slash', () => {
    assert.equal(normalizeUrl('https://example.org/path/'), normalizeUrl('https://example.org/path'))
  })

  it('ignores the fragment', () => {
    assert.equal(normalizeUrl('https://example.org/path#section'), normalizeUrl('https://example.org/path'))
  })

  it('lowercases the host but preserves a meaningful query', () => {
    assert.equal(normalizeUrl('https://EXAMPLE.org/search?id=7'), 'https://example.org/search?id=7')
  })

  it('treats different paths as different sources', () => {
    assert.notEqual(normalizeUrl('https://example.org/a'), normalizeUrl('https://example.org/b'))
  })

  it('keeps http and https distinct', () => {
    assert.notEqual(normalizeUrl('http://example.org/a'), normalizeUrl('https://example.org/a'))
  })
})

describe('isSafeHttpUrl', () => {
  it('accepts http and https', () => {
    assert.equal(isSafeHttpUrl('https://example.org'), true)
    assert.equal(isSafeHttpUrl('http://example.org'), true)
  })

  it('rejects dangerous schemes', () => {
    for (const dangerous of [
      'javascript:alert(1)',
      'data:text/html;base64,PHNjcmlwdD4=',
      'file:///C:/Windows/System32',
      'vbscript:msgbox(1)',
      'ftp://example.org',
    ]) {
      assert.equal(isSafeHttpUrl(dangerous), false, `deveria rejeitar ${dangerous}`)
    }
  })

  it('rejects malformed values', () => {
    assert.equal(isSafeHttpUrl('nao é url'), false)
    assert.equal(isSafeHttpUrl(''), false)
  })
})

describe('stripHtml', () => {
  it('removes scripts and styles entirely', () => {
    const output = stripHtml('<p>Texto</p><script>alert("x")</script><style>body{}</style>')
    assert.ok(output.includes('Texto'))
    assert.ok(!output.includes('alert'))
    assert.ok(!output.includes('body{}'))
  })

  it('decodes common entities', () => {
    assert.equal(stripHtml('a &amp; b &lt;c&gt;'), 'a & b <c>')
  })
})

describe('extractDomain', () => {
  it('strips www and lowercases', () => {
    assert.equal(extractDomain('https://WWW.Example.ORG/path'), 'example.org')
  })

  it('returns empty for invalid input', () => {
    assert.equal(extractDomain('not a url'), '')
  })
})

describe('excerpt', () => {
  it('returns short text unchanged', () => {
    assert.equal(excerpt('curto', 100), 'curto')
  })

  it('cuts on a word boundary and appends an ellipsis', () => {
    const result = excerpt('palavra '.repeat(50), 40)
    assert.ok(result.endsWith('…'))
    assert.ok(result.length <= 41)
  })
})

describe('untilNextMidnight', () => {
  it('returns an instant within the next 24 hours', () => {
    const now = new Date('2025-06-01T23:59:00.000Z')
    const next = untilNextMidnight(now)
    const delta = next.getTime() - now.getTime()
    assert.ok(delta > 0 && delta <= 86_400_000)
  })
})
