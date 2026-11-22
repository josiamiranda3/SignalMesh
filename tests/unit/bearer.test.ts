import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  bearerFor,
  isTokenExempt,
  resetTokenProviderState,
  setTokenProvider,
} from '../../src/lib/bearer.ts'

/**
 * Bearer token plumbing (DOM-free core).
 *
 * `src/lib/api.ts` attaches the result of `bearerFor()` to outgoing requests; the
 * decision logic lives here so it can be exercised without a DOM. The HTTP-level
 * behaviour is covered in `tests/unit/api-bearer.test.ts`.
 *
 * ## What these tests protect
 *
 *  - the exchange endpoint never consults the provider (no recursion);
 *  - a failed exchange is not retried per request (no loop);
 *  - concurrent requests do not stack exchanges;
 *  - the token is handed out only when one exists.
 */

beforeEach(() => {
  setTokenProvider(null)
})

describe('token exemption', () => {
  it('exempts the exchange endpoint and credential lifecycle paths', () => {
    for (const path of [
      '/api/auth/token',
      '/api/auth/login',
      '/api/auth/logout',
      '/api/auth/config',
    ]) {
      assert.equal(isTokenExempt(path), true, path)
    }
  })

  it('treats a query string on an exempt path as exempt', () => {
    assert.equal(isTokenExempt('/api/auth/token?x=1'), true)
  })

  it('does not exempt ordinary API paths', () => {
    for (const path of [
      '/api/auth/me',
      '/api/investigations',
      '/api/investigations/1/export',
      '/api/history',
    ]) {
      assert.equal(isTokenExempt(path), false, path)
    }
  })

  it('does not exempt a path that merely starts with an exempt name', () => {
    // `/api/auth/tokenizer` is not the exchange endpoint.
    assert.equal(isTokenExempt('/api/auth/tokenizer'), false)
  })
})

describe('bearerFor', () => {
  it('returns null when no provider is registered', async () => {
    assert.equal(await bearerFor('/api/investigations'), null)
  })

  it('returns the token the provider yields', async () => {
    setTokenProvider(async () => 'header.payload.signature')
    assert.equal(await bearerFor('/api/investigations'), 'header.payload.signature')
  })

  it('does not consult the provider for an exempt path', async () => {
    let calls = 0
    setTokenProvider(async () => {
      calls += 1
      return 'x.y.z'
    })
    assert.equal(await bearerFor('/api/auth/token'), null)
    assert.equal(calls, 0)
  })

  it('treats a null token as a failed exchange and stops retrying', async () => {
    let calls = 0
    setTokenProvider(async () => {
      calls += 1
      return null
    })

    assert.equal(await bearerFor('/api/a'), null)
    assert.equal(await bearerFor('/api/b'), null)
    assert.equal(calls, 1, 'a failed exchange must not be retried per request')
  })

  it('treats a thrown provider as unavailable', async () => {
    setTokenProvider(async () => {
      throw new Error('sdk unavailable')
    })
    assert.equal(await bearerFor('/api/a'), null)
  })

  it('retries after an explicit reset', async () => {
    let calls = 0
    setTokenProvider(async () => {
      calls += 1
      return calls === 1 ? null : 'x.y.z'
    })

    assert.equal(await bearerFor('/api/a'), null)
    assert.equal(calls, 1)

    resetTokenProviderState()

    assert.equal(await bearerFor('/api/b'), 'x.y.z')
    assert.equal(calls, 2)
  })

  it('never runs two exchanges concurrently', async () => {
    let inFlight = 0
    let peak = 0
    setTokenProvider(async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 15))
      inFlight -= 1
      return 'x.y.z'
    })

    const results = await Promise.all([
      bearerFor('/api/a'),
      bearerFor('/api/b'),
      bearerFor('/api/c'),
    ])

    assert.equal(peak, 1, 'exchanges must not stack')
    // The first resolves; the others saw `resolving` and degraded to null.
    assert.equal(results.filter((r) => r === 'x.y.z').length, 1)
  })

  it('a new provider clears the failed state', async () => {
    setTokenProvider(async () => null)
    await bearerFor('/api/a')

    setTokenProvider(async () => 'fresh.token.value')
    assert.equal(await bearerFor('/api/b'), 'fresh.token.value')
  })
})
