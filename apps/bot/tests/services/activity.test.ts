import type { QueueEntry, RoomConfig } from '@civup/game'
import { verifyDraftRoomAccessToken } from '@civup/utils'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  clearActivityMappings,
  clearLobbyMappings,
  clearUserLobbyMappings,
  createDraftRoom,
  getChannelForMatch,
  getLobbyForUser,
  getMatchForUser,
  getUserActivityTarget,
  handoffLobbySpectatorsToMatchActivity,
  storeMatchActivityState,
  storeMatchMapping,
  storeUserActivityTarget,
  storeUserLobbyMappings,
  storeUserLobbyState,
  storeUserMatchMappings,
} from '../../src/services/activity/index.ts'
import { attachLobbyMatch, createLobby, setLobbySlots } from '../../src/services/lobby/index.ts'
import { addToQueue } from '../../src/services/queue/index.ts'
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

function createMainNamespaceStub(handler: (request: Request, roomName: string) => Promise<Response> | Response): DurableObjectNamespace {
  return {
    idFromName(name: string) {
      return name as unknown as DurableObjectId
    },
    get(id: DurableObjectId) {
      const roomName = String(id)
      return {
        fetch(request: Request) {
          return handler(request, roomName)
        },
      } as DurableObjectStub
    },
  } as unknown as DurableObjectNamespace
}

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

  test('switching pending lobby targets in one channel removes the old selection', async () => {
    const { kv } = createTrackedKv()

    await storeUserLobbyState(kv, 'channel-1', ['player-1'], 'lobby-1')
    await storeUserLobbyState(kv, 'channel-1', ['player-1'], 'lobby-2', { pendingJoin: true })

    await expect(getUserActivityTarget(kv, 'channel-1', 'player-1')).resolves.toEqual({
      kind: 'lobby',
      id: 'lobby-2',
      pendingJoin: true,
      selectedAt: expect.any(Number),
    })
    await expect(kv.get('activity-target-lobby:channel-1:lobby-1:player-1')).resolves.toBeNull()
    await expect(kv.get('activity-target-lobby:channel-1:lobby-2:player-1')).resolves.toBeDefined()
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

  test('getMatchForUser repairs a live mapping from the canonical match lobby', async () => {
    const { kv } = createTrackedKv()

    const lobby = await createLobby(kv, {
      mode: '1v1',
      hostId: 'user-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })
    await attachLobbyMatch(kv, lobby.id, 'match-1', lobby)
    await storeUserMatchMappings(kv, ['user-1'], 'match-1')

    await expect(getMatchForUser(kv, 'user-1')).resolves.toBe('match-1')
    await expect(kv.get('activity-match:match-1')).resolves.toBe('channel-1')
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
    expect(deleteKeys).toContain('activity-target-match:channel-1:match-1:user-1')
    expect(deleteKeys).toContain('activity-target-match:channel-1:match-1:user-2')
  })

  test('clearActivityMappings removes spectator match targets discovered via reverse index', async () => {
    const { kv } = createTrackedKv()

    await storeMatchMapping(kv, 'channel-1', 'match-1')
    await storeMatchActivityState(kv, 'channel-1', ['spectator-1'], {
      matchId: 'match-1',
      lobbyId: 'lobby-1',
      mode: '2v2',
      activitySecret: 'secret',
    })

    await clearActivityMappings(kv, 'match-1', ['player-1'], 'channel-1')

    await expect(kv.get('activity-user:spectator-1')).resolves.toBeNull()
    await expect(kv.get('activity-target-user:spectator-1:channel-1')).resolves.toBeNull()
    await expect(kv.get('activity-target-match:channel-1:match-1:spectator-1')).resolves.toBeNull()
  })

  test('clearActivityMappings keeps a newer activity-user mapping for the same player', async () => {
    const { kv } = createTrackedKv()

    const currentLobby = await createLobby(kv, {
      mode: '1v1',
      hostId: 'user-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await storeMatchMapping(kv, 'channel-1', 'match-old')
    await storeUserMatchMappings(kv, ['user-1'], 'match-old')
    await storeMatchActivityState(kv, 'channel-1', ['user-1'], {
      matchId: 'match-old',
      lobbyId: 'lobby-1',
      mode: '1v1',
      activitySecret: 'secret',
    })

    await storeMatchMapping(kv, 'channel-1', 'match-new')
    await storeMatchActivityState(kv, 'channel-1', ['user-1'], {
      matchId: 'match-new',
      lobbyId: currentLobby.id,
      mode: '1v1',
      activitySecret: 'secret',
    })
    await attachLobbyMatch(kv, currentLobby.id, 'match-new', currentLobby)
    await kv.put('activity-target-match:channel-1:match-old:user-1', String(Date.now()))

    await clearActivityMappings(kv, 'match-old', ['user-1'], 'channel-1')

    await expect(getMatchForUser(kv, 'user-1')).resolves.toBe('match-new')
    await expect(getUserActivityTarget(kv, 'channel-1', 'user-1')).resolves.toEqual(expect.objectContaining({
      kind: 'match',
      id: 'match-new',
    }))
    await expect(kv.get('activity-match:match-old')).resolves.toBeNull()
    await expect(kv.get('activity-target-match:channel-1:match-old:user-1')).resolves.toBeNull()
  })

  test('getChannelForMatch repairs the channel mapping from the canonical match lobby', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: '1v1',
      hostId: 'user-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await attachLobbyMatch(kv, lobby.id, 'match-1', lobby)

    await expect(getChannelForMatch(kv, 'match-1')).resolves.toBe('channel-1')
    await expect(kv.get('activity-match:match-1')).resolves.toBe('channel-1')
  })

  test('clearLobbyMappings removes lobby reopen mapping and channel target', async () => {
    const { kv, operations, resetOperations } = createTrackedKv()

    await storeUserLobbyMappings(kv, ['user-1'], 'lobby-1')
    await storeUserActivityTarget(kv, 'channel-1', ['user-1'], { kind: 'lobby', id: 'lobby-1' })

    resetOperations()
    await clearLobbyMappings(kv, ['user-1'], 'channel-1', 'lobby-1')

    const deleteKeys = operations.filter(op => op.type === 'delete').map(op => op.key)
    expect(deleteKeys).toContain('activity-lobby-user:user-1')
    expect(deleteKeys).toContain('activity-target-user:user-1:channel-1')
    expect(deleteKeys).toContain('activity-target-lobby:channel-1:lobby-1:user-1')
  })

  test('clearLobbyMappings removes stale old lobby reverse indexes but preserves a newer open-lobby target', async () => {
    const { kv } = createTrackedKv()

    await storeUserLobbyState(kv, 'channel-1', ['user-1'], 'lobby-old')
    await storeUserLobbyState(kv, 'channel-1', ['user-1'], 'lobby-new')
    await kv.put('activity-target-lobby:channel-1:lobby-old:user-1', String(Date.now()))

    await clearLobbyMappings(kv, ['user-1'], 'channel-1', 'lobby-old')

    await expect(kv.get('activity-lobby-user:user-1')).resolves.toBe('lobby-new')
    await expect(getUserActivityTarget(kv, 'channel-1', 'user-1')).resolves.toEqual(expect.objectContaining({
      kind: 'lobby',
      id: 'lobby-new',
    }))
    await expect(kv.get('activity-target-lobby:channel-1:lobby-old:user-1')).resolves.toBeNull()
  })

  test('switching targets removes the old reverse selection key', async () => {
    const { kv } = createTrackedKv()

    await storeUserActivityTarget(kv, 'channel-1', ['user-1'], { kind: 'lobby', id: 'lobby-1' })
    await storeUserActivityTarget(kv, 'channel-1', ['user-1'], {
      kind: 'match',
      id: 'match-1',
      lobbyId: 'lobby-1',
      mode: '2v2',
      activitySecret: 'secret',
    })

    await expect(kv.get('activity-target-lobby:channel-1:lobby-1:user-1')).resolves.toBeNull()
    await expect(kv.get('activity-target-match:channel-1:match-1:user-1')).resolves.toBeDefined()
  })

  test('handoffLobbySpectatorsToMatchActivity retargets only current lobby spectators', async () => {
    const { kv } = createTrackedKv()

    await storeUserLobbyState(kv, 'channel-1', ['host', 'player-1'], 'lobby-1')
    await storeUserLobbyState(kv, 'channel-1', ['spectator-1', 'spectator-2'], 'lobby-1')
    await storeUserActivityTarget(kv, 'channel-1', ['spectator-1'], { kind: 'lobby', id: 'lobby-2' })

    await expect(handoffLobbySpectatorsToMatchActivity(kv, 'channel-1', 'lobby-1', ['host', 'player-1'], {
      matchId: 'match-1',
      lobbyId: 'lobby-1',
      mode: '2v2',
      activitySecret: 'secret',
    })).resolves.toEqual(['spectator-2'])

    await expect(getUserActivityTarget(kv, 'channel-1', 'spectator-1')).resolves.toEqual(expect.objectContaining({
      kind: 'lobby',
      id: 'lobby-2',
    }))
    await expect(getUserActivityTarget(kv, 'channel-1', 'spectator-2')).resolves.toEqual(expect.objectContaining({
      kind: 'match',
      id: 'match-1',
      pendingJoin: false,
      roomAccessToken: expect.any(String),
    }))
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

  test('getLobbyForUser repairs a stale mapping to the player\'s real open lobby', async () => {
    const { kv } = createTrackedKv()

    const currentLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-current',
    })
    const staleLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-2',
      channelId: 'channel-2',
      messageId: 'message-stale',
    })

    await addToQueue(kv, '2v2', {
      playerId: 'host-1',
      displayName: 'Host 1',
      avatarUrl: null,
      joinedAt: Date.now(),
    })
    await addToQueue(kv, '2v2', {
      playerId: 'host-2',
      displayName: 'Host 2',
      avatarUrl: null,
      joinedAt: Date.now() + 1,
    })
    await addToQueue(kv, '2v2', {
      playerId: 'player-1',
      displayName: 'Player 1',
      avatarUrl: null,
      joinedAt: Date.now() + 2,
    })

    await setLobbySlots(kv, currentLobby.id, ['host-1', 'player-1', null, null], currentLobby)
    await storeUserLobbyMappings(kv, ['player-1'], staleLobby.id)

    await expect(getLobbyForUser(kv, 'player-1')).resolves.toBe(currentLobby.id)
    await expect(kv.get('activity-lobby-user:player-1')).resolves.toBe(currentLobby.id)
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

    const result = await createDraftRoom('ffa', baseFfaEntries, { matchId: 'session-ffa-default', hostId: 'p1' })

    expect(postedConfig?.formatId).toBe('default-ffa')
    expect(result.formatId).toBe('default-ffa')
  })

  test('posts room initialization to the bot-owned main route', async () => {
    let requestUrl: string | null = null
    let postedConfig: { matchId?: unknown } | null = null
    globalThis.fetch = (async (input, init) => {
      requestUrl = typeof input === 'string' ? input : input.url
      postedConfig = JSON.parse(String(init?.body)) as { matchId?: unknown }
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    await createDraftRoom('1v1', baseFfaEntries.slice(0, 2), {
      matchId: 'session-main-route',
      hostId: 'p1',
      botHost: 'https://bot.test',
    })

    expect(postedConfig?.matchId).toBe('session-main-route')
    expect(requestUrl).toBe(`https://bot.test/parties/main/${postedConfig?.matchId}`)
  })

  test('uses the bot-owned Main durable object directly when available', async () => {
    let initializedRoom: { roomName: string, config: RoomConfig } | null = null
    globalThis.fetch = (() => {
      throw new Error('createDraftRoom should not hit fetch when Main is available')
    }) as typeof fetch

    await createDraftRoom('1v1', baseFfaEntries.slice(0, 2), {
      matchId: 'session-main-do',
      hostId: 'p1',
      webhookSecret: 'secret',
      mainNamespace: createMainNamespaceStub(async (request, roomName) => {
        const url = new URL(request.url)
        if (url.pathname === '/cdn-cgi/partyserver/set-name/') return Response.json({ ok: true })

        initializedRoom = {
          roomName,
          config: await request.json() as RoomConfig,
        }
        return Response.json({ ok: true }, { status: 201 })
      }),
    })

    expect(initializedRoom).toEqual({
      roomName: 'session-main-do',
      config: expect.objectContaining({
        matchId: 'session-main-do',
        hostId: 'p1',
      }),
    })
    expect(initializedRoom?.roomName).toBe(initializedRoom?.config.matchId)
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
      matchId: 'session-ffa-simultaneous',
      hostId: 'p1',
      simultaneousPick: true,
    })

    expect(postedConfig?.formatId).toBe('default-ffa-simultaneous')
    expect(result.formatId).toBe('default-ffa-simultaneous')
  })

  test('forwards random draft outside Red Death rooms', async () => {
    let postedConfig: { formatId?: unknown, randomDraft?: unknown } | null = null
    globalThis.fetch = (async (_input, init) => {
      postedConfig = JSON.parse(String(init?.body)) as { formatId?: unknown, randomDraft?: unknown }
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const result = await createDraftRoom('1v1', baseFfaEntries.slice(0, 2), {
      matchId: 'session-random',
      hostId: 'p1',
      randomDraft: true,
    })

    expect(postedConfig?.formatId).toBe('default-1v1')
    expect(postedConfig?.randomDraft).toBe(true)
    expect(result.formatId).toBe('default-1v1')
  })

  test('forwards duplicate leaders for base-game random drafts', async () => {
    let postedConfig: { formatId?: unknown, randomDraft?: unknown, duplicateFactions?: unknown } | null = null
    globalThis.fetch = (async (_input, init) => {
      postedConfig = JSON.parse(String(init?.body)) as { formatId?: unknown, randomDraft?: unknown, duplicateFactions?: unknown }
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const result = await createDraftRoom('1v1', baseFfaEntries.slice(0, 2), {
      matchId: 'session-random-duplicate',
      hostId: 'p1',
      randomDraft: true,
      duplicateFactions: true,
    })

    expect(postedConfig?.formatId).toBe('default-1v1')
    expect(postedConfig?.randomDraft).toBe(true)
    expect(postedConfig?.duplicateFactions).toBe(true)
    expect(result.formatId).toBe('default-1v1')
  })

  test('forwards duplicate leaders for standard draft rooms too', async () => {
    let postedConfig: { formatId?: unknown, duplicateFactions?: unknown } | null = null
    globalThis.fetch = (async (_input, init) => {
      postedConfig = JSON.parse(String(init?.body)) as { formatId?: unknown, duplicateFactions?: unknown }
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const result = await createDraftRoom('1v1', baseFfaEntries.slice(0, 2), {
      matchId: 'session-standard-duplicate',
      hostId: 'p1',
      duplicateFactions: true,
    })

    expect(postedConfig?.formatId).toBe('default-1v1')
    expect(postedConfig?.duplicateFactions).toBe(true)
    expect(result.formatId).toBe('default-1v1')
  })

  test('forces duplicate factions for Red Death 6v6 rooms', async () => {
    let postedConfig: { formatId?: unknown, duplicateFactions?: unknown } | null = null
    globalThis.fetch = (async (_input, init) => {
      postedConfig = JSON.parse(String(init?.body)) as { formatId?: unknown, duplicateFactions?: unknown }
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const entries: QueueEntry[] = Array.from({ length: 12 }, (_, index) => ({
      playerId: `p${index + 1}`,
      displayName: `P${index + 1}`,
      joinedAt: index,
    }))

    const result = await createDraftRoom('6v6', entries, {
      matchId: 'session-red-death',
      hostId: 'p1',
      redDeath: true,
      duplicateFactions: false,
    })

    expect(postedConfig?.formatId).toBe('red-death-6v6')
    expect(postedConfig?.duplicateFactions).toBe(true)
    expect(result.formatId).toBe('red-death-6v6')
  })

  test('uses a visible-ban format for supported modes when blind bans are disabled', async () => {
    let postedConfig: { formatId?: unknown } | null = null
    globalThis.fetch = (async (_input, init) => {
      postedConfig = JSON.parse(String(init?.body)) as { formatId?: unknown }
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const entries = baseFfaEntries.map((entry, index) => ({
      ...entry,
      playerId: `team-player-${index + 1}`,
      displayName: `Team Player ${index + 1}`,
    }))

    const result = await createDraftRoom('1v1', entries.slice(0, 2), {
      matchId: 'session-visible-ban',
      hostId: 'team-player-1',
      blindBans: false,
    })

    expect(postedConfig?.formatId).toBe('default-1v1-visible-bans')
    expect(result.formatId).toBe('default-1v1-visible-bans')
  })

  test('falls back to the default format when visible bans are unsupported for the seat count', async () => {
    let postedConfig: { formatId?: unknown } | null = null
    globalThis.fetch = (async (_input, init) => {
      postedConfig = JSON.parse(String(init?.body)) as { formatId?: unknown }
      return new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const entries: QueueEntry[] = Array.from({ length: 8 }, (_, index) => ({
      playerId: `p${index + 1}`,
      displayName: `P${index + 1}`,
      joinedAt: index,
    }))

    const result = await createDraftRoom('2v2', entries, {
      matchId: 'session-visible-fallback',
      hostId: 'p1',
      blindBans: false,
    })

    expect(postedConfig?.formatId).toBe('default-2v2')
    expect(result.formatId).toBe('default-2v2')
  })
})
