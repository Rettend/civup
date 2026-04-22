type FetchHandler = (request: Request) => Promise<Response | undefined> | Response | undefined

const originalFetch = globalThis.fetch.bind(globalThis)
const handlers: Array<{ id: symbol, handler: FetchHandler }> = []

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init)

  for (let index = handlers.length - 1; index >= 0; index--) {
    const registered = handlers[index]
    if (!registered) continue

    const response = await registered.handler(request.clone())
    if (response) return response
  }

  return originalFetch(input as any, init)
}) as typeof fetch

/** Install a composable fetch handler for test-only network interception. */
export function installFetchHandler(handler: FetchHandler): () => void {
  const id = Symbol('test-fetch-handler')
  handlers.push({ id, handler })

  return () => {
    const index = handlers.findIndex(entry => entry.id === id)
    if (index >= 0) handlers.splice(index, 1)
  }
}
