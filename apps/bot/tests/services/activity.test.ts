import type { QueueEntry, RoomConfig } from '@civup/game'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  createDraftRoom,
  getChannelForMatch,
  getLobbyForUser,
  getMatchForUser,
} from '../../src/services/activity/index.ts'
import { createLobby, setLobbyMemberPlayerIds, startTestSessionDraft } from '../helpers/lobby-runtime.ts'
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

describe('activity canonical lookup behavior', () => {
  test('getMatchForUser resolves from canonical live lobby membership', async () => {
    const { kv } = createTrackedKv()

    const lobby = await createLobby(kv, {
      mode: '1v1',
      hostId: 'user-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })
    await startTestSessionDraft(kv, lobby.id, lobby)

    await expect(getMatchForUser(kv, 'user-1')).resolves.toBe(lobby.id)
  })

  test('getChannelForMatch resolves from canonical same-id lobby', async () => {
    const { kv } = createTrackedKv()
    const lobby = await createLobby(kv, {
      mode: '1v1',
      hostId: 'user-1',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await startTestSessionDraft(kv, lobby.id, lobby)

    await expect(getChannelForMatch(kv, lobby.id)).resolves.toBe('channel-1')
  })

  test('getLobbyForUser resolves from canonical open lobby membership', async () => {
    const { kv } = createTrackedKv()

    const currentLobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host-1',
      channelId: 'channel-1',
      messageId: 'message-current',
    })

    await setLobbyMemberPlayerIds(kv, currentLobby.id, ['host-1', 'player-1'], currentLobby)

    await expect(getLobbyForUser(kv, 'player-1')).resolves.toBe(currentLobby.id)
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
