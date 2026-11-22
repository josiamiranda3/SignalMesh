import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { api, ApiError, setTokenProvider, resetTokenProviderState, downloadFile } from '../../src/lib/api.ts'

/**
 * Bearer plumbing in the API client.
 *
 * ## The defect these tests pin
 *
 * The browser holds an opaque **session token** in `__Secure-better-auth.session_token`
 * (what makes renewal work). Protected endpoints verify a **JWT**. Before this
 * change the client sent only the cookie, so `/api/auth/me` handed a session
 * token to `verifyJwt` and got 401.
 *
 * The client now obtains a JWT through the SDK's `getAuthToken()` — which itself
 * calls `POST /api/auth/token` with the cookie — and sends it as
 * `Authorization: Bearer`. The server already prefers a bearer over a cookie
 * (`worker.ts`, `token = bearer ?? cookie`).
 *
 * ## Recursion
 *
 * `getAuthToken()` calls `/api/auth/token`. If that call also asked for a
 * bearer, obtaining a token would require a token. The client therefore skips
 * the provider for the exchange endpoint — asserted below.
 */

interface Captured {
  url: string
  method: string
  headers: Record<string, string>
  credentials: string | undefined
}

let captured: Captured[] = []
let originalFetch: typeof globalThis.fetch

/** Install a fetch that records requests and replies with a scripted body. */
function stubFetch(reply: (url: string) => Response): void {
  captured = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v
    }
    captured.push({
      url,
      method: init?.method ?? 'GET',
      headers,
      credentials: init?.credentials as string | undefined,
    })
    return reply(url)
  }) as typeof fetch
}

const okJson = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

beforeEach(() => {
  originalFetch = globalThis.fetch
  setTokenProvider(null)
})

afterEach(() => {
  globalThis.fetch = originalFetch
  setTokenProvider(null)
})

describe('API client: bearer attachment', () => {
  it('sends Authorization: Bearer on protected requests', async () => {
    stubFetch(() => okJson({ success: true, data: { id: 'u1' } }))
    setTokenProvider(async () => 'header.payload.signature')

    const result = await api.get<{ id: string }>('/api/investigations')

    assert.deepEqual(result, { id: 'u1' })
    assert.equal(captured.length, 1)
    assert.equal(captured[0]!.headers['authorization'], 'Bearer header.payload.signature')
  })

  it('keeps credentials: same-origin so the cookie can renew the session', async () => {
    stubFetch(() => okJson({ success: true, data: [] }))
    setTokenProvider(async () => 't.r.s')

    await api.get('/api/history')

    assert.equal(captured[0]!.credentials, 'same-origin')
  })

  it('degrades to a cookie-only request when no token is available', async () => {
    stubFetch(() => okJson({ success: true, data: [] }))
    setTokenProvider(async () => null)

    await api.get('/api/investigations')

    assert.equal(captured[0]!.headers['authorization'], undefined)
    assert.equal(captured[0]!.credentials, 'same-origin')
  })

  it('works with no provider at all (local mode)', async () => {
    stubFetch(() => okJson({ success: true, data: [] }))

    await api.get('/api/investigations')

    assert.equal(captured[0]!.headers['authorization'], undefined)
  })

  it('never throws when the provider fails', async () => {
    stubFetch(() => okJson({ success: true, data: [] }))
    setTokenProvider(async () => {
      throw new Error('sdk exploded')
    })

    const result = await api.get<unknown[]>('/api/investigations')

    assert.deepEqual(result, [])
    assert.equal(captured[0]!.headers['authorization'], undefined)
  })

  it('attaches the bearer to mutating requests too', async () => {
    stubFetch(() => okJson({ success: true, data: { id: 'new' } }))
    setTokenProvider(async () => 'a.b.c')

    await api.post('/api/investigations', { title: 'x' })
    await api.patch('/api/investigations/1', { title: 'y' })
    await api.delete('/api/investigations/1')

    for (const call of captured) {
      assert.equal(call.headers['authorization'], 'Bearer a.b.c')
    }
  })
})

describe('API client: no recursive token exchange', () => {
  it('does not request a bearer for /api/auth/token', async () => {
    // getAuthToken() calls this endpoint; attaching a bearer would recurse.
    stubFetch(() => okJson({ success: true, data: { token: 'jwt' } }))
    let providerCalls = 0
    setTokenProvider(async () => {
      providerCalls += 1
      return 'should.not.be.used'
    })

    await api.post('/api/auth/token')

    assert.equal(providerCalls, 0, 'the token endpoint must not consult the provider')
    assert.equal(captured[0]!.headers['authorization'], undefined)
  })

  it('does not request a bearer for login, logout or config', async () => {
    for (const path of ['/api/auth/login', '/api/auth/logout', '/api/auth/config']) {
      stubFetch(() => okJson({ success: true, data: {} }))
      let providerCalls = 0
      setTokenProvider(async () => {
        providerCalls += 1
        return 'x.y.z'
      })
      await (path.endsWith('config') ? api.get(path) : api.post(path))
      assert.equal(providerCalls, 0, `${path} must not consult the provider`)
    }
  })

  it('does not stack exchanges when the provider is slow (guard flag)', async () => {
    stubFetch(() => okJson({ success: true, data: [] }))
    let inFlight = 0
    let maxConcurrent = 0
    setTokenProvider(async () => {
      inFlight += 1
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      await new Promise((r) => setTimeout(r, 20))
      inFlight -= 1
      return 'x.y.z'
    })

    // Fired together: the first resolves a token, the others must not nest.
    await Promise.all([api.get('/api/a'), api.get('/api/b'), api.get('/api/c')])

    assert.equal(maxConcurrent, 1, 'only one exchange may run at a time')
  })
})

