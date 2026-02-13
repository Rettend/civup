export class ApiError extends Error {
  constructor(message: string, public status: number, public data?: unknown, public headers?: Headers) {
    super(message)
    this.name = 'ApiError'
  }
}

export type ParseType = 'json' | 'text' | 'blob' | 'arrayBuffer' | 'response'

export interface ApiRequestInit extends Omit<RequestInit, 'body'> {
  body?: unknown
  parse?: ParseType
}

async function request<T>(url: string, init: ApiRequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  let body: RequestInit['body'] | undefined

  if (init.body !== null && init.body !== undefined) {
    if (isBodyInit(init.body)) {
      body = init.body
    }
    else {
      body = JSON.stringify(init.body)
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json')
      }
    }
  }

  const res = await fetch(url, { ...init, headers, body })

  if (!res.ok) {
    let errorMessage = `Request failed with status ${res.status}`
    let errorData: unknown

    try {
      const text = await res.text()
      try {
        const data = JSON.parse(text)
        if (data && typeof data === 'object' && 'error' in data) {
          errorMessage = String(data.error)
        }
        errorData = data
      }
      catch {
        if (text.length < 500) errorMessage = text
      }
    }
    catch {}
    throw new ApiError(errorMessage, res.status, errorData, res.headers)
  }

  if (res.status === 204) return null as T

  const parse = init.parse ?? 'json'
  switch (parse) {
    case 'json': return res.json() as T
    case 'text': return res.text() as T
    case 'blob': return res.blob() as T
    case 'arrayBuffer': return res.arrayBuffer() as T
    case 'response': return res as T
    default: return res.json() as T
  }
}

function isBodyInit(body: unknown): body is RequestInit['body'] {
  return (
    typeof body === 'string'
    || body instanceof FormData
    || body instanceof URLSearchParams
    || body instanceof Blob
    || body instanceof ArrayBuffer
    || ArrayBuffer.isView(body)
  )
}

export const api = {
  get: <T>(url: string, init?: ApiRequestInit) => request<T>(url, { ...init, method: 'GET' }),
  post: <T>(url: string, body: unknown, init?: ApiRequestInit) => request<T>(url, { ...init, method: 'POST', body }),
  put: <T>(url: string, body: unknown, init?: ApiRequestInit) => request<T>(url, { ...init, method: 'PUT', body }),
  delete: <T>(url: string, init?: ApiRequestInit) => request<T>(url, { ...init, method: 'DELETE' }),
}
