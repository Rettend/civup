export class ApiError extends Error {
  constructor(message: string, public status: number, public data?: unknown) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers)
  if (!headers.has('Content-Type') && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
  }
  const res = await fetch(url, { ...init, headers })
  if (!res.ok) {
    let errorMessage = `Request failed with status ${res.status}`
    let errorData: unknown
    try {
      const data = await res.json() as { error?: string }
      if (data.error) errorMessage = data.error
      errorData = data
    }
    catch {}
    throw new ApiError(errorMessage, res.status, errorData)
  }
  if (res.status === 204) return null as T
  return res.json() as T
}

export const api = {
  get: <T>(url: string, init?: RequestInit) => request<T>(url, { ...init, method: 'GET' }),
  post: <T>(url: string, body: unknown, init?: RequestInit) =>
    request<T>(url, {
      ...init,
      method: 'POST',
      body: JSON.stringify(body),
    }),
  put: <T>(url: string, body: unknown, init?: RequestInit) =>
    request<T>(url, {
      ...init,
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  delete: <T>(url: string, init?: RequestInit) => request<T>(url, { ...init, method: 'DELETE' }),
}
