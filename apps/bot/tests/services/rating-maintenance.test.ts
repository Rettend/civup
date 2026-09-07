import { expect, test } from 'bun:test'
import { acquireRatingMutation, changeRatingMaintenanceState, markRatingMutationUncertain, releaseRatingMutation, runUnbufferedRatingMutation, withinRatingMutation } from '../../src/services/season/maintenance.ts'
import { createTestDatabase } from '../helpers/test-env.ts'

test('the reporting pause refuses new writes and waits for admitted writes before reopening', async () => {
  const { db, sqlite } = await createTestDatabase()
  try {
    const writer = await acquireRatingMutation(db, 'already-running')
    expect(writer).not.toBeNull()
    await changeRatingMaintenanceState(db, 0, 'paused')
    expect(await acquireRatingMutation(db, 'new-report')).toBeNull()
    expect(await runUnbufferedRatingMutation(db, 'correction', async () => 'must not execute')).toEqual({ error: expect.stringContaining('setup') })
    expect(await withinRatingMutation(writer!.id, () => runUnbufferedRatingMutation(db, 'nested-replay', async () => 'finished'))).toBe('finished')
    await expect(changeRatingMaintenanceState(db, 1, 'open')).rejects.toThrow()
    await releaseRatingMutation(db, writer!.id)
    await changeRatingMaintenanceState(db, 1, 'open')
    await expect(changeRatingMaintenanceState(db, 1, 'paused')).rejects.toThrow()
    await runUnbufferedRatingMutation(db, 'unconfirmed-report', async () => {
      markRatingMutationUncertain()
      return { error: 'The report service caught an uncertain database response.' }
    })
    await changeRatingMaintenanceState(db, 2, 'paused')
    await expect(changeRatingMaintenanceState(db, 3, 'open')).rejects.toThrow()
  }
  finally { sqlite.close() }
})
