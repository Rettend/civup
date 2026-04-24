import { describe, expect, test } from 'bun:test'
import { sessionDirectory } from '@civup/db'
import { eq } from 'drizzle-orm'
import { DEFAULT_DRAFT_CONFIG } from '../../src/services/lobby/normalize.ts'
import { SessionDO } from '../../src/session-runtime/session-do.ts'
import { createSqliteD1Database } from '../helpers/d1.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

describe('SessionDO open session commands', () => {
  test('creates an open session record from lobby creation', async () => {
    const room = new SessionDO(createFakeDurableObjectState(), {} as any)
    const lobby = buildLobby({ memberPlayerIds: ['p1'], slots: ['p1', null] })

    const response = await room.fetch(sessionRequest('/commands/create-from-lobby', {
      method: 'POST',
      body: JSON.stringify({
        lobby,
        queueEntries: [{ playerId: 'p1', displayName: 'Player One', avatarUrl: 'avatar-1', joinedAt: 10, partyIds: ['p2'] }],
      }),
    }))

    expect(response.status).toBe(200)
    const recordResponse = await room.fetch(sessionRequest('/record'))
    const body = await recordResponse.json() as any
    expect(body.record).toMatchObject({
      id: lobby.id,
      phase: 'open',
      version: 1,
      hostId: 'p1',
      config: {
        minRole: null,
        maxRole: null,
      },
      roster: {
        participants: [{
          playerId: 'p1',
          displayName: 'Player One',
          avatarUrl: 'avatar-1',
          joinedAt: 10,
          partyIds: ['p2'],
          slotIndex: 0,
        }],
        slots: ['p1', null],
      },
    })
  })

  test('starts draft lifecycle and freezes roster and config after draft start', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const room = new SessionDO(createFakeDurableObjectState(), {
      DB: createSqliteD1Database(sqlite),
      KV: kv,
    } as any)
    const openLobby = buildLobby({
      memberPlayerIds: ['p1', 'p2'],
      slots: ['p1', 'p2'],
      draftConfig: { ...DEFAULT_DRAFT_CONFIG, pickTimerSeconds: 30 },
    })

    try {
      await room.fetch(sessionRequest('/commands/create-from-lobby', {
        method: 'POST',
        body: JSON.stringify({
          lobby: openLobby,
          queueEntries: [
            { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
            { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 11 },
          ],
        }),
      }))

      const startResponse = await room.fetch(sessionRequest('/commands/start-draft', {
        method: 'POST',
        body: JSON.stringify({ hostId: 'p1', now: 2 }),
      }))
      expect(startResponse.status).toBe(200)

      const staleOpenCommand = await room.fetch(sessionRequest('/commands/open-lobby', {
        method: 'POST',
        body: JSON.stringify({
          type: 'set-draft-config',
          draftConfig: { ...DEFAULT_DRAFT_CONFIG, pickTimerSeconds: 5 },
        }),
      }))
      expect(staleOpenCommand.status).toBe(409)

      const lifecycleResponse = await room.fetch(sessionRequest('/commands/draft-lifecycle', {
        method: 'POST',
        body: JSON.stringify({ type: 'draft-completed', opensSwapWindow: true, at: 3 }),
      }))
      expect(lifecycleResponse.status).toBe(200)

      let recordResponse = await room.fetch(sessionRequest('/record'))
      let body = await recordResponse.json() as any
      expect(body.record.phase).toBe('swap')
      expect(body.record.version).toBe(3)
      let [directoryRow] = await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, openLobby.id)).limit(1)
      expect(directoryRow?.phase).toBe('swap')

      const swapResponse = await room.fetch(sessionRequest('/commands/draft-lifecycle', {
        method: 'POST',
        body: JSON.stringify({ type: 'swap-accepted', at: 4 }),
      }))
      expect(swapResponse.status).toBe(200)

      const finalizeResponse = await room.fetch(sessionRequest('/commands/draft-lifecycle', {
        method: 'POST',
        body: JSON.stringify({ type: 'draft-finalized', at: 5 }),
      }))
      expect(finalizeResponse.status).toBe(200)

      recordResponse = await room.fetch(sessionRequest('/record'))
      body = await recordResponse.json() as any
      expect(body.record.phase).toBe('active')
      expect(body.record.version).toBe(5)
      expect(body.record.matchId).toBe(openLobby.id)
      expect(body.record.config.pickTimerSeconds).toBe(30)
      expect(body.record.roster.participants.map((member: any) => member.playerId)).toEqual(['p1', 'p2'])
      expect(body.record.roster.slots).toEqual(['p1', 'p2'])

      const [finalDirectoryRow] = await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, openLobby.id)).limit(1)
      expect(finalDirectoryRow?.phase).toBe('active')
    }
    finally {
      sqlite.close()
    }
  })

  test('applies explicit open-lobby commands through the session aggregate', async () => {
    const room = new SessionDO(createFakeDurableObjectState(), {} as any)
    const openLobby = buildLobby({
      memberPlayerIds: ['p1'],
      slots: ['p1', null],
    })

    await room.fetch(sessionRequest('/commands/create-from-lobby', {
      method: 'POST',
      body: JSON.stringify({
        lobby: openLobby,
        queueEntries: [{ playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 }],
      }),
    }))

    const configResponse = await openLobbyCommand(room, {
      type: 'set-draft-config',
      expectedVersion: 1,
      now: 20,
      draftConfig: { ...DEFAULT_DRAFT_CONFIG, pickTimerSeconds: 45 },
    })
    expect(configResponse.record.version).toBe(2)
    expect(configResponse.record.updatedAt).toBe(20)
    expect(configResponse.record.config.pickTimerSeconds).toBe(45)

    const staleResponse = await openLobbyCommand(room, {
      type: 'set-steam-lobby-link',
      expectedVersion: 1,
      now: 30,
      steamLobbyLink: 'steam://join/stale',
    })
    expect(staleResponse.record.version).toBe(2)
    expect(staleResponse.record.projectionState.steamLobbyLink).toBeNull()

    const rosterResponse = await openLobbyCommand(room, {
      type: 'set-roster',
      expectedVersion: 2,
      now: 31,
      memberPlayerIds: ['p1', 'p2'],
      slots: ['p1', 'p2'],
      lastActivityAt: 31,
      queueEntries: [
        { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
        { playerId: 'p2', displayName: 'Player Two', avatarUrl: 'avatar-2', joinedAt: 11 },
      ],
    })
    expect(rosterResponse.record.version).toBe(3)
    expect(rosterResponse.record.lastActivityAt).toBe(31)
    expect(rosterResponse.record.roster.participants.map((member: any) => member.playerId)).toEqual(['p1', 'p2'])
    expect(rosterResponse.record.roster.participants[1]).toMatchObject({
      playerId: 'p2',
      displayName: 'Player Two',
      avatarUrl: 'avatar-2',
      joinedAt: 11,
    })
    expect(rosterResponse.record.roster.slots).toEqual(['p1', 'p2'])

    const modeResponse = await openLobbyCommand(room, {
      type: 'change-mode',
      expectedVersion: 3,
      now: 35,
      mode: '2v2',
      draftConfig: { ...DEFAULT_DRAFT_CONFIG },
      minRole: null,
      maxRole: null,
      slots: ['p1', 'p2', null, null],
      lastActivityAt: 35,
    })
    expect(modeResponse.record.version).toBe(4)
    expect(modeResponse.record.mode).toBe('2v2')
    expect(modeResponse.record.lastActivityAt).toBe(35)
    expect(modeResponse.record.roster.slots).toEqual(['p1', 'p2', null, null])

    const arrangeResponse = await openLobbyCommand(room, {
      type: 'arrange-roster',
      expectedVersion: 4,
      at: 40,
      strategy: 'balance',
      slots: ['p2', 'p1', null, null],
    })
    expect(arrangeResponse.record.version).toBe(5)
    expect(arrangeResponse.record.lastArrange).toEqual({ strategy: 'balance', at: 40 })
    expect(arrangeResponse.record.lastActivityAt).toBe(40)
    expect(arrangeResponse.record.roster.slots).toEqual(['p2', 'p1', null, null])

    const cancelResponse = await openLobbyCommand(room, {
      type: 'cancel-open-session',
      expectedVersion: 5,
      now: 50,
    })
    expect(cancelResponse.record).toMatchObject({
      phase: 'cancelled',
      version: 6,
      updatedAt: 50,
      closedAt: 50,
    })
  })
})

