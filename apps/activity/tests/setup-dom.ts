import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterEach, mock } from 'bun:test'

import * as LeaderTags from '../src/client/lib/leader-tags'

mock.module('~/client/lib/leader-tags', () => LeaderTags)

GlobalRegistrator.register({
  url: 'http://localhost/',
})

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
  document.body.innerHTML = ''
})
