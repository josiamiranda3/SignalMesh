import type { ApiErrorPayload, ApiResponse } from '@shared/api'

/**
 * Typed API client.
 *
 * One place handles: JSON encoding, the CSRF header, credentials, envelope
 * unwrapping, and turning every failure into a single `ApiError` shape the UI
 * can render. Errors never leak a raw fetch exception to a component.
 */

export class ApiError extends Error {
  readonly code: ApiErrorPayload['code'] | 'network_error'
  readonly status: number
  readonly details?: Array<{ path: string; message: string }>
  readonly provider?: string
  readonly retryable: boolean

  constructor(payload: {
    code: ApiErrorPayload['code'] | 'network_error'
    message: string
    status: number
    details?: Array<{ path: string; message: string }>
    provider?: string
    retryable?: boolean
  }) {
    super(payload.message)
    this.name = 'ApiError'
    this.code = payload.code
    this.status = payload.status
    this.details = payload.details
    this.provider = payload.provider
    this.retryable = payload.retryable ?? false
  }

  /** Field-level messages keyed by input path, for forms. */
  fieldErrors(): Record<string, string> {
    const result: Record<string, string> = {}
    for (const detail of this.details ?? []) {
      if (detail.path && detail.path !== '(raiz)' && !result[detail.path]) result[detail.path] = detail.message
    }
    return result
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  query?: Record<string, string | number | boolean | undefined | null>
  signal?: AbortSignal
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  const suffix = params.toString()
  return suffix ? `${path}?${suffix}` : path
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET'
  const headers: Record<string, string> = {
    accept: 'application/json',
    'x-signalmess-request': '1',
  }
  if (options.body !== undefined) headers['content-type'] = 'application/json'

  let response: Response
  try {
    response = await fetch(buildUrl(path, options.query), {
      method,
      headers,
      credentials: 'same-origin',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      ...(options.signal ? { signal: options.signal } : {}),
    })
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error
    throw new ApiError({
      code: 'network_error',
      status: 0,
      message: 'Não foi possível contactar o servidor. Verifique sua conexão e tente novamente.',
      retryable: true,
    })
  }

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    // A non-JSON body means the request never reached the API (proxy/HTML error).
    throw new ApiError({
      code: 'internal_error',
      status: response.status,
      message:
        response.status === 404
          ? 'Recurso não encontrado.'
          : 'O servidor retornou uma resposta inesperada. Tente novamente.',
      retryable: response.status >= 500,
    })
  }

  const payload = (await response.json()) as ApiResponse<T>
  if (!payload.success) {
    throw new ApiError({
      code: payload.error.code,
      message: payload.error.message,
      status: response.status,
      ...(payload.error.details ? { details: payload.error.details } : {}),
      ...(payload.error.provider ? { provider: payload.error.provider } : {}),
      retryable: payload.error.retryable ?? false,
    })
  }

  return payload.data
}

/** Authenticated JSON endpoints. */
export const api = {
  get: <T>(path: string, query?: RequestOptions['query']) => request<T>(path, { query }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body ?? {} }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}

/**
 * File download that respects the server's Content-Disposition filename and
 * surfaces API errors instead of saving an error page as a file.
 */
export async function downloadFile(path: string, query?: RequestOptions['query']): Promise<string> {
  const response = await fetch(buildUrl(path, query), {
    headers: { 'x-signalmess-request': '1' },
    credentials: 'same-origin',
  })

  const contentType = response.headers.get('content-type') ?? ''
  if (!response.ok || contentType.includes('application/json')) {
    const payload = (await response.json().catch(() => null)) as ApiResponse<unknown> | null
    throw new ApiError({
      code: payload && !payload.success ? payload.error.code : 'internal_error',
      status: response.status,
      message:
        payload && !payload.success
          ? payload.error.message
          : 'Não foi possível gerar a exportação. Tente novamente.',
    })
  }

  const blob = await response.blob()
  const disposition = response.headers.get('content-disposition') ?? ''
  const match = /filename="?([^";]+)"?/i.exec(disposition)
  const filename = match?.[1] ?? 'signalmess-export'

  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 4000)
  return filename
}
