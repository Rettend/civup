import { verifyDraftRoomAccessToken } from '@civup/utils'
import { describe, expect, test } from 'bun:test'
import {
  clearActivityMappings,
  clearLobbyMappings,
  getMatchForUser,
  getUserActivityTarget,
  storeMatchMapping,
  storeUserActivityTarget,
  storeUserLobbyMappings,
  storeUserMatchMappings,
} from '../../src/services/activity/index.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

describe('activity mapping behavior', () => {
  test('channel-scoped activity target resolves for lobby and spectator selection', async () => {
    const { kv } = createTrackedKv()

    await storeUserActivityTarget(kv, 'channel-1', ['spectator-1'], { kind: 'lobby', id: 'lobby-1' })

    await expect(getUserActivityTarget(kv, 'channel-1', 'spectator-1')).resolves.toEqual({
      kind: 'lobby',
      id: 'lobby-1',
      pendingJoin: false,
      selectedAt: expect.any(Number),
    })
  })

  test('channel-scoped activity target preserves pending lobby joins', async () => {
    const { kv } = createTrackedKv()

    await storeUserActivityTarget(kv, 'channel-1', ['player-1'], { kind: 'lobby', id: 'lobby-1', pendingJoin: true })

    await expect(getUserActivityTarget(kv, 'channel-1', 'player-1')).resolves.toEqual({
      kind: 'lobby',
      id: 'lobby-1',
      pendingJoin: true,
      selectedAt: expect.any(Number),
    })
  })

  test('match activity targets store room access tokens and match context', async () => {
    const { kv } = createTrackedKv()

    await storeUserActivityTarget(kv, 'channel-1', ['user-1'], {
      kind: 'match',
      id: 'match-1',
      lobbyId: 'lobby-1',
      mode: '2v2',
      steamLobbyLink: 'steam://joinlobby/289070/12345678901234567/76561198000000000',
      activitySecret: 'secret',
    })

    const stored = await kv.get('activity-target-user:user-1:channel-1', 'json') as {
      kind?: unknown
      id?: unknown
      roomAccessToken?: unknown
      lobbyId?: unknown
      mode?: unknown
      steamLobbyLink?: unknown
    } | null

    expect(stored).toEqual(expect.objectContaining({
      kind: 'match',
      id: 'match-1',
      lobbyId: 'lobby-1',
      mode: '2v2',
      steamLobbyLink: 'steam://joinlobby/289070/12345678901234567/76561198000000000',
      roomAccessToken: expect.any(String),
    }))
    await expect(verifyDraftRoomAccessToken('secret', stored?.roomAccessToken as string, {
      roomId: 'match-1',
      userId: 'user-1',
    })).resolves.not.toBeNull()
  })

  test('getMatchForUser resolves active mapping', async () => {
    const { kv } = createTrackedKv()

    await storeMatchMapping(kv, 'channel-1', 'match-1')
    await storeUserMatchMappings(kv, ['user-1'], 'match-1')

    await expect(getMatchForUser(kv, 'user-1')).resolves.toBe('match-1')
  })

  test('getMatchForUser removes stale user mapping when match mapping is gone', async () => {
    const { kv, operations, resetOperations } = createTrackedKv()

    await storeMatchMapping(kv, 'channel-1', 'match-1')
    await storeUserMatchMappings(kv, ['user-1'], 'match-1')
    await clearActivityMappings(kv, 'match-1', ['user-1'], 'channel-1')

    resetOperations()
    await expect(getMatchForUser(kv, 'user-1')).resolves.toBeNull()

    const staleCleanupDeletes = operations.filter(op => op.type === 'delete' && op.key === 'activity-user:user-1')
    expect(staleCleanupDeletes).toHaveLength(0)
  })

  test('clearActivityMappings removes match and user-target mappings eagerly', async () => {
    const { kv, operations, resetOperations } = createTrackedKv()

    await storeMatchMapping(kv, 'channel-1', 'match-1')
    await storeUserMatchMappings(kv, ['user-1', 'user-2'], 'match-1')
    await storeUserActivityTarget(kv, 'channel-1', ['user-1', 'user-2'], { kind: 'match', id: 'match-1' })

    resetOperations()
    await clearActivityMappings(kv, 'match-1', ['user-1', 'user-2'], 'channel-1')

    const deleteKeys = operations.filter(op => op.type === 'delete').map(op => op.key)
    expect(deleteKeys).toContain('activity-match:match-1')
    expect(deleteKeys).toContain('activity-user:user-1')
    expect(deleteKeys).toContain('activity-user:user-2')
    expect(deleteKeys).toContain('activity-target-user:user-1:channel-1')
    expect(deleteKeys).toContain('activity-target-user:user-2:channel-1')
  })

  test('clearLobbyMappings removes lobby reopen mapping and channel target', async () => {
    const { kv, operations, resetOperations } = createTrackedKv()

    await storeUserLobbyMappings(kv, ['user-1'], 'lobby-1')
    await storeUserActivityTarget(kv, 'channel-1', ['user-1'], { kind: 'lobby', id: 'lobby-1' })

    resetOperations()
    await clearLobbyMappings(kv, ['user-1'], 'channel-1')

    const deleteKeys = operations.filter(op => op.type === 'delete').map(op => op.key)
    expect(deleteKeys).toContain('activity-lobby-user:user-1')
    expect(deleteKeys).toContain('activity-target-user:user-1:channel-1')
  })
})
