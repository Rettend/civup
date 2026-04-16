import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterEach, mock } from 'bun:test'
import solid from 'vite-plugin-solid'

import * as LeaderTags from '../src/client/lib/leader-tags'

const solidTransformPlugin = solid()
const solidTransform = (
  typeof solidTransformPlugin.transform === 'function'
    ? solidTransformPlugin.transform
    : solidTransformPlugin.transform?.handler
) as ((source: string, id: string, options?: { ssr?: boolean }) => Promise<{ code: string } | null> | { code: string } | null) | undefined

Bun.plugin({
  name: 'activity-solid-tsx-test-transform',
  setup(build) {
    build.onLoad({ filter: /apps[\\/]activity[\\/].*\.tsx$/ }, async (args) => {
      const source = await Bun.file(args.path).text()
      const transformed = solidTransform ? await solidTransform(source, args.path, { ssr: false }) : null
      return {
        contents: typeof transformed === 'string' ? transformed : (transformed?.code ?? source),
        loader: 'ts',
      }
    })
  },
})

const solidWeb = await import('solid-js/web/dist/web.js')

mock.module('solid-js/web', () => solidWeb)
mock.module('~/client/lib/leader-tags', () => LeaderTags)

GlobalRegistrator.register({
  url: 'http://localhost/',
})

const { cleanup } = await import('@solidjs/testing-library')

if (!globalThis.matchMedia) {
  globalThis.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })
}

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

if (!globalThis.requestAnimationFrame) {
  let id = 0
  const callbacks = new Map<number, Timer>()

  globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number => {
    const currentId = ++id
    const timer = setTimeout(() => {
      callbacks.delete(currentId)
      callback(Date.now())
    }, 16)
    callbacks.set(currentId, timer)
    return currentId
  }

  globalThis.cancelAnimationFrame = (handle: number): void => {
    const timer = callbacks.get(handle)
    if (timer) {
      clearTimeout(timer)
      callbacks.delete(handle)
    }
  }
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})
