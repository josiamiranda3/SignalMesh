
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import {
  bearerFor,
  isTokenExempt,
  resetTokenProviderState,
  setTokenProvider,
} from '../../src/lib/bearer.ts'

/**
 * Bearer token plumbing tests.
 *
 * These tests verify:
 *
 * - token exemption rules;
 * - successful token retrieval;
 * - failed exchange handling;
 * - retry after explicit reset;
 * - shared token exchange between concurrent requests;
 * - provider replacement while an exchange is running.
 */

beforeEach(() => {
  setTokenProvider(null)
})

describe('token exemption', () => {
  it('exempts token and credential lifecycle endpoints', () => {
    for (const path of [
      '/api/auth/token',
      '/api/auth/login',
      '/api/auth/logout',
      '/api/auth/config',
    ]) {
      assert.equal(isTokenExempt(path), true, path)
    }
  })

  it('treats query strings on exempt paths as exempt', () => {
    assert.equal(isTokenExempt('/api/auth/token?x=1'), true)
  })

  it('does not exempt ordinary API paths', () => {
    for (const path of [
      '/api/auth/me',
      '/api/investigations',
      '/api/investigations/1/export',
      '/api/history',
      '/api/dashboard',
      '/api/validations',
    ]) {
      assert.equal(isTokenExempt(path), false, path)
    }
  })

  it('does not exempt paths that merely start with an exempt name', () => {
    assert.equal(isTokenExempt('/api/auth/tokenizer'), false)
    assert.equal(isTokenExempt('/api/auth/logout-history'), false)
  })
})

describe('bearerFor', () => {
  it('returns null when no provider is registered', async () => {
    assert.equal(await bearerFor('/api/investigations'), null)
  })

  it('returns the token provided by the SDK', async () => {
    setTokenProvider(async () => 'header.payload.signature')

    assert.equal(
      await bearerFor('/api/investigations'),
      'header.payload.signature',
    )
  })

  it('does not consult the provider for exempt paths', async () => {
    let calls = 0

    setTokenProvider(async () => {
      calls += 1
      return 'x.y.z'
    })

    assert.equal(await bearerFor('/api/auth/token'), null)
    assert.equal(await bearerFor('/api/auth/logout'), null)
    assert.equal(calls, 0)
  })

  it('treats a null token as a failed exchange', async () => {
    let calls = 0

    setTokenProvider(async () => {
      calls += 1
      return null
    })

    assert.equal(await bearerFor('/api/a'), null)
    assert.equal(await bearerFor('/api/b'), null)
    assert.equal(calls, 1)
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
      return calls === 1 ? null : 'fresh.jwt.signature'
    })

    assert.equal(await bearerFor('/api/a'), null)
    assert.equal(calls, 1)

    resetTokenProviderState()

    assert.equal(
      await bearerFor('/api/b'),
      'fresh.jwt.signature',
    )
    assert.equal(calls, 2)
  })

  it('shares one token exchange across concurrent requests', async () => {
    let calls = 0
    let inFlight = 0
    let peak = 0

    setTokenProvider(async () => {
      calls += 1
      inFlight += 1
      peak = Math.max(peak, inFlight)

      await new Promise((resolve) => setTimeout(resolve, 30))

      inFlight -= 1
      return 'shared.jwt.signature'
    })

    const results = await Promise.all([
      bearerFor('/api/dashboard'),
      bearerFor('/api/validations'),
      bearerFor('/api/investigations'),
    ])

    assert.equal(calls, 1, 'only one token exchange must happen')
    assert.equal(peak, 1, 'token exchanges must not stack')

    assert.deepEqual(results, [
      'shared.jwt.signature',
      'shared.jwt.signature',
      'shared.jwt.signature',
    ])
  })

  it('does not reuse a token from a replaced provider', async () => {
    let finishOldProvider!: (value: string | null) => void

    setTokenProvider(
      () =>
        new Promise<string | null>((resolve) => {
          finishOldProvider = resolve
        }),
    )

    const oldRequest = bearerFor('/api/dashboard')

    setTokenProvider(async () => 'new.jwt.signature')

    finishOldProvider('old.jwt.signature')

    assert.equal(await oldRequest, null)
    assert.equal(
      await bearerFor('/api/validations'),
      'new.jwt.signature',
    )
  })

  it('a new provider clears the failed state', async () => {
    setTokenProvider(async () => null)

    assert.equal(await bearerFor('/api/a'), null)

    setTokenProvider(async () => 'fresh.jwt.signature')

    assert.equal(
      await bearerFor('/api/b'),
      'fresh.jwt.signature',
    )
  })
})
