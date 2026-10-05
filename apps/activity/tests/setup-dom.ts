import { cleanup } from '@solidjs/testing-library'
import { afterEach, beforeEach, vi } from 'vitest'

Object.assign(globalThis, { __ASSET_REVISION_MAP__: {} })

// Keep request-host transport selection identical to the Worker tests on Bun.
vi.stubEnv('DEV', false)

const rejectUnexpectedFetch: typeof fetch = async input => {
  throw new Error(`Unexpected network request in Activity test: ${String(input)}`)
}
vi.stubGlobal('fetch', rejectUnexpectedFetch)
beforeEach(() => vi.stubGlobal('fetch', rejectUnexpectedFetch))

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  localStorage.clear()
  sessionStorage.clear()
  vi.useRealTimers()
})
