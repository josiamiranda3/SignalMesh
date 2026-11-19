import type { AppConfig } from '../config.ts'
import { errors } from '../lib/errors.ts'
import { excerpt, extractDomain, nowIso, stripHtml } from '../lib/util.ts'

/**
 * Exa Search integration.
 *
 * Endpoint and payload follow the public API reference
 * (POST https://api.exa.ai/search, OpenAPI spec exa-spec.yaml v2.0.0):
 *   - auth: `x-api-key: <key>` (Bearer also accepted)
 *   - body: { query, type?, numResults?, contents? }
 *   - response: { requestId, results: [{ title, url, publishedDate, author,
 *     text?, highlights?, summary?, favicon? }], costDollars?, warnings? }
 *
 * Only documented fields are read. Fields that the provider omitted stay
 * `null` — nothing is inferred to fill a gap, and `contentAvailability`
 * records exactly which content fields came back.
 *
 * No automatic retry: a repeat is a new billed request and must be a
 * deliberate act by the user.
 */

export interface ExaSearchResult {
  id: string
  title: string
  url: string
  domain: string
  snippet: string
  retrievedContent: string | null
  contentAvailability: string[]
  publishedAt: string | null
  author: string | null
  providerRequestId: string | null
}

export interface ExaSearchOutcome {
  results: ExaSearchResult[]
  providerRequestId: string | null
  costUsd: number | null
  warnings: string[]
  contentNotice: string
  executedAt: string
}

interface ExaApiResult {
  id?: string
  title?: string | null
  url?: string | null
  publishedDate?: string | null
  author?: string | null
  text?: string | null
  highlights?: string[] | null
  summary?: string | null
  favicon?: string | null
}

interface ExaApiResponse {
  requestId?: string
  results?: ExaApiResult[]
  costDollars?: { total?: number } | number | null
  warnings?: Array<{ message?: string } | string>
  notices?: Array<{ message?: string } | string>
}

export class ExaClient {
  constructor(private readonly config: AppConfig) {}

  get configured(): boolean {
    return Boolean(this.config.exaApiKey)
  }

  /** Guard rails that must pass before any network call is attempted. */
  assertUsable(): void {
    if (!this.config.externalApisEnabled) {
      throw errors.externalDisabled(
        'As chamadas a provedores externos estão desativadas. Defina ENABLE_EXTERNAL_APIS=true para habilitar pesquisas.',
      )
    }
    if (!this.config.exaApiKey) {
      throw errors.externalDisabled(
        'EXA_API_KEY não está configurada. A pesquisa externa permanece indisponível até que a chave seja definida no backend.',
      )
    }
  }

  async search(params: { query: string; numResults: number; includeContent: boolean }): Promise<ExaSearchOutcome> {
    this.assertUsable()

    const body: Record<string, unknown> = {
      query: params.query,
      type: this.config.exaSearchType,
      numResults: params.numResults,
    }
    if (params.includeContent) {
      // Request the documented content options. `text` returns page text from
      // the index; `highlights` returns relevant excerpts. Not every result is
      // guaranteed to include either, which is why we record availability.
      body.contents = {
        text: { maxCharacters: 12_000 },
        highlights: { numSentences: 4, highlightsPerUrl: 2 },
        summary: { query: params.query },
      }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.exaTimeoutMs)
    let response: Response
    try {
      response = await fetch(`${this.config.exaBaseUrl.replace(/\/+$/, '')}/search`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.config.exaApiKey as string,
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw errors.provider(
          'provider_timeout',
          `A pesquisa excedeu ${Math.round(this.config.exaTimeoutMs / 1000)}s. Tente novamente mais tarde.`,
          'exa',
          true,
          error,
        )
      }
      throw errors.provider('provider_unavailable', 'Não foi possível contactar a Exa.', 'exa', true, error)
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      throw await this.mapHttpError(response)
    }

    let payload: ExaApiResponse
    try {
      payload = (await response.json()) as ExaApiResponse
    } catch (error) {
      throw errors.provider(
        'invalid_provider_response',
        'A Exa retornou uma resposta que não é JSON válido.',
        'exa',
        false,
        error,
      )
    }

    const rawResults = Array.isArray(payload.results) ? payload.results : []
    const providerRequestId = typeof payload.requestId === 'string' ? payload.requestId : null

    const results: ExaSearchResult[] = []
    const seen = new Set<string>()
    for (const raw of rawResults) {
      const url = typeof raw.url === 'string' ? raw.url.trim() : ''
      if (!url || seen.has(url)) continue
      try {
        const parsed = new URL(url)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue
      } catch {
        continue
      }
      seen.add(url)

      const availability: string[] = []
      const text = typeof raw.text === 'string' && raw.text.trim() ? stripHtml(raw.text) : null
      if (text) availability.push('text')
      const highlights = Array.isArray(raw.highlights)
        ? raw.highlights.map((item) => stripHtml(String(item))).filter(Boolean)
        : []
      if (highlights.length > 0) availability.push('highlights')
      if (typeof raw.summary === 'string' && raw.summary.trim()) availability.push('summary')

      const snippetSource =
        highlights.length > 0
          ? highlights.join(' … ')
          : typeof raw.summary === 'string' && raw.summary.trim()
            ? stripHtml(raw.summary)
            : text
              ? excerpt(text, 420)
              : ''

      results.push({
        id: raw.id?.trim() || url,
        title: (raw.title?.trim() || extractDomain(url) || 'Fonte sem título').slice(0, 400),
        url,
        domain: extractDomain(url),
        snippet: excerpt(snippetSource, 1200),
        retrievedContent: text,
        contentAvailability: availability,
        publishedAt: normalizeDate(raw.publishedDate),
        author: typeof raw.author === 'string' && raw.author.trim() ? raw.author.trim().slice(0, 300) : null,
        providerRequestId,
      })
    }

    const warnings = (payload.warnings ?? [])
      .map((warning) => (typeof warning === 'string' ? warning : warning.message ?? ''))
      .filter(Boolean)

    return {
      results,
      providerRequestId,
      costUsd: readCost(payload.costDollars),
      warnings,
      contentNotice: buildContentNotice(results),
      executedAt: nowIso(),
    }
  }

