import type { ApiErrorCode, ApiErrorPayload } from '../../shared/api.ts'

/**
 * Typed application errors.
 *
 * Services throw these; the HTTP layer is the only place that turns them into
 * responses. That keeps business rules free of status codes and guarantees that
 * unexpected exceptions never leak stack traces or internal details.
 */
export class AppError extends Error {
  readonly code: ApiErrorCode
  readonly status: number
  readonly details?: Array<{ path: string; message: string }>
  readonly provider?: string
  readonly retryable: boolean

  constructor(
    code: ApiErrorCode,
    message: string,
    options: {
      status?: number
      details?: Array<{ path: string; message: string }>
      provider?: string
      retryable?: boolean
      cause?: unknown
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'AppError'
    this.code = code
    this.status = options.status ?? defaultStatus(code)
    this.details = options.details
    this.provider = options.provider
    this.retryable = options.retryable ?? false
  }

  toPayload(): ApiErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
      ...(this.provider ? { provider: this.provider } : {}),
      retryable: this.retryable,
    }
  }
}

function defaultStatus(code: ApiErrorCode): number {
  switch (code) {
    case 'invalid_request':
      return 400
    case 'unauthorized':
      return 401
    case 'forbidden':
      return 403
    case 'not_found':
      return 404
    case 'conflict':
      return 409
    case 'rate_limited':
      return 429
    case 'quota_exceeded':
      return 429
    case 'external_disabled':
      return 503
    case 'provider_auth_failed':
      return 502
    case 'provider_rate_limited':
      return 429
    case 'provider_unavailable':
      return 502
    case 'provider_timeout':
      return 504
    case 'invalid_provider_response':
      return 502
    default:
      return 500
  }
}

export const errors = {
  unauthorized: (message = 'Autenticação necessária') => new AppError('unauthorized', message),
  forbidden: (message = 'Acesso negado a este recurso') => new AppError('forbidden', message),
  notFound: (message = 'Recurso não encontrado') => new AppError('not_found', message),
  conflict: (message: string) => new AppError('conflict', message),
  invalid: (message: string, details?: Array<{ path: string; message: string }>) =>
    new AppError('invalid_request', message, details ? { details } : {}),
  rateLimited: (message: string) => new AppError('rate_limited', message, { retryable: true }),
  quotaExceeded: (message: string) => new AppError('quota_exceeded', message),
  externalDisabled: (message: string) => new AppError('external_disabled', message),
  provider: (
    code: Extract<ApiErrorCode, `provider_${string}` | 'invalid_provider_response'>,
    message: string,
    provider: string,
    retryable = false,
    cause?: unknown,
  ) => new AppError(code, message, { provider, retryable, cause }),
  internal: (message = 'Erro interno inesperado', cause?: unknown) =>
    new AppError('internal_error', message, { cause }),
}
