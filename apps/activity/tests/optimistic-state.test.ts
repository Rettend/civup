import { createRoot, createSignal, flush } from 'solid-js'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createOptimisticState } from '../src/client/lib/optimistic-state'

interface TimerConfig {
  banTimerSeconds: number | null
  pickTimerSeconds: number | null
}

const disposers: (() => void)[] = []

function createHarness(initial: TimerConfig) {
  const harness = createRoot(dispose => {
    const [source, setSource] = createSignal(initial)
    const optimistic = createOptimisticState(source, {
      equals: (a, b) => a.banTimerSeconds === b.banTimerSeconds && a.pickTimerSeconds === b.pickTimerSeconds,
    })

    return {
      optimistic,
      setSource,
      dispose,
    }
  })
  disposers.push(harness.dispose)
  flush()
  return harness
}

describe('createOptimisticState', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose()
    flush()
  })

  test('keeps pending optimistic state after successful persist', async () => {
    const harness = createHarness({ banTimerSeconds: 60, pickTimerSeconds: 90 })
    const nextValue = { banTimerSeconds: 120, pickTimerSeconds: 150 }

    const committed = await harness.optimistic.commit(nextValue, async () => {})
    flush()
    expect(committed).toBe(true)
    expect(harness.optimistic.status()).toBe('pending')
    expect(harness.optimistic.pending()).toEqual(nextValue)

    harness.dispose()
  })

  test('reverts and exposes error when persist fails', async () => {
    const initial = { banTimerSeconds: 60, pickTimerSeconds: 90 }
    const harness = createHarness(initial)
    const nextValue = { banTimerSeconds: 120, pickTimerSeconds: 150 }

    const committed = await harness.optimistic.commit(nextValue, async () => {
      throw new Error('boom')
    })

    flush()
    expect(committed).toBe(false)
    expect(harness.optimistic.status()).toBe('error')
    expect(harness.optimistic.error()).toBe('boom')
    expect(harness.optimistic.pending()).toBeNull()
    expect(harness.optimistic.value()).toEqual(initial)

    harness.dispose()
  })

  test('marks error after sync timeout when source never updates', async () => {
    const initial = { banTimerSeconds: 60, pickTimerSeconds: 90 }
    const harness = createHarness(initial)
    const nextValue = { banTimerSeconds: 120, pickTimerSeconds: 150 }

    const committed = await harness.optimistic.commit(nextValue, async () => {}, {
      syncTimeoutMs: 10,
      syncTimeoutMessage: 'timed out',
    })

    flush()
    expect(committed).toBe(true)
    expect(harness.optimistic.status()).toBe('pending')

    await vi.advanceTimersByTimeAsync(10)

    flush()
    expect(harness.optimistic.status()).toBe('error')
    expect(harness.optimistic.error()).toBe('timed out')
    expect(harness.optimistic.pending()).toBeNull()
    expect(harness.optimistic.value()).toEqual(initial)

    harness.dispose()
  })

  test('ignores stale commit failures when a newer commit exists', async () => {
    const harness = createHarness({ banTimerSeconds: 60, pickTimerSeconds: 90 })
    const firstValue = { banTimerSeconds: 120, pickTimerSeconds: 150 }
    const secondValue = { banTimerSeconds: 180, pickTimerSeconds: 210 }

    let rejectFirst!: (error: unknown) => void
    const firstPersist = new Promise<void>((_, reject) => {
      rejectFirst = reject
    })

    const firstCommit = harness.optimistic.commit(firstValue, async () => firstPersist)
    const secondCommit = harness.optimistic.commit(secondValue, async () => {})

    const secondCommitted = await secondCommit
    flush()
    expect(secondCommitted).toBe(true)
    expect(harness.optimistic.status()).toBe('pending')
    expect(harness.optimistic.pending()).toEqual(secondValue)

    rejectFirst(new Error('stale failure'))
    const firstCommitted = await firstCommit

    flush()
    expect(firstCommitted).toBe(false)
    expect(harness.optimistic.status()).toBe('pending')
    expect(harness.optimistic.error()).toBeNull()

    harness.dispose()
  })

  test('clears a pending value and its timeout when the server acknowledges it', async () => {
    const harness = createHarness({ banTimerSeconds: 60, pickTimerSeconds: 90 })
    const next = { banTimerSeconds: 120, pickTimerSeconds: 150 }
    await harness.optimistic.commit(next, async () => {})
    flush()
    expect(vi.getTimerCount()).toBe(1)
    harness.setSource({ ...next })
    flush()
    expect(harness.optimistic.pending()).toBeNull()
    expect(harness.optimistic.status()).toBe('idle')
    expect(harness.optimistic.value()).toEqual(next)
    expect(vi.getTimerCount()).toBe(0)
  })

  test('does not let an older acknowledgement or timeout clear a newer edit', async () => {
    const harness = createHarness({ banTimerSeconds: 60, pickTimerSeconds: 90 })
    const first = { banTimerSeconds: 120, pickTimerSeconds: 150 }
    const second = { banTimerSeconds: 180, pickTimerSeconds: 210 }
    await harness.optimistic.commit(first, async () => {}, { syncTimeoutMs: 10 })
    await harness.optimistic.commit(second, async () => {}, { syncTimeoutMs: 30 })
    harness.setSource(first)
    flush()
    await vi.advanceTimersByTimeAsync(10)
    flush()
    expect(harness.optimistic.status()).toBe('pending')
    expect(harness.optimistic.value()).toEqual(second)
    harness.setSource(second)
    flush()
    expect(harness.optimistic.status()).toBe('idle')
    expect(vi.getTimerCount()).toBe(0)
  })

  test('stores function values without invoking them as signal updaters', async () => {
    const initial = vi.fn(() => 'initial')
    const next = vi.fn(() => 'next')
    const harness = createRoot(dispose => {
      const [source, setSource] = createSignal({ fn: initial })
      return { setSource, optimistic: createOptimisticState(() => source().fn), dispose }
    })
    disposers.push(harness.dispose)
    flush()
    await harness.optimistic.commit(next, async () => {})
    flush()
    expect(harness.optimistic.value()).toBe(next)
    expect(initial).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
    harness.setSource({ fn: next })
    flush()
    expect(harness.optimistic.pending()).toBeNull()
    expect(harness.optimistic.value()).toBe(next)
    expect(next).not.toHaveBeenCalled()
  })

  test('disposal cancels scheduled work and rejects an in-flight completion', async () => {
    const harness = createHarness({ banTimerSeconds: 60, pickTimerSeconds: 90 })
    await harness.optimistic.commit({ banTimerSeconds: 120, pickTimerSeconds: 150 }, async () => {})
    flush()
    expect(vi.getTimerCount()).toBe(1)
    let finish!: () => void
    const pending = harness.optimistic.commit(
      { banTimerSeconds: 180, pickTimerSeconds: 210 },
      () =>
        new Promise(resolve => {
          finish = resolve
        }),
    )
    flush()
    harness.dispose()
    expect(vi.getTimerCount()).toBe(0)
    finish()
    expect(await pending).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})
