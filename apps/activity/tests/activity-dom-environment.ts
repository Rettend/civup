import type { Environment } from 'vitest/runtime'
import { builtinEnvironments } from 'vitest/runtime'

// Keep the native HTTP/body APIs together. Happy DOM supplies the DOM, not
// replacements for the streamed Worker responses and ZIP bodies under test.
const nativeKeys = [
  'fetch', 'Headers', 'Request', 'Response', 'Blob', 'File', 'FormData',
  'ReadableStream', 'TransformStream', 'WritableStream',
  'AbortController', 'AbortSignal',
] as const

export default {
  name: 'activity-dom',
  viteEnvironment: 'client',
  async setup(global, options) {
    const nativeDescriptors = nativeKeys.map(key => [key, Object.getOwnPropertyDescriptor(global, key)] as const)
    const environment = await builtinEnvironments['happy-dom'].setup(global, options)
    for (const [key, descriptor] of nativeDescriptors) {
      if (descriptor) Object.defineProperty(global, key, descriptor)
    }
    const NativeRequest = global.Request as typeof Request
    // Workers accept stream request bodies without Node's required duplex flag.
    global.Request = class extends NativeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit & { duplex?: 'half' }) {
        const requestInit: (RequestInit & { duplex?: 'half' }) | undefined = init?.body instanceof global.ReadableStream
          ? { ...init, duplex: 'half' }
          : init
        super(input, requestInit)
      }
    }
    return environment
  },
} satisfies Environment
