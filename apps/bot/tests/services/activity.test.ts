import type { QueueEntry } from '@civup/game'
import { verifyDraftRoomAccessToken } from '@civup/utils'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  clearActivityMappings,
  clearLobbyMappings,
  clearUserLobbyMappings,
  createDraftRoom,
  getLobbyForUser,
  getMatchForUser,
  getUserActivityTarget,
  storeMatchActivityState,
  storeMatchMapping,
  storeUserActivityTarget,
  storeUserLobbyMappings,
  storeUserLobbyState,
  storeUserMatchMappings,
} from '../../src/services/activity/index.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const baseFfaEntries: QueueEntry[] = Array.from({ length: 4 }, (_, index) => ({
  playerId: `p${index + 1}`,
  displayName: `P${index + 1}`,
  joinedAt: index,
}))

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

  test('clearUserLobbyMappings keeps the in-activity target during draft handoff', async () => {
    const { kv } = createTrackedKv()

    await storeUserLobbyState(kv, 'channel-1', ['user-1'], 'lobby-1', { pendingJoin: true })
    await storeMatchActivityState(kv, 'channel-1', ['user-1'], {
      matchId: 'match-1',
      lobbyId: 'lobby-1',
      mode: '2v2',
      activitySecret: 'secret',
    })
    await clearUserLobbyMappings(kv, ['user-1'])

    await expect(getLobbyForUser(kv, 'user-1')).resolves.toBeNull()
    await expect(getUserActivityTarget(kv, 'channel-1', 'user-1')).resolves.toEqual(expect.objectContaining({
      kind: 'match',
      id: 'match-1',
      pendingJoin: false,
      roomAccessToken: expect.any(String),
    }))
  })
})

describe('draft room creation', () => {
  test('uses seat-order FFA by default', async () => {
    let postedConfig: { formatId?: unknown } | null = null
    globalThis.fetch = (async (_input, init) => {
      postedConfig = JSON.parse(String(init?.body)) as { formatId?: unknown }
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const result = await createDraftRoom('ffa', baseFfaEntries, { hostId: 'p1' })

    expect(postedConfig?.formatId).toBe('default-ffa')
    expect(result.formatId).toBe('default-ffa')
  })

  test('uses simultaneous FFA when requested', async () => {
    let postedConfig: { formatId?: unknown } | null = null
    globalThis.fetch = (async (_input, init) => {
      postedConfig = JSON.parse(String(init?.body)) as { formatId?: unknown }
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const result = await createDraftRoom('ffa', baseFfaEntries, {
      hostId: 'p1',
      simultaneousPick: true,
    })

    expect(postedConfig?.formatId).toBe('default-ffa-simultaneous')
    expect(result.formatId).toBe('default-ffa-simultaneous')
  })
})
