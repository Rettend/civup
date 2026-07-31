import { describe, expect, test } from 'bun:test'
import {
  clearLeaderboardDirtyState,
  clearSystemChannel,
  getLeaderboardDirtyState,
  markLeaderboardDirty,
  getSystemChannel,
  setSystemChannel,
} from '../../src/services/system/channels.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

describe('leaderboard dirty state', () => {
  test('markLeaderboardDirty only writes once while dirty', async () => {
    const { kv, operations, resetOperations } = createTrackedKv({ trackReads: true })

    const first = await markLeaderboardDirty(kv, 'report')
    resetOperations()
    const second = await markLeaderboardDirty(kv, 'report-again')

    expect(second.dirtyAt).toBe(first.dirtyAt)
    expect(second.reason).toBe(first.reason)
    expect(operations).toHaveLength(1)
    expect(operations[0]?.type).toBe('get')
  })

  test('clearLeaderboardDirtyState removes dirty marker', async () => {
    const { kv } = createTrackedKv()

    await markLeaderboardDirty(kv, 'report')
    expect(await getLeaderboardDirtyState(kv)).not.toBeNull()

    await clearLeaderboardDirtyState(kv)
    expect(await getLeaderboardDirtyState(kv)).toBeNull()
  })
})

describe('guild-scoped system channels', () => {
  test('falls back to shipped global keys only for the legacy primary guild', async () => {
    const { kv } = createTrackedKv()
    await kv.put('system:channel:draft', 'legacy-channel')
    await setSystemChannel(kv, 'draft', 'partner-channel', '222222222222222222')

    expect(await getSystemChannel(kv, 'draft', { guildId: '111111111111111111', legacyGuildId: '111111111111111111' })).toBe('legacy-channel')
    expect(await getSystemChannel(kv, 'draft', { guildId: '222222222222222222', legacyGuildId: '111111111111111111' })).toBe('partner-channel')
    expect(await getSystemChannel(kv, 'draft', { guildId: '333333333333333333', legacyGuildId: '111111111111111111' })).toBeNull()
    expect(await getSystemChannel(kv, 'draft', { guildId: '333333333333333333' })).toBeNull()
  })

  test('keeps a primary scoped clear from reviving the legacy global value', async () => {
    const { kv } = createTrackedKv()
    await kv.put('system:channel:draft', 'legacy-channel')
    await setSystemChannel(kv, 'draft', 'scoped-channel', '111111111111111111')
    await clearSystemChannel(kv, 'draft', '111111111111111111')

    expect(await getSystemChannel(kv, 'draft', {
      guildId: '111111111111111111',
      legacyGuildId: '111111111111111111',
    })).toBeNull()
  })
})
