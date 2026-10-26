/**
 * The one place the browser talks to the API.
 *
 * - The session lives in an HttpOnly cookie the browser manages; JavaScript can't read it.
 * - The CSRF token is kept in memory only (never localStorage/sessionStorage) and is
 *   re-fetched from /api/auth/me after a page reload.
 * - Errors are reduced to a small, safe shape; response bodies are never logged.
 */
const BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/+$/, '') ?? 'http://localhost:3000'

let csrfToken: string | null = null
export const setCsrfToken = (token: string | null) => {
  csrfToken = token
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: unknown
  constructor(status: number, code: string, details?: unknown) {
    super(code)
    this.status = status
    this.code = code
    this.details = details
  }
}

let onUnauthorized: (() => void) | null = null
/** AuthProvider registers this so any 401 from a protected call signs the user out in the UI. */
export const setUnauthorizedHandler = (fn: (() => void) | null) => {
  onUnauthorized = fn
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export async function api<T = void>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal; skipUnauthorizedHandler?: boolean } = {},
): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase()
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (UNSAFE.has(method) && csrfToken) headers['X-CSRF-Token'] = csrfToken

  let response: Response
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      credentials: 'include',
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      signal: options.signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw new ApiError(0, 'network_error')
  }

  if (response.status === 204) return undefined as T

  let payload: unknown = null
  try {
    payload = await response.json()
  } catch {
    /* empty or non-JSON body */
  }

  if (!response.ok) {
    const code = typeof (payload as { error?: unknown })?.error === 'string' ? (payload as { error: string }).error : 'request_failed'
    if (response.status === 401 && !options.skipUnauthorizedHandler) onUnauthorized?.()
    throw new ApiError(response.status, code, payload)
  }
  return payload as T
}
