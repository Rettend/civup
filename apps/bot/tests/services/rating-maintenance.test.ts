import { bufferedReportDirectory } from '@civup/db'
import { expect, test } from 'bun:test'
import { acquireRatingMutation, changeRatingMaintenanceState, releaseRatingMutation, runUnbufferedRatingMutation, withinRatingMutation } from '../../src/services/season/maintenance.ts'
import { createTestDatabase } from '../helpers/test-env.ts'

test('maintenance buffers new work, waits for admitted writers and saved reports, and allows admitted nested replay to finish', async () => {
  const { db, sqlite } = await createTestDatabase()
  try {
    const writer = await acquireRatingMutation(db, 'already-running')
    expect(writer.kind).toBe('rating')
    await changeRatingMaintenanceState(db, 0, 'buffering')
    await expect(changeRatingMaintenanceState(db, 1, 'draining')).rejects.toThrow('accepted work remains')
    expect(await withinRatingMutation(writer.id, () => runUnbufferedRatingMutation(db, 'nested-replay', async () => 'finished'))).toBe('finished')
    expect(await runUnbufferedRatingMutation(db, 'moderator-correction', async () => 'must not execute')).toEqual({ error: expect.stringContaining('maintenance') })
    const publication = await acquireRatingMutation(db, 'new-report')
    expect(publication.kind).toBe('buffer')
    await releaseRatingMutation(db, writer.id)
    await expect(changeRatingMaintenanceState(db, 1, 'draining')).rejects.toThrow()
    await db.insert(bufferedReportDirectory).values({ matchId: 'new-report', reportId: 'saved-in-session', acceptedAt: 10 })
    await releaseRatingMutation(db, publication.id)
    await changeRatingMaintenanceState(db, 1, 'draining')
    await expect(changeRatingMaintenanceState(db, 2, 'open')).rejects.toThrow()
    const drain = await acquireRatingMutation(db, 'new-report', true)
    expect(drain.kind).toBe('rating')
    await db.delete(bufferedReportDirectory)
    await expect(changeRatingMaintenanceState(db, 2, 'open')).rejects.toThrow()
    await releaseRatingMutation(db, drain.id)
    await changeRatingMaintenanceState(db, 2, 'open')
    await expect(changeRatingMaintenanceState(db, 2, 'buffering')).rejects.toThrow()
  }
  finally { sqlite.close() }
})
