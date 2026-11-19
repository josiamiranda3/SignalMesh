/**
 * Integration test harness.
 *
 * Boots the real application (Hono routes, middleware, services, repositories,
 * SQLite) against an in-memory database. Only the two external providers are
 * replaced, by a configurable mock HTTP server that speaks the documented Exa
 * and Gemini wire formats — so the request bodies the app builds and the
 * responses it parses are exercised for real.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { serve } from '@hono/node-server'
import { buildApp, type BuiltApp } from '../../server/app.ts'
import type { Services } from '../../server/services/index.ts'

export interface MockState {
  exaRequests: Array<Record<string, unknown>>
  geminiRequests: Array<Record<string, unknown>>
  exaMode:
    | 'ok'
    | 'empty'
    | 'partial'
    | 'unauthorized'
    | 'rate-limit'
    | 'server-error'
    | 'timeout'
    | 'bad-json'
  geminiMode:
    | 'ok'
    | 'fabricated-reference'
    | 'invalid-schema'
    | 'unauthorized'
    | 'rate-limit'
    | 'server-error'
    | 'truncated'
  geminiPayload: unknown
}

export interface Harness {
  base: string
  app: BuiltApp
  services: Services
  mock: MockState
  close: () => Promise<void>
}

const SAMPLE_RESULTS = [
  {
    id: 'https://example.org/estudo-antifraude',
    title: 'Estudo sobre aprendizado de máquina aplicado a antifraude',
    url: 'https://example.org/estudo-antifraude',
    publishedDate: '2024-08-12T00:00:00.000Z',
    author: 'Grupo de Pesquisa',
    text: 'Conteúdo integral do estudo sobre detecção de fraudes financeiras com machine learning no Brasil.',
    highlights: ['Redução de falsos positivos em 23%', 'Modelo treinado com dados de 2023'],
    summary: 'Resumo do estudo sobre antifraude.',
  },
  {
    id: 'https://example.org/regulacao',
    title: 'Requisitos regulatórios para decisões automatizadas',
    url: 'https://example.org/regulacao',
    publishedDate: '2023-11-03T00:00:00.000Z',
    author: null,
    highlights: ['Exigência de explicabilidade em modelos de crédito'],
  },
  {
    id: 'https://example.org/panorama',
    title: 'Panorama de fraudes digitais',
    url: 'https://example.org/panorama',
    publishedDate: null,
    author: 'Equipe Editorial',
  },
]

function buildGeminiPayload(evidenceIds: string[]): unknown {
  const primary = evidenceIds[0] ?? 'evi_missing'
  return {
    executiveSummary: 'As fontes indicam uso de aprendizado de máquina em antifraude, com resultados positivos reportados.',
    findings: [
      {
        statement: 'Um estudo relata redução de falsos positivos com gradient boosting.',
        evidenceIds: [primary],
        confidence: 'medium',
      },
      {
        statement: 'Requisitos regulatórios exigem explicabilidade em decisões automatizadas.',
        evidenceIds: evidenceIds.slice(1, 2).length ? evidenceIds.slice(1, 2) : [primary],
        confidence: 'low',
      },
    ],
    keyPoints: ['Explicabilidade é requisito regulatório'],
    supportedClaims: ['Redução de falsos positivos reportada'],
    contradictions: evidenceIds.length > 1
      ? [{ description: 'Fontes divergem sobre a magnitude do ganho.', evidenceIds: evidenceIds.slice(0, 2) }]
      : [],
    limitations: ['Amostra pequena de fontes', 'Sem dados de 2025'],
    informationGaps: ['Resultados auditados por terceiros'],
    objectiveAlignment: 'Responde parcialmente ao objetivo, cobrindo tecnologias e instituições.',
    insufficientEvidence: false,
    citedEvidenceIds: evidenceIds.slice(0, 2),
  }
}

export async function startHarness(overrides: Record<string, string> = {}): Promise<Harness> {
  const mock: MockState = {
    exaRequests: [],
    geminiRequests: [],
    exaMode: 'ok',
    geminiMode: 'ok',
    geminiPayload: null,
  }

  const provider: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: Record<string, unknown> = {}
      try {
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
      } catch {
        body = { __unparsed: raw }
      }

      const url = request.url ?? ''

      if (url.startsWith('/search') || url.startsWith('/exa/search')) {
        mock.exaRequests.push(body)
        if (mock.exaMode === 'timeout') return // never responds
        if (mock.exaMode === 'unauthorized') {
          response.writeHead(401, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'invalid api key' }))
          return
        }
        if (mock.exaMode === 'rate-limit') {
          response.writeHead(429, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'rate limit exceeded' }))
          return
        }
        if (mock.exaMode === 'server-error') {
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'internal' }))
          return
        }
        if (mock.exaMode === 'bad-json') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end('{not json')
          return
        }
        const results =
          mock.exaMode === 'empty'
            ? []
            : mock.exaMode === 'partial'
              ? [SAMPLE_RESULTS[1], SAMPLE_RESULTS[2]]
              : SAMPLE_RESULTS
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            requestId: 'req_test_123',
            results,
            costDollars: { total: 0.005 },
            warnings: [],
          }),
        )
        return
      }

      if (url.includes(':generateContent')) {
        mock.geminiRequests.push(body)
        if (mock.geminiMode === 'unauthorized') {
          response.writeHead(403, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { code: 403, message: 'API key not valid', status: 'PERMISSION_DENIED' } }))
          return
        }
        if (mock.geminiMode === 'rate-limit') {
          response.writeHead(429, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { code: 429, message: 'quota exceeded' } }))
          return
        }
        if (mock.geminiMode === 'server-error') {
          response.writeHead(503, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { code: 503, message: 'unavailable' } }))
          return
        }

        // Discover the evidence ids the app actually sent, from the prompt.
        const userText = extractUserText(body)
        const sentIds = [...userText.matchAll(/<fonte id="([^"]+)"/g)].map((match) => match[1]!)

        let payload: unknown
        if (mock.geminiMode === 'invalid-schema') {
          payload = { executiveSummary: 'Falta o resto dos campos' }
        } else if (mock.geminiMode === 'fabricated-reference') {
          payload = {
            ...(buildGeminiPayload(sentIds) as Record<string, unknown>),
            findings: [
              {
                statement: 'Conclusão baseada em fonte inexistente.',
                evidenceIds: ['evi_inventado_pela_ia'],
                confidence: 'high',
              },
            ],
          }
        } else {
          payload = mock.geminiPayload ?? buildGeminiPayload(sentIds)
        }

        const finishReason = mock.geminiMode === 'truncated' ? 'MAX_TOKENS' : 'STOP'
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(
          JSON.stringify({
            candidates: [
              {
                content: { parts: [{ text: JSON.stringify(payload) }], role: 'model' },
                finishReason,
              },
            ],
            usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 480, totalTokenCount: 1680 },
          }),
        )
        return
      }

      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'unknown mock route' }))
    })
  })

  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve))
  const port = (provider.address() as AddressInfo).port
  const providerBase = `http://127.0.0.1:${port}`

  const built = await buildApp({
    env: {
      NODE_ENV: 'development',
      DATABASE_URL: ':memory:',
      APP_ORIGIN: 'http://127.0.0.1:9999',
      SESSION_SECRET: 'test-secret-value-that-is-long-enough-1234567890',
      ENABLE_EXTERNAL_APIS: 'true',
      ENABLE_PAID_OPERATIONS: 'false',
      EXA_API_KEY: 'test-exa-key',
      EXA_BASE_URL: providerBase,
      EXA_TIMEOUT_MS: '3000',
      GEMINI_API_KEY: 'test-gemini-key',
      GEMINI_BASE_URL: providerBase,
      GEMINI_MODEL: 'gemini-2.5-flash',
      GEMINI_TIMEOUT_MS: '3000',
      RESEARCH_DAILY_LIMIT: '3',
      ANALYSIS_DAILY_LIMIT: '3',
      RESEARCH_GLOBAL_DAILY_LIMIT: '30',
      ANALYSIS_GLOBAL_DAILY_LIMIT: '30',
      DUPLICATE_GUARD_SECONDS: '90',
      ...overrides,
    },
  })

  // The app must listen on a real socket: the tests exercise cookies, the CSRF
  // origin check and streaming responses, not just the handler in isolation.
  const appServer = serve({ fetch: built.app.fetch, port: 0, hostname: '127.0.0.1' })
  await new Promise<void>((resolve) => {
    if ('listening' in appServer && appServer.listening) resolve()
    else appServer.once('listening', () => resolve())
  })
  const appPort = (appServer.address() as AddressInfo).port
  const appBase = `http://127.0.0.1:${appPort}`

  // APP_ORIGIN is fixed at build time, so the CSRF origin check must match the
  // origin the client actually uses. Rebuild with the resolved port.
  await new Promise<void>((resolve) => appServer.close(() => resolve()))

  const finalBuilt = await buildApp({
    env: {
      NODE_ENV: 'development',
      DATABASE_URL: ':memory:',
      APP_ORIGIN: appBase,
      SESSION_SECRET: 'test-secret-value-that-is-long-enough-1234567890',
      ENABLE_EXTERNAL_APIS: 'true',
      ENABLE_PAID_OPERATIONS: 'false',
      EXA_API_KEY: 'test-exa-key',
      EXA_BASE_URL: providerBase,
      EXA_TIMEOUT_MS: '3000',
      GEMINI_API_KEY: 'test-gemini-key',
      GEMINI_BASE_URL: providerBase,
      GEMINI_MODEL: 'gemini-2.5-flash',
      GEMINI_TIMEOUT_MS: '3000',
      RESEARCH_DAILY_LIMIT: '3',
      ANALYSIS_DAILY_LIMIT: '3',
      RESEARCH_GLOBAL_DAILY_LIMIT: '30',
      ANALYSIS_GLOBAL_DAILY_LIMIT: '30',
      DUPLICATE_GUARD_SECONDS: '90',
      ...overrides,
    },
  })

  const finalServer = serve({ fetch: finalBuilt.app.fetch, port: appPort, hostname: '127.0.0.1' })
  await new Promise<void>((resolve) => finalServer.once('listening', () => resolve()))

  return {
    base: appBase,
    app: finalBuilt,
    services: finalBuilt.services,
    mock,
    close: async () => {
      // Node's test runner shares one process across suites here, so a server
      // closed by another suite's teardown must not throw on a second close.
      await new Promise<void>((resolve) => {
        try {
          finalServer.close(() => resolve())
        } catch {
          resolve()
        }
      })
      await new Promise<void>((resolve) => {
        try {
          provider.close(() => resolve())
        } catch {
          resolve()
        }
      })
      try {
        finalBuilt.close()
      } catch {
        /* already closed */
      }
    },
  }
}

