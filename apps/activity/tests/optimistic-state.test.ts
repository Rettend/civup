import { describe, expect, test } from 'bun:test'
import { createRoot, createSignal } from 'solid-js'
import { createOptimisticState } from '../src/client/lib/optimistic-state'

interface TimerConfig {
  banTimerSeconds: number | null
  pickTimerSeconds: number | null
}

function createHarness(initial: TimerConfig) {
  return createRoot((dispose) => {
    const [source] = createSignal(initial)
    const optimistic = createOptimisticState(source, {
      equals: (a, b) => a.banTimerSeconds === b.banTimerSeconds && a.pickTimerSeconds === b.pickTimerSeconds,
    })

    return {
      optimistic,
      dispose,
    }
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('createOptimisticState', () => {
  test('keeps pending optimistic state after successful persist', async () => {
    const harness = createHarness({ banTimerSeconds: 60, pickTimerSeconds: 90 })
    const nextValue = { banTimerSeconds: 120, pickTimerSeconds: 150 }

    const committed = await harness.optimistic.commit(nextValue, async () => {})
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

    expect(committed).toBe(true)
    expect(harness.optimistic.status()).toBe('pending')

    await sleep(25)

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
    expect(secondCommitted).toBe(true)
    expect(harness.optimistic.status()).toBe('pending')
    expect(harness.optimistic.pending()).toEqual(secondValue)

    rejectFirst(new Error('stale failure'))
    const firstCommitted = await firstCommit

    expect(firstCommitted).toBe(false)
    expect(harness.optimistic.status()).toBe('pending')
    expect(harness.optimistic.error()).toBeNull()

    harness.dispose()
  })
})
