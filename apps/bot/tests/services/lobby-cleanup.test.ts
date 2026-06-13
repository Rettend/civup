import type { QueueEntry } from '@civup/game'
import { sessionDirectory, sessionDirectoryMembers } from '@civup/db'
import { afterEach, describe, expect, test } from 'bun:test'
import { eq, isNull } from 'drizzle-orm'
import { getLobbyForUser } from '../../src/services/activity/index.ts'
import { SESSION_DIRECTORY_OPEN_STALE_MS } from '../../src/services/session/directory.ts'
import { getOpenSessionLobbyProjectionsByMode } from '../../src/services/session/index.ts'
import { createLobby, getExistingTestLobbyRuntime, getLobbyById, pruneInactiveOpenLobbies, setLobbyLastActivityAt, setLobbyMemberPlayerIds, setLobbySlots } from '../helpers/lobby-runtime.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('inactive lobby cleanup', () => {
  test('prunes inactive open lobbies, clears state, and updates the embed', async () => {
    const { kv } = createTrackedKv()
    const requests: Array<{ url: string, init?: RequestInit }> = []

    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), init })
      return new Response(null, { status: 200 })
    }) as typeof fetch

    const now = 10_000_000
    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    const rosterEntries = [entry('host', now - 120_000), entry('player', now - 119_999)]
    const sessionOptions = { queueEntries: rosterEntries }
    const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, ['host', 'player'], lobby, sessionOptions)
    const withSlots = await setLobbySlots(kv, lobby.id, ['host', 'player', null, null], withMembers ?? lobby, sessionOptions)
    const staleLobby = await setLobbyLastActivityAt(kv, lobby.id, now - 61 * 60 * 1000, withSlots ?? withMembers ?? lobby)
    expect(staleLobby).not.toBeNull()

    const pruned = await pruneInactiveOpenLobbies(kv, 'token', {
      now,
    })

    expect(pruned).toEqual([{
      lobbyId: staleLobby!.id,
      mode: '2v2',
      removedPlayerIds: ['host', 'player'],
    }])
    expect((await getLobbyById(kv, staleLobby!.id))?.status).toBe('cancelled')
    const runtime = getExistingTestLobbyRuntime(kv)
    expect(await getLobbyForUser(runtime.db, 'host')).toBeNull()
    expect(await getLobbyForUser(runtime.db, 'player')).toBeNull()

    const editRequest = requests.find(request => request.init?.method === 'PATCH')
    expect(editRequest).toBeDefined()
    const payload = JSON.parse(String(editRequest?.init?.body)) as {
      embeds?: unknown[]
      components?: unknown
    }
    expect(payload.components).toEqual([])
    expect(JSON.stringify(payload.embeds)).toContain('LOBBY TIMEOUT')
    expect(JSON.stringify(payload.embeds)).not.toContain('System')
  })

  test('leaves active open lobbies alone', async () => {
    const { kv } = createTrackedKv()
    let fetchCalls = 0

    globalThis.fetch = (async () => {
      fetchCalls += 1
      return new Response(null, { status: 200 })
    }) as typeof fetch

    const now = 2_000_000
    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-1',
    })

    await setLobbyLastActivityAt(kv, lobby.id, now - 30 * 60 * 1000, lobby)

    await expect(pruneInactiveOpenLobbies(kv, 'token', {
      now,
    })).resolves.toEqual([])
    expect(await getLobbyById(kv, lobby.id)).not.toBeNull()
    expect(fetchCalls).toBe(0)
  })

  test('prunes open lobbies hidden by stale directory filtering', async () => {
    const { kv } = createTrackedKv()
    const now = Date.now()
    const staleAt = now - SESSION_DIRECTORY_OPEN_STALE_MS - 1
    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-1',
    })
    const runtime = getExistingTestLobbyRuntime(kv)
    await runtime.db.update(sessionDirectory)
      .set({ updatedAt: staleAt, lastActivityAt: staleAt })
      .where(eq(sessionDirectory.sessionId, lobby.id))

    expect(await getOpenSessionLobbyProjectionsByMode(runtime.db, lobby.mode)).toEqual([])

    const pruned = await pruneInactiveOpenLobbies(kv, undefined, { now })

    expect(pruned).toEqual([{
      lobbyId: lobby.id,
      mode: '2v2',
      removedPlayerIds: ['host'],
    }])
    expect((await getLobbyById(kv, lobby.id))?.status).toBe('cancelled')
    expect(await getLobbyForUser(runtime.db, 'host')).toBeNull()
  })

  test('falls back to stale admission repair when canonical timeout cancellation fails', async () => {
    const { kv } = createTrackedKv()
    const now = Date.now()
    const staleAt = now - 61 * 60 * 1000
    const lobby = await createLobby(kv, {
      mode: '2v2',
      hostId: 'host',
      channelId: 'channel-1',
      messageId: 'message-1',
    })
    const runtime = getExistingTestLobbyRuntime(kv)
    await runtime.db.update(sessionDirectory)
      .set({ updatedAt: staleAt, lastActivityAt: staleAt })
      .where(eq(sessionDirectory.sessionId, lobby.id))

    const failingSessionNamespace = {
      idFromName(name: string) {
        return name as unknown as DurableObjectId
      },
      get() {
        return {
          async fetch() {
            return new Response(JSON.stringify({ error: 'forced failure' }), {
              status: 500,
              headers: { 'Content-Type': 'application/json' },
            })
          },
        } as DurableObjectStub
      },
    } as DurableObjectNamespace
    const originalConsoleError = console.error
    console.error = () => {}
    let pruned: Awaited<ReturnType<typeof pruneInactiveOpenLobbies>>
    try {
      pruned = await pruneInactiveOpenLobbies(kv, undefined, { now, sessionNamespace: failingSessionNamespace })
    }
    finally {
      console.error = originalConsoleError
    }

    expect(pruned!).toEqual([{
      lobbyId: lobby.id,
      mode: '2v2',
      removedPlayerIds: ['host'],
    }])
    expect(await getLobbyForUser(runtime.db, 'host')).toBeNull()
    const [directoryRow] = await runtime.db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, lobby.id)).limit(1)
    expect(directoryRow).toMatchObject({ phase: 'cancelled' })
    expect(await runtime.db.select().from(sessionDirectoryMembers).where(isNull(sessionDirectoryMembers.leftAt))).toHaveLength(0)
  })
})

function entry(playerId: string, joinedAt: number): QueueEntry {
  return {
    playerId,
    displayName: playerId,
    avatarUrl: null,
    joinedAt,
  }
}