function extractUserText(body: Record<string, unknown>): string {
  const contents = body.contents as Array<{ parts?: Array<{ text?: string }> }> | undefined
  return contents?.[0]?.parts?.[0]?.text ?? ''
}

// ---------------------------------------------------------------------------
// HTTP client that behaves like the browser (cookies + CSRF header)
// ---------------------------------------------------------------------------

export interface Client {
  cookie: string | null
  request: <T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    options?: { csrf?: boolean; origin?: string; rawText?: boolean },
  ) => Promise<{ status: number; body: T; headers: Headers }>
}

export function createClient(base: string): Client {
  const client: Client = {
    cookie: null,
    async request<T>(
      method: string,
      path: string,
      body?: unknown,
      options: { csrf?: boolean; origin?: string; rawText?: boolean } = {},
    ) {
      const headers: Record<string, string> = { accept: 'application/json' }
      if (options.csrf !== false) headers['x-signalmess-request'] = '1'
      headers.origin = options.origin ?? base
      if (client.cookie) headers.cookie = client.cookie
      if (body !== undefined) headers['content-type'] = 'application/json'

      const response = await fetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const setCookie = response.headers.get('set-cookie')
      if (setCookie) {
        const value = setCookie.split(';')[0]
        client.cookie = value && !value.endsWith('=') ? value : null
      }
      const text = await response.text()
      // Binary and file responses must stay as text so tests can parse CSV/JSON
      // exports themselves rather than relying on content-type sniffing.
      if (options.rawText) return { status: response.status, body: text as T, headers: response.headers }
      let parsed: unknown = text
      try {
        parsed = JSON.parse(text)
      } catch {
        /* non-JSON body stays as text */
      }
      return { status: response.status, body: parsed as T, headers: response.headers }
    },
  }
  return client
}

/** Sign in and return the authenticated client. */
export async function signIn(base: string, email: string, name = 'Teste'): Promise<Client> {
  const client = createClient(base)
  const response = await client.request('POST', '/api/auth/login', { email, name })
  if (response.status !== 200) {
    throw new Error(`login falhou (${response.status}): ${JSON.stringify(response.body)}`)
  }
  return client
}

export const SAMPLE_INVESTIGATION = {
  title: 'IA na detecção de fraudes financeiras no Brasil',
  description: 'Investigação sobre antifraude com aprendizado de máquina.',
  objective:
    'Identificar aplicações reais de inteligência artificial na detecção de fraudes financeiras no Brasil e os resultados publicados.',
  topic: 'inteligência artificial para detecção de fraudes financeiras no Brasil',
  keywords: ['fraude financeira', 'machine learning'],
  status: 'active' as const,
}