  private async mapHttpError(response: Response): Promise<Error> {
    let detail = ''
    try {
      const body = (await response.json()) as { error?: string; message?: string; detail?: string }
      detail = body.error ?? body.message ?? body.detail ?? ''
    } catch {
      detail = ''
    }
    const suffix = detail ? ` Detalhe do provedor: ${detail.slice(0, 200)}` : ''

    switch (response.status) {
      case 400:
        return errors.provider(
          'invalid_provider_response',
          `A Exa rejeitou os parâmetros da pesquisa.${suffix}`,
          'exa',
        )
      case 401:
        return errors.provider(
          'provider_auth_failed',
          'A chave da Exa foi recusada (401). Verifique EXA_API_KEY no backend.',
          'exa',
        )
      case 402:
        return errors.provider(
          'provider_auth_failed',
          `A conta da Exa está sem créditos (402). Nenhuma nova chamada será tentada.${suffix}`,
          'exa',
        )
      case 403:
        return errors.provider('provider_auth_failed', 'Aceso negado pela Exa (403).', 'exa')
      case 429:
        return errors.provider(
          'provider_rate_limited',
          'A Exa limitou a taxa de requisições (429). Aguarde antes de tentar novamente.',
          'exa',
          true,
        )
      case 500:
      case 502:
      case 503:
        return errors.provider(
          'provider_unavailable',
          `A Exa está indisponível (${response.status}). A pesquisa não foi concluída.`,
          'exa',
          true,
        )
      default:
        return errors.provider(
          'provider_unavailable',
          `Falha na Exa (HTTP ${response.status}).${suffix}`,
          'exa',
          response.status >= 500,
        )
    }
  }
}

function normalizeDate(value: string | null | undefined): string | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function readCost(cost: ExaApiResponse['costDollars']): number | null {
  if (typeof cost === 'number' && Number.isFinite(cost)) return cost
  if (cost && typeof cost === 'object' && typeof cost.total === 'number' && Number.isFinite(cost.total)) {
    return cost.total
  }
  return null
}

/** Truthful description of what the provider actually returned. */
function buildContentNotice(results: ExaSearchResult[]): string {
  if (results.length === 0) {
    return 'A Exa não retornou resultados para esta consulta.'
  }
  const withText = results.filter((result) => result.contentAvailability.includes('text')).length
  const withHighlights = results.filter((result) => result.contentAvailability.includes('highlights')).length
  if (withText === results.length) {
    return `Conteúdo integral retornado para ${withText} de ${results.length} resultados.`
  }
  if (withText > 0) {
    return `Conteúdo integral para ${withText} de ${results.length} resultados; os demais trazem apenas trechos${withHighlights > 0 ? ' (highlights) ou metadados' : ' ou metadados'}.`
  }
  return `Nenhum resultado trouxe conteúdo integral; foram retornados apenas títulos, trechos e metadados disponíveis (${results.length} resultados).`
}
