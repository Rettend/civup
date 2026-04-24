import { describe, expect, test } from 'bun:test'
import { DEFAULT_DRAFT_CONFIG } from '../../src/services/lobby/normalize.ts'
import { SessionDO } from '../../src/session-runtime/session-do.ts'

describe('SessionDO open session commands', () => {
  test('creates an open session record from lobby creation', async () => {
    const room = new SessionDO(createFakeDurableObjectState(), {} as any)
    const lobby = buildLobby({ memberPlayerIds: ['p1'], slots: ['p1', null] })

    const response = await room.fetch(new Request('https://session.local/commands/create-from-lobby', {
      method: 'POST',
      body: JSON.stringify({
        lobby,
        queueEntries: [{ playerId: 'p1', displayName: 'Player One', avatarUrl: 'avatar-1', joinedAt: 10, partyIds: ['p2'] }],
      }),
    }))

    expect(response.status).toBe(200)
    const prepareResponse = await room.fetch(new Request('https://session.local/commands/prepare-draft-start', {
      method: 'POST',
    }))
    expect(prepareResponse.status).toBe(200)
    const recordResponse = await room.fetch(new Request('https://session.local/record'))
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

  test('syncs lobby lifecycle changes and freezes roster and config after draft start', async () => {
    const room = new SessionDO(createFakeDurableObjectState(), {} as any)
    const openLobby = buildLobby({
      memberPlayerIds: ['p1', 'p2'],
      slots: ['p1', 'p2'],
      draftConfig: { ...DEFAULT_DRAFT_CONFIG, pickTimerSeconds: 30 },
    })

    await room.fetch(new Request('https://session.local/commands/create-from-lobby', {
      method: 'POST',
      body: JSON.stringify({
        lobby: openLobby,
        queueEntries: [
          { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
          { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 11 },
        ],
      }),
    }))

    const draftLobby = {
      ...openLobby,
      status: 'drafting' as const,
      matchId: 'match-1',
      draftConfig: { ...openLobby.draftConfig, pickTimerSeconds: 60 },
      revision: 2,
      updatedAt: 2,
    }
    await room.fetch(new Request('https://session.local/commands/sync-from-lobby', {
      method: 'POST',
      body: JSON.stringify({ lobby: draftLobby }),
    }))
    const prepareDraftResponse = await room.fetch(new Request('https://session.local/commands/prepare-draft-start', {
      method: 'POST',
    }))
    expect(prepareDraftResponse.status).toBe(409)

    const activeLobby = {
      ...draftLobby,
      status: 'active' as const,
      memberPlayerIds: ['p1', 'p2', 'p3'],
      slots: ['p3', 'p2'],
      draftConfig: { ...draftLobby.draftConfig, pickTimerSeconds: 5 },
      revision: 3,
      updatedAt: 3,
    }
    await room.fetch(new Request('https://session.local/commands/sync-from-lobby', {
      method: 'POST',
      body: JSON.stringify({ lobby: activeLobby }),
    }))

    const recordResponse = await room.fetch(new Request('https://session.local/record'))
    const body = await recordResponse.json() as any
    expect(body.record.phase).toBe('active')
    expect(body.record.version).toBe(3)
    expect(body.record.matchId).toBe('match-1')
    expect(body.record.config.pickTimerSeconds).toBe(60)
    expect(body.record.roster.participants.map((member: any) => member.playerId)).toEqual(['p1', 'p2'])
    expect(body.record.roster.slots).toEqual(['p1', 'p2'])
  })

  test('applies explicit open-lobby commands through the session aggregate', async () => {
    const room = new SessionDO(createFakeDurableObjectState(), {} as any)
    const openLobby = buildLobby({
      memberPlayerIds: ['p1'],
      slots: ['p1', null],
    })

    await room.fetch(new Request('https://session.local/commands/create-from-lobby', {
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
      type: 'set-member-player-ids',
      expectedVersion: 2,
      now: 31,
      memberPlayerIds: ['p1', 'p2'],
      queueEntries: [
        { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
        { playerId: 'p2', displayName: 'Player Two', avatarUrl: 'avatar-2', joinedAt: 11 },
      ],
    })
    expect(rosterResponse.record.version).toBe(3)
    expect(rosterResponse.record.roster.participants.map((member: any) => member.playerId)).toEqual(['p1', 'p2'])
    expect(rosterResponse.record.roster.participants[1]).toMatchObject({
      playerId: 'p2',
      displayName: 'Player Two',
      avatarUrl: 'avatar-2',
      joinedAt: 11,
    })

    const arrangeResponse = await openLobbyCommand(room, {
      type: 'arrange-roster',
      expectedVersion: 3,
      at: 40,
      strategy: 'balance',
      slots: ['p2', 'p1'],
    })
    expect(arrangeResponse.record.version).toBe(4)
    expect(arrangeResponse.record.lastArrange).toEqual({ strategy: 'balance', at: 40 })
    expect(arrangeResponse.record.lastActivityAt).toBe(40)
    expect(arrangeResponse.record.roster.slots).toEqual(['p2', 'p1'])

    const cancelResponse = await openLobbyCommand(room, {
      type: 'cancel-open-session',
      expectedVersion: 4,
      now: 50,
    })
    expect(cancelResponse.record).toMatchObject({
      phase: 'cancelled',
      version: 5,
      updatedAt: 50,
      closedAt: 50,
    })
  })
})

async function openLobbyCommand(room: SessionDO, command: unknown): Promise<any> {
  const response = await room.fetch(new Request('https://session.local/commands/open-lobby', {
    method: 'POST',
    body: JSON.stringify(command),
  }))
  expect(response.status).toBe(200)
  return await response.json()
}

function createFakeDurableObjectState(): DurableObjectState {
  const storage = new Map<string, unknown>()
  return {
    storage: {
      async get(key: string) {
        return storage.get(key)
      },
      async put(key: string, value: unknown) {
        storage.set(key, value)
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
