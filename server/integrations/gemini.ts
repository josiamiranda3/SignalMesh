import type { AppConfig } from '../config.ts'
import { errors } from '../lib/errors.ts'
import { GEMINI_RESPONSE_SCHEMA, validateAnalysisPayload, type AnalysisPayload } from '../../shared/analysis.ts'
import type { AnalysisUsage } from '../../shared/domain.ts'

/**
 * Google Gemini integration.
 *
 * Uses the public Generative Language REST API
 * (`POST {base}/models/{model}:generateContent`), authenticated with the
 * `x-goog-api-key` header. The key lives only in the backend environment; the
 * browser never sees it.
 *
 * Structured output is requested with `responseMimeType: application/json`
 * plus `responseSchema`, and the returned JSON is still validated against our
 * own contract because a provider honouring a schema is not a security
 * boundary — the model may still cite evidence ids that do not exist.
 *
 * No automatic retries: a 429 or 5xx is reported to the caller, which keeps the
 * free tier from being burned by retry loops.
 */

const MODEL = 'gemini-2.5-flash'

interface GeminiPart {
  text?: string
  thought?: boolean
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[]; role?: string }
  finishReason?: string
}

interface GeminiUsageMetadata {
  promptTokenCount?: number
  candidatesTokenCount?: number
  totalTokenCount?: number
}

interface GeminiResponse {
  candidates?: GeminiCandidate[]
  usageMetadata?: GeminiUsageMetadata
  promptFeedback?: { blockReason?: string }
}

export interface GeminiAnalysisOutcome {
  payload: AnalysisPayload
  citedEvidenceIds: string[]
  model: string
  usage: AnalysisUsage
  raw: Record<string, unknown>
}

export class GeminiClient {
  constructor(private readonly config: AppConfig) {}

  get configured(): boolean {
    return Boolean(this.config.geminiApiKey)
  }

  get model(): string {
    return this.config.geminiModel || MODEL
  }

  assertUsable(): void {
    if (!this.config.externalApisEnabled) {
      throw errors.externalDisabled(
        'As chamadas a provedores externos estão desativadas. Defina ENABLE_EXTERNAL_APIS=true para habilitar análises.',
      )
    }
    if (!this.config.geminiApiKey) {
      throw errors.externalDisabled(
        'GEMINI_API_KEY não está configurada. A análise por IA permanece indisponível até que a chave seja definida no backend.',
      )
    }
  }

