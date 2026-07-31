import { describe, expect, test } from 'bun:test'
import { MaintenanceQueue } from '../../src/maintenance/maintenance-queue.ts'

describe('maintenance queue', () => {
  test('serializes work and continues after a failure', async () => {
    const queue = new MaintenanceQueue()
    const events: string[] = []
    let releaseFirst: (() => void) | undefined
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = queue.run(async () => {
      events.push('first:start')
      await firstGate
      events.push('first:end')
      throw new Error('failed')
    })
    const firstResult = first.catch(error => error)
    const second = queue.run(async () => {
      events.push('second:start')
      events.push('second:end')
      return 'complete'
    })

    await Promise.resolve()
    expect(events).toEqual(['first:start'])
    releaseFirst?.()

    expect(await firstResult).toEqual(new Error('failed'))
    await expect(second).resolves.toBe('complete')
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
  })
})