async function openLobbyCommand(room: SessionDO, command: unknown): Promise<any> {
  const response = await room.fetch(sessionRequest('/commands/open-lobby', {
    method: 'POST',
    body: JSON.stringify(command),
  }))
  expect(response.status).toBe(200)
  return await response.json()
}

function sessionRequest(pathname: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers)
  headers.set('x-partykit-room', 'session-1')
  headers.set('x-partykit-namespace', 'session')
  return new Request(`https://session.local${pathname}`, { ...init, headers })
}

function createFakeDurableObjectState(): DurableObjectState {
  const storage = new Map<string, unknown>()
  let alarmAt: number | null = null
  return {
    async blockConcurrencyWhile(callback: () => Promise<void> | void) {
      await callback()
    },
    getWebSockets() {
      return []
    },
    acceptWebSocket() {},
    storage: {
      async get(key: string) {
        return storage.get(key)
      },
      async put(key: string, value: unknown) {
        storage.set(key, value)
      },
      async setAlarm(scheduledTime: number | Date) {
        alarmAt = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime
      },
      async deleteAlarm() {
        alarmAt = null
      },
      async getAlarm() {
        return alarmAt
      },
    },
  } as unknown as DurableObjectState
}

function buildLobby(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    mode: '1v1',
    status: 'open',
    guildId: 'guild-1',
    hostId: 'p1',
    channelId: 'channel-1',
    messageId: 'message-1',
    matchId: null,
    steamLobbyLink: null,
    minRole: null,
    maxRole: null,
    lastArrange: null,
    lastActivityAt: 1,
    memberPlayerIds: ['p1'],
    slots: ['p1', null],
    draftConfig: { ...DEFAULT_DRAFT_CONFIG },
    createdAt: 1,
    updatedAt: 1,
    revision: 1,
    ...overrides,
  }
}
