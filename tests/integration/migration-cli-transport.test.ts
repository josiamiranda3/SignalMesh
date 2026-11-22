import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

/**
 * CLI transport robustness.
 *
 * The CLI is a separate process entry point, so the honest way to test its HTTP
 * behaviour is against a real socket that misbehaves on purpose: a server that
 * never answers, one that answers 500, one that answers HTML, one that answers
 * 403. That exercises the timeout, the retry classification and the failure
 * messages without mocking `fetch`.
 *
 * The helper mirrors the CLI's contract (`callActionOnce`/`callAction`). It is
 * intentionally a copy of the *behaviour under test*, not an import: the CLI
 * runs `main()` at import time, which would execute a migration. The
 * `worker-contract` suite asserts statically that the CLI keeps this shape
 * (AbortController, DEFAULT_TIMEOUT_MS, DEFAULT_RETRIES, --from).
 */

const CSRF_HEADER = 'x-signalmess-request'

interface CallFailure {
  ok: false
  kind: 'transport' | 'timeout' | 'http' | 'invalid-response' | 'refused'
  message: string
  retryable: boolean
}

interface CallSuccess {
  ok: true
  body: { success: boolean; data?: unknown; error?: string }
}

async function callActionOnce(input: {
  targetUrl: string
  token: string
  ownerId: string
  rows: Array<{ collection: string; id: string; data: Record<string, unknown> }>
  dryRun: boolean
  timeoutMs: number
}): Promise<CallSuccess | CallFailure> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.timeoutMs)
  let response: Response
  try {
    response = await fetch(`${input.targetUrl.replace(/\/+$/, '')}/api/actions/migrateRecords`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.token}`,
        [CSRF_HEADER]: '1',
      },
      body: JSON.stringify({ ownerId: input.ownerId, rows: input.rows, dryRun: input.dryRun }),
      signal: controller.signal,
    })
  } catch (error) {
    const aborted = (error as Error).name === 'AbortError'
    return {
      ok: false,
      kind: aborted ? 'timeout' : 'transport',
      message: aborted ? `tempo esgotado após ${input.timeoutMs} ms` : `falha de conexão: ${(error as Error).message}`,
      retryable: true,
    }
  } finally {
    clearTimeout(timer)
  }

  const text = await response.text()
  let body: { success: boolean; error?: string }
  try {
    body = JSON.parse(text) as { success: boolean; error?: string }
  } catch {
    return {
      ok: false,
      kind: 'invalid-response',
      message: `resposta não-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`,
      retryable: response.status >= 500,
    }
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return { ok: false, kind: 'refused', message: `HTTP ${response.status}`, retryable: false }
    }
    return {
      ok: false,
      kind: 'http',
      message: `HTTP ${response.status}`,
      retryable: response.status >= 500 || response.status === 429,
    }
  }
  if (body.success !== true) {
    return { ok: false, kind: 'refused', message: body.error ?? 'recusado', retryable: false }
  }
  return { ok: true, body }
}

let server: Server
let base: string
/** Per-path behaviour, set by each test. */
let behaviour: { status: number; body: string; hang: boolean; delayMs?: number }
/** Requests the server actually received. */
let received: Array<{ headers: Record<string, string | string[] | undefined> }>
/** Sockets held open by the timeout test; destroyed on teardown. */
const sockets = new Set<Socket>()

before(async () => {
  received = []
  behaviour = { status: 200, body: '{"success":true}', hang: false }
  server = createServer((request, response) => {
    received.push({ headers: request.headers })
    // Drain the body so the socket is not left half-read.
    request.resume()
    request.on('end', () => {
      if (behaviour.hang) return
      setTimeout(() => {
        response.writeHead(behaviour.status, { 'content-type': 'application/json' })
        response.end(behaviour.body)
      }, behaviour.delayMs ?? 0)
    })
  })
  // A cell that never answers is the point of one test; track its socket so the
  // suite can close cleanly instead of leaving a connection that delays teardown
  // (these suites share one process under --test-isolation=none).
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  behaviour = { status: 200, body: '', hang: false }
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections?.()
  })
})

function call(timeoutMs = 3000) {
  return callActionOnce({
    targetUrl: base,
    token: 'token',
    ownerId: 'user_owner',
    rows: [{ collection: 'investigations', id: 'inv_1', data: {} }],
    dryRun: true,
    timeoutMs,
  })
}

describe('the CLI sends the headers the server expects', () => {
  it('carries the bearer token and the CSRF marker', async () => {
    behaviour = { status: 200, body: '{"success":true,"data":{}}', hang: false }
    received = []
    await call()
    assert.equal(received.length, 1)
    assert.equal(received[0]!.headers['authorization'], 'Bearer token')
    assert.equal(received[0]!.headers[CSRF_HEADER], '1')
    assert.equal(received[0]!.headers['content-type'], 'application/json')
  })
})

describe('failure classification', () => {
  it('reports a timeout as a retryable failure', async () => {
    behaviour = { status: 200, body: '{}', hang: true }
    const started = Date.now()
    const result = await call(150)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.kind, 'timeout')
    assert.equal(result.retryable, true)
    // It must actually stop waiting.
    assert.ok(Date.now() - started < 2000, 'o timeout deve encerrar a chamada')
  })

  it('treats a 500 as retryable', async () => {
    behaviour = { status: 500, body: '{"success":false,"error":"boom"}', hang: false }
    const result = await call()
    if (result.ok) return assert.fail('deveria falhar')
    assert.equal(result.kind, 'http')
    assert.equal(result.retryable, true)
  })

  it('treats a 403 as final, not retryable', async () => {
    // Retrying a credentials/permission problem only delays the diagnosis.
    behaviour = { status: 403, body: '{"success":false,"error":"Forbidden: owner only"}', hang: false }
    const result = await call()
    if (result.ok) return assert.fail('deveria falhar')
    assert.equal(result.kind, 'refused')
    assert.equal(result.retryable, false)
  })

  it('reports a non-JSON response without pretending it succeeded', async () => {
    behaviour = { status: 502, body: '<html>Bad Gateway</html>', hang: false }
    const result = await call()
    if (result.ok) return assert.fail('deveria falhar')
    assert.equal(result.kind, 'invalid-response')
    assert.match(result.message, /não-JSON/)
  })

  it('treats success:false on a 200 as a refusal', async () => {
    behaviour = { status: 200, body: '{"success":false,"error":"ownerId divergente"}', hang: false }
    const result = await call()
    if (result.ok) return assert.fail('deveria falhar')
    assert.equal(result.kind, 'refused')
  })

  it('treats a connection refusal as retryable transport failure', async () => {
    const result = await callActionOnce({
      targetUrl: 'http://127.0.0.1:1',
      token: 'token',
      ownerId: 'user_owner',
      rows: [],
      dryRun: true,
      timeoutMs: 2000,
    })
    if (result.ok) return assert.fail('deveria falhar')
    assert.equal(result.kind, 'transport')
    assert.equal(result.retryable, true)
  })
})

describe('a slow but healthy response is not aborted', () => {
  it('succeeds when the server answers within the timeout', async () => {
    behaviour = { status: 200, body: '{"success":true,"data":{"counts":{}}}', hang: false, delayMs: 120 }
    const result = await call(3000)
    assert.equal(result.ok, true)
  })
})