  async analyze(input: {
    systemInstruction: string
    userPrompt: string
    allowedEvidenceIds: readonly string[]
  }): Promise<GeminiAnalysisOutcome> {
    this.assertUsable()

    const url = `${this.config.geminiBaseUrl.replace(/\/+$/, '')}/models/${encodeURIComponent(this.model)}:generateContent`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.geminiTimeoutMs)
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': this.config.geminiApiKey as string,
          accept: 'application/json',
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: input.systemInstruction }] },
          contents: [{ role: 'user', parts: [{ text: input.userPrompt }] }],
          generationConfig: {
            temperature: this.config.geminiTemperature,
            maxOutputTokens: this.config.geminiMaxOutputTokens,
            responseMimeType: 'application/json',
            responseSchema: GEMINI_RESPONSE_SCHEMA,
          },
        }),
        signal: controller.signal,
      })
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        throw errors.provider(
          'provider_timeout',
          `A análise excedeu ${Math.round(this.config.geminiTimeoutMs / 1000)}s.`,
          'gemini',
          true,
          error,
        )
      }
      throw errors.provider('provider_unavailable', 'Não foi possível contactar o Gemini.', 'gemini', true, error)
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) throw await this.mapHttpError(response)

    let body: GeminiResponse
    try {
      body = (await response.json()) as GeminiResponse
    } catch (error) {
      throw errors.provider(
        'invalid_provider_response',
        'O Gemini retornou uma resposta que não é JSON válido.',
        'gemini',
        false,
        error,
      )
    }

    if (body.promptFeedback?.blockReason) {
      throw errors.provider(
        'invalid_provider_response',
        `O Gemini bloqueou a requisição (${body.promptFeedback.blockReason}). Ajuste as evidências e tente novamente.`,
        'gemini',
      )
    }

    const candidate = body.candidates?.[0]
    const finishReason = candidate?.finishReason
    if (finishReason && finishReason !== 'STOP') {
      const explanation: Record<string, string> = {
        MAX_TOKENS: 'a resposta excedeu o limite de tokens e foi truncada',
        SAFETY: 'a resposta foi bloqueada por políticas de segurança',
        RECITATION: 'a resposta foi bloqueada por recitação de conteúdo',
        PROHIBITED_CONTENT: 'a resposta foi bloqueada por conteúdo proibido',
      }
      throw errors.provider(
        'invalid_provider_response',
        `Análise incompleta: ${explanation[finishReason] ?? `motivo ${finishReason}`}.`,
        'gemini',
      )
    }

    const text = (candidate?.content?.parts ?? [])
      .filter((part) => part.text && !part.thought)
      .map((part) => part.text as string)
      .join('')
      .trim()

    if (!text) {
      throw errors.provider('invalid_provider_response', 'O Gemini retornou resposta vazia.', 'gemini')
    }

    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(stripCodeFence(text))
    } catch (error) {
      throw errors.provider(
        'invalid_provider_response',
        'O Gemini não retornou JSON válido para o schema solicitado.',
        'gemini',
        false,
        error,
      )
    }

    // Throws AnalysisValidationError when the output is malformed OR cites an
    // evidence id that was not sent. The caller records the failure honestly.
    const { payload, citedEvidenceIds } = validateAnalysisPayload(parsedJson, {
      allowedEvidenceIds: input.allowedEvidenceIds,
    })

    return {
      payload,
      citedEvidenceIds,
      model: this.model,
      usage: {
        promptTokens: body.usageMetadata?.promptTokenCount ?? null,
        candidateTokens: body.usageMetadata?.candidatesTokenCount ?? null,
        totalTokens: body.usageMetadata?.totalTokenCount ?? null,
      },
      raw: parsedJson as Record<string, unknown>,
    }
  }

  private async mapHttpError(response: Response): Promise<Error> {
    let detail = ''
    try {
      const body = (await response.json()) as {
        error?: { message?: string; status?: string; code?: number }
      }
      detail = body.error?.message ?? ''
    } catch {
      detail = ''
    }
    const suffix = detail ? ` Detalhe: ${detail.slice(0, 240)}` : ''

    switch (response.status) {
      case 400:
        return errors.provider(
          'invalid_provider_response',
          `O Gemini rejeitou a requisição.${suffix}`,
          'gemini',
        )
      case 401:
      case 403:
        return errors.provider(
          'provider_auth_failed',
          `A chave do Gemini foi recusada (${response.status}). Verifique GEMINI_API_KEY no backend.${suffix}`,
          'gemini',
        )
      case 404:
        return errors.provider(
          'invalid_provider_response',
          `Modelo "${this.model}" não encontrado ou indisponível para esta chave.${suffix}`,
          'gemini',
        )
      case 429:
        return errors.provider(
          'provider_rate_limited',
          'O Gemini limitou a taxa de requisições (429). Aguarde o ciclo de cota antes de tentar novamente.',
          'gemini',
          true,
        )
      case 500:
      case 502:
      case 503:
        return errors.provider(
          'provider_unavailable',
          `O Gemini está indisponível (${response.status}).`,
          'gemini',
          true,
        )
      default:
        return errors.provider(
          'provider_unavailable',
          `Falha no Gemini (HTTP ${response.status}).${suffix}`,
          'gemini',
          response.status >= 500,
        )
    }
  }
}

function stripCodeFence(text: string): string {
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced?.[1] ?? text
}
