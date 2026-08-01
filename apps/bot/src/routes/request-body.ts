export class RequestBodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Request body must be at most ${maxBytes} bytes.`)
    this.name = 'RequestBodyTooLargeError'
  }
}

/** Reads a small JSON request without buffering beyond the declared limit. */
export async function readJsonWithByteLimit(request: Request, maxBytes: number): Promise<unknown> {
  const contentLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new RequestBodyTooLargeError(maxBytes)
  if (!request.body) return JSON.parse('')

  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let byteLength = 0
  let text = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      byteLength += value.byteLength
      if (byteLength > maxBytes) {
        await reader.cancel()
        throw new RequestBodyTooLargeError(maxBytes)
      }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  }
  finally {
    reader.releaseLock()
  }

  return JSON.parse(text)
}