describe('API client: session-decision endpoints', () => {
  it('getAnonymous never sends a bearer', async () => {
    stubFetch(() => okJson({ success: true, data: { id: 'u1' } }))
    let providerCalls = 0
    setTokenProvider(async () => {
      providerCalls += 1
      return 'stale.token.value'
    })

    await api.getAnonymous('/api/auth/me')

    assert.equal(providerCalls, 0)
    assert.equal(captured[0]!.headers['authorization'], undefined)
    assert.equal(captured[0]!.credentials, 'same-origin')
  })

  it('postAnonymous never sends a bearer', async () => {
    stubFetch(() => okJson({ success: true, data: { signedOut: true } }))
    setTokenProvider(async () => 'stale.token.value')

    await api.postAnonymous('/api/auth/logout')

    assert.equal(captured[0]!.headers['authorization'], undefined)
  })
})

describe('API client: failed exchange does not become a loop', () => {
  it('stops consulting the provider after it returns null, until reset', async () => {
    stubFetch(() => okJson({ success: true, data: [] }))
    let providerCalls = 0
    setTokenProvider(async () => {
      providerCalls += 1
      return null
    })

    await api.get('/api/a')
    await api.get('/api/b')
    await api.get('/api/c')

    assert.equal(providerCalls, 1, 'a failed exchange must not be retried per request')
  })

  it('tries again after resetTokenProviderState()', async () => {
    stubFetch(() => okJson({ success: true, data: [] }))
    let providerCalls = 0
    setTokenProvider(async () => {
      providerCalls += 1
      return providerCalls === 1 ? null : 'x.y.z'
    })

    await api.get('/api/a')
    assert.equal(providerCalls, 1)

    resetTokenProviderState()

    await api.get('/api/b')
    assert.equal(providerCalls, 2, 'a reset re-enables the exchange')
    assert.equal(captured[1]!.headers['authorization'], 'Bearer x.y.z')
  })

  it('a thrown provider is treated as unavailable, not fatal', async () => {
    stubFetch(() => okJson({ success: true, data: [] }))
    setTokenProvider(async () => {
      throw new Error('boom')
    })

    await api.get('/api/a')
    await api.get('/api/b')

    assert.equal(captured.length, 2, 'both requests still completed')
    assert.equal(captured[0]!.headers['authorization'], undefined)
  })
})

describe('API client: error handling is unchanged', () => {
  it('surfaces a 401 as an ApiError with status 401', async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ success: false, error: { code: 'unauthorized', message: 'no' } }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    )
    setTokenProvider(async () => 'invalid.token.value')

    await assert.rejects(
      () => api.get('/api/investigations'),
      (error: unknown) => {
        assert.ok(error instanceof ApiError)
        assert.equal(error.status, 401)
        return true
      },
    )
  })

  it('never stores the token in localStorage or sessionStorage', async () => {
    // The token lives only in the SDK's in-memory cache. Reading the source is
    // the honest check: a behavioural test cannot prove the absence of storage.
    // Comments are stripped first — the module explains *why* it does not
    // persist anything, and that explanation names the APIs.
    const { readFileSync } = await import('node:fs')
    const raw = readFileSync(new URL('../../src/lib/api.ts', import.meta.url), 'utf8')
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    assert.ok(!/localStorage/.test(code), 'no localStorage')
    assert.ok(!/sessionStorage/.test(code), 'no sessionStorage')
  })
})

describe('API client: downloads carry the credential', () => {
  it('sends the bearer on the export request', async () => {
    stubFetch(
      () =>
        new Response('id,title', {
          status: 200,
          headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="e.csv"' },
        }),
    )
    setTokenProvider(async () => 'a.b.c')

    // jsdom-free environment: stub the bits downloadFile touches.
    const created: string[] = []
    const originalCreate = URL.createObjectURL
    const originalRevoke = URL.revokeObjectURL
    ;(URL as unknown as { createObjectURL: () => string }).createObjectURL = () => 'blob:x'
    ;(URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {}
    const originalDoc = (globalThis as { document?: unknown }).document
    const originalWindow = (globalThis as { window?: unknown }).window
    ;(globalThis as { document?: unknown }).document = {
      createElement: () => ({
        set href(v: string) { created.push(v) },
        set download(_: string) {},
        set rel(_: string) {},
        click() {},
        remove() {},
      }),
      body: { appendChild() {} },
    }
    // `downloadFile` revokes the object URL on a timeout, which needs `window`.
    ;(globalThis as { window?: unknown }).window = { setTimeout: (fn: () => void) => fn() }

    try {
      const filename = await downloadFile('/api/investigations/1/export', { format: 'csv' })
      assert.equal(filename, 'e.csv')
      assert.equal(captured[0]!.headers['authorization'], 'Bearer a.b.c')
      assert.equal(captured[0]!.credentials, 'same-origin')
    } finally {
      URL.createObjectURL = originalCreate
      URL.revokeObjectURL = originalRevoke
      ;(globalThis as { document?: unknown }).document = originalDoc
      ;(globalThis as { window?: unknown }).window = originalWindow
    }
  })
})
