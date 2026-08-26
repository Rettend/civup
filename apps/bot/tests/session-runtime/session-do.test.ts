import type { DraftSeat, DraftState } from '@civup/game'
import { matchBans, matches, matchParticipants, players, sessionDirectory, tournamentCutPairings, tournamentEntries, tournamentEntryMembers, tournamentMatches, tournaments } from '@civup/db'
import { allLeaderIds, cloneOfficialAppliedSettings, swapSeatPicks } from '@civup/game'
import { createSessionAccessToken, PARTYSERVER_NAMESPACE_HEADER, PARTYSERVER_ROOM_HEADER } from '@civup/utils'
import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { DEFAULT_DRAFT_CONFIG } from '../../src/services/lobby/normalize.ts'
import { createDraftMatch } from '../../src/services/match/draft.ts'
import { createRoomRecord } from '../../src/session-runtime/draft-room-domain.ts'
import { SessionDO as RuntimeSessionDO } from '../../src/session-runtime/session-do.ts'
import { createSqliteD1Database } from '../helpers/d1.ts'
import { createTestSessionNamespace } from '../helpers/session-runtime.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const originalFetch = globalThis.fetch

class SessionDO extends RuntimeSessionDO {
  constructor(state: DurableObjectState, env: Cloudflare.Env) {
    if (!env.ALLOWED_DISCORD_GUILD_ID) env.ALLOWED_DISCORD_GUILD_ID = '111111111111111111'
    super(state, env)
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

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
    const state = createFakeDurableObjectState()
    const room = new SessionDO(state, {
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
            { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10, sourceGuild: { id: '111111111111111111' } },
            { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 11, sourceGuild: { id: '111111111111111111' } },
          ],
        }),
      }))

      const futureStartResponse = await room.fetch(sessionRequest('/commands/start-draft', {
        method: 'POST',
        body: JSON.stringify({ hostId: 'p1', expectedVersion: 99, now: 2 }),
      }))
      expect(futureStartResponse.status).toBe(409)
      expect(await futureStartResponse.json()).toEqual({ error: 'Session changed before draft start' })

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
      const [directoryRow] = await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, openLobby.id)).limit(1)
      expect(directoryRow?.phase).toBe('swap')

      const finalizeResponse = await room.fetch(sessionRequest('/commands/draft-lifecycle', {
        method: 'POST',
        body: JSON.stringify({ type: 'draft-finalized', at: 5 }),
      }))
      expect(finalizeResponse.status).toBe(200)

      recordResponse = await room.fetch(sessionRequest('/record'))
      body = await recordResponse.json() as any
      expect(body.record.phase).toBe('active')
      expect(body.record.version).toBe(4)
      expect(body.record.matchId).toBe(openLobby.id)
      expect(body.record.config.pickTimerSeconds).toBe(30)
      expect(body.record.roster.participants.map((member: any) => member.playerId)).toEqual(['p1', 'p2'])
      expect(body.record.roster.slots).toEqual(expect.arrayContaining(['p1', 'p2']))

      const [finalDirectoryRow] = await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, openLobby.id)).limit(1)
      expect(finalDirectoryRow?.phase).toBe('active')
    }
    finally {
      sqlite.close()
    }
  })

  test('starts odd-player regular FFA drafts', async () => {
    const { sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const room = new SessionDO(createFakeDurableObjectState(), {
      DB: createSqliteD1Database(sqlite),
      KV: kv,
    } as any)
    const playerIds = Array.from({ length: 7 }, (_, index) => `p${index + 1}`)
    const openLobby = buildLobby({
      id: 'odd-ffa-start',
      mode: 'ffa',
      memberPlayerIds: playerIds,
      slots: playerIds,
      draftConfig: { ...DEFAULT_DRAFT_CONFIG, permanentAlly: false },
    })
    const originalRandom = Math.random

    try {
      await createSessionFromLobby(room, openLobby, playerIds.map((playerId, index) => ({
        playerId,
        displayName: `Player ${index + 1}`,
        avatarUrl: null,
        joinedAt: 10 + index,
      })))

      Math.random = () => 0
      const started = await startDraft(room, { hostId: 'p1', now: 20 })
      expect(started.seats.map((seat: DraftSeat) => seat.playerId)).toEqual(['p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p1'])
      expect(started.record.lastArrange).toEqual({ strategy: 'randomize', at: 20 })
    }
    finally {
      Math.random = originalRandom
      sqlite.close()
    }
  })

  test('rejects odd-player Permanent Ally FFA drafts', async () => {
    const room = new SessionDO(createFakeDurableObjectState(), {} as any)
    const playerIds = Array.from({ length: 7 }, (_, index) => `p${index + 1}`)
    const openLobby = buildLobby({
      id: 'odd-pa-ffa-start',
      mode: 'ffa',
      memberPlayerIds: playerIds,
      slots: playerIds,
      draftConfig: { ...DEFAULT_DRAFT_CONFIG, permanentAlly: true },
    })

    await createSessionFromLobby(room, openLobby, playerIds.map((playerId, index) => ({
      playerId,
      displayName: `Player ${index + 1}`,
      avatarUrl: null,
      joinedAt: 10 + index,
    })))

    const startResponse = await room.fetch(sessionRequest('/commands/start-draft', {
      method: 'POST',
      body: JSON.stringify({ hostId: 'p1', now: 20 }),
    }))

    expect(startResponse.status).toBe(400)
    expect(await startResponse.json()).toEqual({ error: 'Permanent Ally FFA requires an even player count.' })
  })

  test('terminal lifecycle commands report and cancel through the session aggregate', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const originalConsoleWarn = console.warn
    const warnings: unknown[][] = []
    console.warn = ((...args: unknown[]) => {
      warnings.push(args)
    }) as typeof console.warn
    const room = new SessionDO(createFakeDurableObjectState(), {
      DB: createSqliteD1Database(sqlite),
      KV: kv,
    } as any)
    const openLobby = buildLobby({
      memberPlayerIds: ['p1', 'p2'],
      slots: ['p1', 'p2'],
    })

    try {
      await createSessionFromLobby(room, openLobby, [
        { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
        { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 11 },
      ])
      await startDraft(room, { hostId: 'p1', now: 20 })
      const completed = await room.fetch(sessionRequest('/commands/draft-lifecycle', {
        method: 'POST',
        body: JSON.stringify({ type: 'draft-completed', opensSwapWindow: false, at: 30 }),
      }))
      expect(completed.status).toBe(200)

      const reported = await sessionLifecycleCommand(room, { type: 'mark-reported', matchId: openLobby.id, at: 40 })
      expect(reported.record).toMatchObject({ phase: 'reported', version: 4, closedAt: 40 })
      const [directoryRow] = await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, openLobby.id)).limit(1)
      expect(directoryRow).toMatchObject({ phase: 'reported', closedAt: 40 })

      const repeated = await sessionLifecycleCommand(room, { type: 'mark-reported', matchId: openLobby.id, at: 41 })
      expect(repeated.record).toMatchObject({ phase: 'reported', version: 4, closedAt: 40 })

      const staleFinalized = await room.fetch(sessionRequest('/commands/draft-lifecycle-sync', {
        method: 'POST',
        body: JSON.stringify({
          ...buildCompletePayload(openLobby.id, [{ playerId: 'p1', displayName: 'Player One' }, { playerId: 'p2', displayName: 'Player Two' }] as DraftSeat[]),
          eventId: `${openLobby.id}:lifecycle:2`,
          eventKind: 'DraftFinalized',
          eventSequence: 2,
          finalized: true,
        }),
      }))
      expect(staleFinalized.status).toBe(200)
      expect(await staleFinalized.json()).toMatchObject({ ok: true, ignored: true })
      expect(warnings.flat().some(value => typeof value === 'string' && value.includes('ignoring stale draft completion'))).toBe(false)

      const cancelled = await sessionLifecycleCommand(room, { type: 'cancel-session', matchId: openLobby.id, at: 50 })
      expect(cancelled.record).toMatchObject({ phase: 'cancelled', version: 5, closedAt: 50 })

      const [terminalDirectoryRow] = await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, openLobby.id)).limit(1)
      expect(terminalDirectoryRow).toMatchObject({ phase: 'cancelled', closedAt: 50 })
      const [terminalMatchRow] = await db.select().from(matches).where(eq(matches.id, openLobby.id)).limit(1)
      expect(terminalMatchRow).toMatchObject({ status: 'cancelled', completedAt: 40, cancelledAt: 50 })

      const repeatedCancellation = await sessionLifecycleCommand(room, { type: 'cancel-session', matchId: openLobby.id, at: 51 })
      expect(repeatedCancellation.record).toMatchObject({ phase: 'cancelled', version: 5, closedAt: 50 })
      const [repeatedCancellationMatch] = await db.select().from(matches).where(eq(matches.id, openLobby.id)).limit(1)
      expect(repeatedCancellationMatch).toMatchObject({ status: 'cancelled', cancelledAt: 50 })

      const resolved = await sessionLifecycleCommand(room, { type: 'mark-reported', matchId: openLobby.id, at: 60 })
      expect(resolved.record).toMatchObject({ phase: 'reported', version: 6, closedAt: 60 })

      const [reportedDirectoryRow] = await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, openLobby.id)).limit(1)
      expect(reportedDirectoryRow).toMatchObject({ phase: 'reported', closedAt: 60 })
      const [reportedMatchRow] = await db.select().from(matches).where(eq(matches.id, openLobby.id)).limit(1)
      expect(reportedMatchRow).toMatchObject({ status: 'completed', completedAt: 40, cancelledAt: null })
    }
    finally {
      console.warn = originalConsoleWarn
      sqlite.close()
    }
  })

  test('report claim retries swap finalization and persists swapped leaders before reporting', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const d1 = createFailingSessionDirectoryD1(createSqliteD1Database(sqlite))
    const env: Partial<Cloudflare.Env> = { DB: d1.database, KV: kv }
    const namespace = createTestSessionNamespace(env)
    env.SessionDO = namespace
    const originalConsoleError = console.error
    const originalConsoleWarn = console.warn
    console.error = (() => {}) as typeof console.error
    console.warn = (() => {}) as typeof console.warn
    const openLobby = buildLobby({
      id: 'report-swap-finalize',
      mode: '2v2',
      memberPlayerIds: ['p1', 'p2', 'p3', 'p4'],
      slots: ['p1', 'p2', 'p3', 'p4'],
    })
    const room = namespace.__getRoom(openLobby.id)

    try {
      await createSessionFromLobby(room, openLobby, [
        { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
        { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 11 },
        { playerId: 'p3', displayName: 'Player Three', avatarUrl: null, joinedAt: 12 },
        { playerId: 'p4', displayName: 'Player Four', avatarUrl: null, joinedAt: 13 },
      ])
      const started = await startDraft(room, { hostId: 'p1', now: 20 })
      const initialRoom = await (room as any).getRoomRecord()
      const completedPayload = buildCompletePayload(openLobby.id, started.seats)
      completedPayload.state.formatId = initialRoom.config.formatId

      const completed = await room.fetch(sessionRequest('/commands/draft-lifecycle-sync', {
        method: 'POST',
        body: JSON.stringify(completedPayload),
      }))
      expect(completed.status).toBe(200)
      expect((await getSessionRecordBody(room)).phase).toBe('swap')

      const swappedPicks = swapSeatPicks(completedPayload.state, 0, 2)
      if ('error' in swappedPicks) throw new Error(swappedPicks.error)
      await (room as any).setRoomRecord(createRoomRecord(initialRoom.config, {
        ...completedPayload.state,
        picks: swappedPicks,
      }, initialRoom.mapVote, {
        completedAt: completedPayload.completedAt,
        lifecycleEventSequence: completedPayload.eventSequence,
        swapWindowOpen: true,
        swapState: { completedSwaps: [{ fromSeat: 0, toSeat: 2 }] },
        swapSafetyEndsAt: 1_000,
      }))

      d1.failNextSessionDirectoryWrite()
      const claim = await room.fetch(sessionRequest('/commands/report-claim', {
        method: 'POST',
        body: JSON.stringify({ type: 'claim', matchId: openLobby.id, reporterId: 'p1', at: 40 }),
      }))

      expect(claim.status).toBe(200)
      expect(await claim.json()).toMatchObject({ claimed: true })
      expect((await getSessionRecordBody(room)).phase).toBe('active')

      const storedParticipants = await db
        .select()
        .from(matchParticipants)
        .where(eq(matchParticipants.matchId, openLobby.id))
      const civByPlayerId = new Map(storedParticipants.map(participant => [participant.playerId, participant.civId]))
      const seat0PlayerId = completedPayload.state.seats[0]?.playerId
      const seat2PlayerId = completedPayload.state.seats[2]?.playerId
      expect(civByPlayerId.get(seat0PlayerId!)).toBe(completedPayload.state.picks.find(pick => pick.seatIndex === 2)?.civId)
      expect(civByPlayerId.get(seat2PlayerId!)).toBe(completedPayload.state.picks.find(pick => pick.seatIndex === 0)?.civId)
    }
    finally {
      console.error = originalConsoleError
      console.warn = originalConsoleWarn
      sqlite.close()
    }
  })

  test('terminal cancellation closes stale draft runtime access', async () => {
    const { sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const state = createFakeDurableObjectState()
    const room = new SessionDO(state, {
      CIVUP_SECRET: 'secret',
      DB: createSqliteD1Database(sqlite),
      KV: kv,
    } as any)
    const openLobby = buildLobby({
      memberPlayerIds: ['p1', 'p2'],
      slots: ['p1', 'p2'],
    })
    const accessToken = await createSessionAccessToken('secret', {
      userId: 'p1',
      sessionId: openLobby.id,
      channelId: openLobby.channelId,
    })

    try {
      await createSessionFromLobby(room, openLobby, [
        { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
        { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 11 },
      ])
      await startDraft(room, { hostId: 'p1', now: 20 })

      const draftConnection = createFakeConnection()
      draftConnection.connection.serializeAttachment({ id: 'conn-p1', sessionId: openLobby.id, playerId: 'p1', kind: 'draft', connectedAt: 20 })
      addFakeAcceptedConnection(state, draftConnection.connection)

      await sessionLifecycleCommand(room, { type: 'cancel-session', matchId: openLobby.id, at: 30 })

      expect(draftConnection.closed).toEqual({ code: 1000, reason: 'Session closed' })

      const statusAfterCancel = await room.fetch(draftStatusRequest(accessToken))
      expect(statusAfterCancel.status).toBe(410)
      expect(await statusAfterCancel.json()).toEqual({ error: 'Session closed' })

      const reconnect = createFakeConnection()
      await room.onConnect(reconnect.connection, {
        request: draftStatusRequest(accessToken),
      } as any)
      expect(reconnect.messages).toEqual([])
      expect(reconnect.closed).toEqual({ code: 1000, reason: 'Session closed' })
    }
    finally {
      sqlite.close()
    }
  })

  test('rejects selected-session sockets launched from an unsupported server', async () => {
    const room = new SessionDO(createFakeDurableObjectState(), {
      CIVUP_SECRET: 'secret',
      ALLOWED_DISCORD_GUILD_ID: '111111111111111111',
    } as any)
    await createSessionFromLobby(room, buildLobby(), [
      { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
    ])
    const connection = createFakeConnection()

    await room.onConnect(connection.connection, {
      request: sessionRequest('/', {
        headers: {
          'X-CivUp-Internal-Secret': 'secret',
          'X-CivUp-Activity-User-Id': 'p1',
          'X-CivUp-Activity-Guild-Id': '222222222222222222',
        },
      }),
    } as any)

    expect(connection.messages).toEqual([])
    expect(connection.closed).toEqual({ code: 4403, reason: 'Forbidden' })
  })

  test('alarm closes idle selected-session sockets after their launch server is removed', async () => {
    const state = createFakeDurableObjectState()
    const env = {
      CIVUP_SECRET: 'secret',
      ALLOWED_DISCORD_GUILD_ID: '111111111111111111',
      ALLOWED_DISCORD_GUILD_IDS: '222222222222222222',
    } as any
    const room = new SessionDO(state, env)
    await createSessionFromLobby(room, buildLobby(), [
      { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
    ])
    const connection = createFakeConnection()
    addFakeAcceptedConnection(state, connection.connection)

    await room.onConnect(connection.connection, {
      request: sessionRequest('/', {
        headers: {
          'X-CivUp-Internal-Secret': 'secret',
          'X-CivUp-Activity-User-Id': 'p1',
          'X-CivUp-Activity-Guild-Id': '222222222222222222',
        },
      }),
    } as any)

    expect(connection.closed).toBeNull()
    expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now())

    env.ALLOWED_DISCORD_GUILD_IDS = '111111111111111111'
    await room.onAlarm()

    expect(connection.closed).toEqual({ code: 4403, reason: 'Forbidden' })
  })

  test('opens imported active sessions without an initialized draft room', async () => {
    const { db, sqlite } = await createTestDatabase()
    const { state, storage } = createFakeDurableObjectStateWithStorage()
    const room = new SessionDO(state, {
      DB: createSqliteD1Database(sqlite),
      CIVUP_SECRET: 'secret',
    } as any)
    const matchId = 'legacy-active-match'
    const legacySteps = [
      { action: 'ban', seats: [0], count: 1, timer: 45 },
      { action: 'ban', seats: [1], count: 1, timer: 45 },
      { action: 'ban', seats: [0], count: 1, timer: 45 },
      { action: 'ban', seats: [1], count: 1, timer: 45 },
      { action: 'ban', seats: [0], count: 1, timer: 45 },
      { action: 'ban', seats: [1], count: 1, timer: 45 },
      { action: 'pick', seats: [0], count: 1, timer: 60 },
      { action: 'pick', seats: [1], count: 1, timer: 60 },
    ]

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'Player One', avatarUrl: null, createdAt: 1_700_000_000_000 },
        { id: 'p2', displayName: 'Player Two', avatarUrl: null, createdAt: 1_700_000_000_000 },
      ])
      await db.insert(matches).values({
        id: matchId,
        gameMode: '1v1',
        status: 'active',
        isOld: false,
        seasonId: null,
        draftData: JSON.stringify({
          completedAt: 1_700_000_050_000,
          state: { formatId: 'default-1v1-visible-bans', steps: legacySteps },
        }),
        createdAt: 1_700_000_000_000,
        completedAt: null,
      })
      await db.insert(matchParticipants).values([
        { matchId, playerId: 'p1', team: 0, civId: 'greece-gorgo', placement: null },
        { matchId, playerId: 'p2', team: 1, civId: 'babylon-hammurabi', placement: null },
      ])
      storage.set('session-record', buildActiveSessionRecord({
        id: matchId,
        matchId,
        config: { ...DEFAULT_DRAFT_CONFIG, blindBans: false, minRole: null, maxRole: null },
      }))

      const token = await createSessionAccessToken('secret', {
        userId: 'p1',
        sessionId: matchId,
        channelId: 'channel-1',
      })
      const connection = createFakeConnection()
      await room.onConnect(connection.connection, {
        request: sessionRequest(`/?accessToken=${encodeURIComponent(token)}`, {
          headers: {
            'X-CivUp-Internal-Secret': 'secret',
            'X-CivUp-Activity-User-Id': 'p1',
            'X-CivUp-Activity-Guild-Id': '111111111111111111',
          },
        }),
      } as any)

      expect(connection.messages).toHaveLength(1)
      expect(connection.messages[0]).toMatchObject({
        type: 'init',
        completedAt: 1_700_000_050_000,
        hostId: 'p1',
        seatIndex: 0,
        state: {
          matchId,
          formatId: 'default-1v1-visible-bans',
          status: 'complete',
          steps: legacySteps,
          seats: [
            { playerId: 'p1', displayName: 'Player One', team: 0 },
            { playerId: 'p2', displayName: 'Player Two', team: 1 },
          ],
          picks: [
            { seatIndex: 0, civId: 'greece-gorgo', stepIndex: 6 },
            { seatIndex: 1, civId: 'babylon-hammurabi', stepIndex: 7 },
          ],
        },
      })
      expect(connection.closed).toEqual({ code: 1000, reason: 'Draft closed' })
    }
    finally {
      sqlite.close()
    }
  })

  test('start draft retries reuse the existing draft runtime seats', async () => {
    const { sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const state = createFakeDurableObjectState()
    const room = new SessionDO(state, {
      DB: createSqliteD1Database(sqlite),
      KV: kv,
    } as any)
    const openLobby = buildLobby({
      memberPlayerIds: ['p1', 'p2'],
      slots: ['p1', 'p2'],
    })
    const originalRandom = Math.random

    try {
      await createSessionFromLobby(room, openLobby, [
        { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
        { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 11 },
      ])

      Math.random = () => 0
      const firstStart = await startDraft(room, { hostId: 'p1', now: 20 })
      Math.random = () => 0.999
      const retryStart = await startDraft(room, { hostId: 'p1', now: 21 })

      expect(firstStart.matchId).toBe(openLobby.id)
      expect(firstStart.seats.map((seat: DraftSeat) => seat.playerId)).toEqual(['p2', 'p1'])
      expect(retryStart).toMatchObject({ matchId: openLobby.id, idempotent: true })
      expect(retryStart.seats).toEqual(firstStart.seats)
      const record = await getSessionRecordBody(room)
      expect(record.phase).toBe('draft')
      expect(record.version).toBe(2)
      expect(record.roster.slots).toEqual(['p2', 'p1'])
      expect(record.lastArrange).toEqual({ strategy: 'shuffle-teams', at: 20 })
    }
    finally {
      Math.random = originalRandom
      sqlite.close()
    }
  })

  test('projects Steam lobby link changes into draft and swap runtime snapshots', async () => {
    const { sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const room = new SessionDO(createFakeDurableObjectState(), {
      CIVUP_SECRET: 'secret',
      DB: createSqliteD1Database(sqlite),
      KV: kv,
    } as any)
    const openLobby = buildLobby({
      memberPlayerIds: ['p1', 'p2'],
      slots: ['p1', 'p2'],
    })
    const accessToken = await createSessionAccessToken('secret', {
      userId: 'p1',
      sessionId: openLobby.id,
      channelId: openLobby.channelId,
    })

    await room.fetch(sessionRequest('/commands/create-from-lobby', {
      method: 'POST',
      body: JSON.stringify({
        lobby: openLobby,
        queueEntries: [
          { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10, sourceGuild: { id: '111111111111111111' } },
          { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 11, sourceGuild: { id: '111111111111111111' } },
        ],
      }),
    }))
    await room.fetch(sessionRequest('/commands/start-draft', {
      method: 'POST',
      body: JSON.stringify({ hostId: 'p1', now: 2 }),
    }))

    const draftLink = 'steam://joinlobby/289070/12345678901234567/76561198000000000'
    const draftProjectionResponse = await room.fetch(sessionRequest('/commands/session-projection', {
      method: 'POST',
      body: JSON.stringify({ type: 'set-steam-lobby-link', steamLobbyLink: draftLink, now: 3 }),
    }))
    expect(draftProjectionResponse.status).toBe(200)

    let statusResponse = await room.fetch(draftStatusRequest(accessToken))
    expect(statusResponse.status).toBe(200)
    expect((await statusResponse.json() as any).steamLobbyLink).toBe(draftLink)

    await room.fetch(sessionRequest('/commands/draft-lifecycle', {
      method: 'POST',
      body: JSON.stringify({ type: 'draft-completed', opensSwapWindow: true, at: 4 }),
    }))
    const swapLink = 'steam://joinlobby/289070/22345678901234567/76561198000000001'
    const swapProjectionResponse = await room.fetch(sessionRequest('/commands/session-projection', {
      method: 'POST',
      body: JSON.stringify({ type: 'set-steam-lobby-link', steamLobbyLink: swapLink, now: 5 }),
    }))
    expect(swapProjectionResponse.status).toBe(200)

    statusResponse = await room.fetch(draftStatusRequest(accessToken))
    expect(statusResponse.status).toBe(200)
    const statusBody = await statusResponse.json() as any
    expect(statusBody.steamLobbyLink).toBe(swapLink)
  })

  test('draft start and lifecycle sync continue without KV binding', async () => {
    const { db, sqlite } = await createTestDatabase()
    const room = new SessionDO(createFakeDurableObjectState(), {
      DB: createSqliteD1Database(sqlite),
    } as any)
    const openLobby = buildLobby({
      memberPlayerIds: ['p1', 'p2'],
      slots: ['p1', 'p2'],
      draftConfig: { ...DEFAULT_DRAFT_CONFIG, pickTimerSeconds: null, banTimerSeconds: null },
    })

    try {
      await createSessionFromLobby(room, openLobby, [
        { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
        { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 11 },
      ])

      const started = await startDraft(room, { hostId: 'p1', now: 20 })
      expect(started.seats).toHaveLength(2)
      const completed = await room.fetch(sessionRequest('/commands/draft-lifecycle-sync', {
        method: 'POST',
        body: JSON.stringify(buildCompletePayload(openLobby.id, started.seats)),
      }))

      expect(completed.status).toBe(200)
      const record = await getSessionRecordBody(room)
      expect(record.phase).toBe('swap')
      expect(record.lifecycleSync).toBeNull()
      expect(record.projectionSync).toBeNull()
      expect((await db.select().from(matches).where(eq(matches.id, openLobby.id)).limit(1))[0]?.status).toBe('active')
    }
    finally {
      sqlite.close()
    }
  })

  test('revert lifecycle sync pushes the reopened tournament lobby to selected draft sockets', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const state = createFakeDurableObjectState()
    const room = new SessionDO(state, {
      DB: createSqliteD1Database(sqlite),
      KV: kv,
    } as any)
    const openLobby = buildLobby({
      memberPlayerIds: ['p1', 'p2'],
      slots: ['p1', 'p2'],
    })

    try {
      await createSessionFromLobby(room, openLobby, [
        { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
        { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 11 },
      ])
      const started = await startDraft(room, { hostId: 'p1', now: 20 })
      await insertDraftingTournamentLink(db, openLobby.id, started.matchId)
      const draftConnection = createFakeConnection()
      draftConnection.connection.serializeAttachment({ id: 'conn-p2', sessionId: openLobby.id, playerId: 'p2', kind: 'draft', connectedAt: 20 })
      addFakeAcceptedConnection(state, draftConnection.connection)

      await (room as any).syncDraftRuntimeLifecyclePayload(buildCancelledPayload(openLobby.id, started.seats, 'revert'), 'test-revert')

      expect(await getSessionRecordBody(room)).toMatchObject({ phase: 'open', matchId: null })
      expect(draftConnection.messages).toHaveLength(1)
      expect(draftConnection.messages[0]).toMatchObject({
        type: 'lobby',
        lobbyId: openLobby.id,
        snapshot: {
          id: openLobby.id,
          status: 'open',
          memberPlayerIds: ['p1', 'p2'],
          tournament: {
            id: 'tournament-session-test',
            name: 'Session Test Cup',
            configLocked: true,
          },
        },
      })
      const [tournamentMatch] = await db.select().from(tournamentMatches).where(eq(tournamentMatches.sessionId, openLobby.id))
      expect(tournamentMatch).toMatchObject({ status: 'open', matchId: null, winnerId: null })
      const [cutPairing] = await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.sessionId, openLobby.id))
      expect(cutPairing).toMatchObject({ status: 'open', matchId: null, winnerId: null })
    }
    finally {
      sqlite.close()
    }
  })

  test('timeout lifecycle sync reopens tournament match state', async () => {
    const { db, sqlite } = await createTestDatabase()
    const room = new SessionDO(createFakeDurableObjectState(), {
      DB: createSqliteD1Database(sqlite),
      KV: createTestKv(),
    } as any)
    const openLobby = buildLobby({
      memberPlayerIds: ['p1', 'p2'],
      slots: ['p1', 'p2'],
    })

    try {
      await createSessionFromLobby(room, openLobby, [
        { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
        { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 11 },
      ])
      const started = await startDraft(room, { hostId: 'p1', now: 20 })
      await insertDraftingTournamentLink(db, openLobby.id, started.matchId)

      await (room as any).syncDraftRuntimeLifecyclePayload(buildCancelledPayload(openLobby.id, started.seats, 'timeout'), 'test-timeout')

      expect(await getSessionRecordBody(room)).toMatchObject({ phase: 'open', matchId: null })
      const [tournamentMatch] = await db.select().from(tournamentMatches).where(eq(tournamentMatches.sessionId, openLobby.id))
      expect(tournamentMatch).toMatchObject({ status: 'open', matchId: null, winnerId: null })
      const [cutPairing] = await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.sessionId, openLobby.id))
      expect(cutPairing).toMatchObject({ status: 'open', matchId: null, winnerId: null })
    }
    finally {
      sqlite.close()
    }
  })

  test('explicit draft cancellation terminates the tournament match and releases its playoff pairing', async () => {
    const { db, sqlite } = await createTestDatabase()
    const room = new SessionDO(createFakeDurableObjectState(), {
      DB: createSqliteD1Database(sqlite),
      KV: createTestKv(),
    } as any)
    const openLobby = buildLobby({
      memberPlayerIds: ['p1', 'p2'],
      slots: ['p1', 'p2'],
    })

    try {
      await createSessionFromLobby(room, openLobby, [
        { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
        { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 11 },
      ])
      const started = await startDraft(room, { hostId: 'p1', now: 20 })
      await insertDraftingTournamentLink(db, openLobby.id, started.matchId)

      await (room as any).syncDraftRuntimeLifecyclePayload(buildCancelledPayload(openLobby.id, started.seats, 'cancel'), 'test-cancel')

      expect(await getSessionRecordBody(room)).toMatchObject({ phase: 'cancelled' })
      const [tournamentMatch] = await db.select().from(tournamentMatches).where(eq(tournamentMatches.sessionId, openLobby.id))
      expect(tournamentMatch).toMatchObject({ status: 'cancelled', matchId: started.matchId, winnerEntryId: null })
      const [cutPairing] = await db.select().from(tournamentCutPairings).where(eq(tournamentCutPairings.tournamentId, 'tournament-session-test'))
      expect(cutPairing).toMatchObject({ status: 'scheduled', sessionId: null, matchId: null, winnerEntryId: null })
    }
    finally {
      sqlite.close()
    }
  })

  test('lifecycle retry after partial activation still commits session and updates Discord projection', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const d1 = createFailingSessionDirectoryD1(createSqliteD1Database(sqlite))
    const discordRequests: Array<{ method: string, url: string }> = []
    const originalConsoleError = console.error
    const originalConsoleWarn = console.warn
    console.error = (() => {}) as typeof console.error
    console.warn = (() => {}) as typeof console.warn
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      discordRequests.push({ method: request.method, url: request.url })
      return new Response(JSON.stringify({ id: 'message-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const room = new SessionDO(createFakeDurableObjectState(), {
      DB: d1.database,
      KV: kv,
      DISCORD_TOKEN: 'token',
    } as any)
    const openLobby = buildLobby({
      memberPlayerIds: ['p1', 'p2'],
      slots: ['p1', 'p2'],
    })

    try {
      await createSessionFromLobby(room, openLobby, [
        { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
        { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 11 },
      ])
      const started = await startDraft(room, { hostId: 'p1', now: 20 })
      const payload = buildCompletePayload(openLobby.id, started.seats)

      d1.failNextSessionDirectoryWrite()
      const partial = await room.fetch(sessionRequest('/commands/draft-lifecycle-sync', {
        method: 'POST',
        body: JSON.stringify(payload),
      }))

      expect(partial.status).toBe(503)
      expect((await getSessionRecordBody(room)).phase).toBe('draft')
      expect((await getSessionRecordBody(room)).lifecycleSync?.payload.eventId).toBe(payload.eventId)
      expect((await db.select().from(matches).where(eq(matches.id, openLobby.id)).limit(1))[0]?.status).toBe('active')
      expect(discordRequests).toHaveLength(0)

      const retry = await room.fetch(sessionRequest('/commands/draft-lifecycle-sync', {
        method: 'POST',
        body: JSON.stringify(payload),
      }))

      expect(retry.status).toBe(200)
      const record = await getSessionRecordBody(room)
      expect(record.phase).toBe('swap')
      expect(record.lifecycleSync).toBeNull()
      expect((await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, openLobby.id)).limit(1))[0]?.phase).toBe('swap')
      expect(await kv.get(`lobby:id:${openLobby.id}`, 'json')).toBeNull()
      expect(discordRequests).toEqual([
        expect.objectContaining({ method: 'PATCH', url: expect.stringContaining('/channels/channel-1/messages/message-1') }),
      ])
      const participants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, openLobby.id))
      expect(participants.every(participant => participant.civId != null)).toBe(true)
    }
    finally {
      console.error = originalConsoleError
      console.warn = originalConsoleWarn
      sqlite.close()
    }
  })

  test('completion projection failures retry from alarm without rolling back lifecycle truth', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const discordRequests: Array<{ method: string, url: string }> = []
    const originalDateNow = Date.now
    const originalConsoleError = console.error
    const originalConsoleWarn = console.warn
    let failNextPatch = true
    console.error = (() => {}) as typeof console.error
    console.warn = (() => {}) as typeof console.warn
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      discordRequests.push({ method: request.method, url: request.url })
      if (failNextPatch && request.method === 'PATCH') {
        failNextPatch = false
        return new Response('injected discord failure', { status: 400 })
      }
      return new Response(JSON.stringify({ id: 'message-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    const room = new SessionDO(createFakeDurableObjectState(), {
      DB: createSqliteD1Database(sqlite),
      KV: kv,
      DISCORD_TOKEN: 'token',
    } as any)
    const openLobby = buildLobby({
      memberPlayerIds: ['p1', 'p2'],
      slots: ['p1', 'p2'],
    })

    try {
      await createSessionFromLobby(room, openLobby, [
        { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
        { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 11 },
      ])
      const started = await startDraft(room, { hostId: 'p1', now: 20 })
      const payload = buildCompletePayload(openLobby.id, started.seats)

      const completed = await room.fetch(sessionRequest('/commands/draft-lifecycle-sync', {
        method: 'POST',
        body: JSON.stringify(payload),
      }))

      expect(completed.status).toBe(200)
      const pending = await getSessionRecordBody(room)
      expect(pending.phase).toBe('swap')
      expect(pending.lifecycleSync).toBeNull()
      expect(pending.projectionSync).toMatchObject({
        attempts: 1,
        payload: expect.objectContaining({ type: 'draft-completed' }),
      })
      expect((await db.select().from(matches).where(eq(matches.id, openLobby.id)).limit(1))[0]?.status).toBe('active')
      expect(discordRequests).toHaveLength(1)

      Date.now = () => pending.projectionSync.nextRetryAt
      await room.onAlarm()

      const record = await getSessionRecordBody(room)
      expect(record.phase).toBe('swap')
      expect(record.projectionSync).toBeNull()
      expect(discordRequests).toEqual([
        expect.objectContaining({ method: 'PATCH', url: expect.stringContaining('/channels/channel-1/messages/message-1') }),
        expect.objectContaining({ method: 'PATCH', url: expect.stringContaining('/channels/channel-1/messages/message-1') }),
      ])
    }
    finally {
      Date.now = originalDateNow
      console.error = originalConsoleError
      console.warn = originalConsoleWarn
      sqlite.close()
    }
  })

  test('completion projection retry is bounded and abandons stuck Discord work', async () => {
    const { sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const discordRequests: Array<{ method: string, url: string }> = []
    const originalDateNow = Date.now
    const originalConsoleError = console.error
    const originalConsoleWarn = console.warn
    console.error = (() => {}) as typeof console.error
    console.warn = (() => {}) as typeof console.warn
    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      discordRequests.push({ method: request.method, url: request.url })
      return new Response('injected discord failure', { status: 400 })
    }) as typeof fetch

    const room = new SessionDO(createFakeDurableObjectState(), {
      DB: createSqliteD1Database(sqlite),
      KV: kv,
      DISCORD_TOKEN: 'token',
    } as any)
    const openLobby = buildLobby({
      memberPlayerIds: ['p1', 'p2'],
      slots: ['p1', 'p2'],
    })

    try {
      await createSessionFromLobby(room, openLobby, [
        { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
        { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 11 },
      ])
      const started = await startDraft(room, { hostId: 'p1', now: 20 })

      const completed = await room.fetch(sessionRequest('/commands/draft-lifecycle-sync', {
        method: 'POST',
        body: JSON.stringify(buildCompletePayload(openLobby.id, started.seats)),
      }))
      expect(completed.status).toBe(200)
      expect((await getSessionRecordBody(room)).projectionSync?.attempts).toBe(1)

      for (let attempt = 2; attempt <= 5; attempt++) {
        const current = await getSessionRecordBody(room)
        expect(current.projectionSync?.attempts).toBe(attempt - 1)
        Date.now = () => current.projectionSync.nextRetryAt
        await room.onAlarm()
      }

      const record = await getSessionRecordBody(room)
      expect(record.phase).toBe('swap')
      expect(record.projectionSync).toBeNull()
      expect(discordRequests).toHaveLength(5)
    }
    finally {
      Date.now = originalDateNow
      console.error = originalConsoleError
      console.warn = originalConsoleWarn
      sqlite.close()
    }
  })

  test('pending lifecycle sync retries from alarm after transient backend outage', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const d1 = createSqliteD1Database(sqlite)
    const env: { DB?: D1Database, KV?: KVNamespace } = { DB: d1, KV: kv }
    const room = new SessionDO(createFakeDurableObjectState(), env as any)
    const openLobby = buildLobby({
      memberPlayerIds: ['p1', 'p2'],
      slots: ['p1', 'p2'],
    })
    const originalDateNow = Date.now
    const originalConsoleWarn = console.warn
    console.warn = (() => {}) as typeof console.warn

    try {
      await createSessionFromLobby(room, openLobby, [
        { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
        { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 11 },
      ])
      const started = await startDraft(room, { hostId: 'p1', now: 20 })
      const payload = buildCompletePayload(openLobby.id, started.seats)

      env.DB = undefined
      Date.now = () => 1_000
      const deferred = await room.fetch(sessionRequest('/commands/draft-lifecycle-sync', {
        method: 'POST',
        body: JSON.stringify(payload),
      }))

      expect(deferred.status).toBe(503)
      const pending = await getSessionRecordBody(room)
      expect(pending.phase).toBe('draft')
      expect(pending.lifecycleSync).toMatchObject({
        payload: expect.objectContaining({ eventId: payload.eventId }),
        attempts: 1,
        nextRetryAt: 2_000,
      })

      env.DB = d1
      Date.now = () => 2_000
      await room.onAlarm()

      const record = await getSessionRecordBody(room)
      expect(record.phase).toBe('swap')
      expect(record.lifecycleSync).toBeNull()
      expect((await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, openLobby.id)).limit(1))[0]?.phase).toBe('swap')
      expect(await kv.get(`lobby:id:${openLobby.id}`, 'json')).toBeNull()
    }
    finally {
      Date.now = originalDateNow
      console.warn = originalConsoleWarn
      sqlite.close()
    }
  })

  test('draft completion lifecycle retries when match creation has not finished yet', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const d1 = createSqliteD1Database(sqlite)
    const room = new SessionDO(createFakeDurableObjectState(), { DB: d1, KV: kv } as any)
    const openLobby = buildLobby({
      memberPlayerIds: ['p1', 'p2'],
      slots: ['p1', 'p2'],
    })
    const originalDateNow = Date.now
    const originalConsoleWarn = console.warn
    console.warn = (() => {}) as typeof console.warn

    try {
      await createSessionFromLobby(room, openLobby, [
        { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
        { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 11 },
      ])
      const started = await startDraft(room, { hostId: 'p1', now: 20 })
      const payload = buildCompletePayload(openLobby.id, started.seats)

      await db.delete(matchParticipants).where(eq(matchParticipants.matchId, openLobby.id))
      await db.delete(matches).where(eq(matches.id, openLobby.id))

      Date.now = () => 1_000
      const deferred = await room.fetch(sessionRequest('/commands/draft-lifecycle-sync', {
        method: 'POST',
        body: JSON.stringify(payload),
      }))

      expect(deferred.status).toBe(503)
      const pending = await getSessionRecordBody(room)
      expect(pending.phase).toBe('draft')
      expect(pending.lifecycleSync).toMatchObject({
        payload: expect.objectContaining({ eventId: payload.eventId }),
        attempts: 1,
        nextRetryAt: 2_000,
      })

      await createDraftMatch(db, {
        matchId: openLobby.id,
        mode: '1v1',
        seats: started.seats,
        guildId: '111111111111111111',
        primaryGuildId: '111111111111111111',
      })

      Date.now = () => 2_000
      await room.onAlarm()

      const record = await getSessionRecordBody(room)
      expect(record.phase).toBe('swap')
      expect(record.lifecycleSync).toBeNull()
      expect((await db.select().from(matches).where(eq(matches.id, openLobby.id)).limit(1))[0]?.status).toBe('active')
      expect((await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, openLobby.id)).limit(1))[0]?.phase).toBe('swap')
    }
    finally {
      Date.now = originalDateNow
      console.warn = originalConsoleWarn
      sqlite.close()
    }
  })

  test('connecting to a completed draft room recovers a missed lifecycle sync', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const d1 = createSqliteD1Database(sqlite)
    const env: { DB?: D1Database, KV?: KVNamespace, CIVUP_SECRET?: string } = { DB: d1, KV: kv, CIVUP_SECRET: 'secret' }
    const room = new SessionDO(createFakeDurableObjectState(), env as any)
    const gameSettings = cloneOfficialAppliedSettings()
    gameSettings.profile.base.autoBannedLeaderIds = allLeaderIds.slice(0, 32)
    const openLobby = buildLobby({
      memberPlayerIds: ['p1', 'p2'],
      slots: ['p1', 'p2'],
      draftConfig: { ...DEFAULT_DRAFT_CONFIG, hiddenDraft: true, leaderPoolSize: allLeaderIds.length },
      gameSettings,
    })
    const accessToken = await createSessionAccessToken('secret', {
      userId: 'p1',
      sessionId: openLobby.id,
      channelId: openLobby.channelId,
    })
    const originalConsoleWarn = console.warn
    const originalConsoleError = console.error
    const originalConsoleLog = console.log
    console.warn = (() => {}) as typeof console.warn
    console.error = (() => {}) as typeof console.error
    console.log = (() => {}) as typeof console.log

    try {
      await createSessionFromLobby(room, openLobby, [
        { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
        { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 11 },
      ])
      await startDraft(room, { hostId: 'p1', now: 20 })

      const connection = createFakeConnection()
      await room.onConnect(connection.connection, { request: draftStatusRequest(accessToken) } as any)

      env.DB = undefined
      await room.onMessage(connection.connection, JSON.stringify({ type: 'start' }))

      expect((await getSessionRecordBody(room)).phase).toBe('draft')
      expect((await db.select().from(matches).where(eq(matches.id, openLobby.id)).limit(1))[0]?.status).toBe('drafting')

      env.DB = d1
      const reconnect = createFakeConnection()
      await room.onConnect(reconnect.connection, { request: draftStatusRequest(accessToken) } as any)

      const record = await getSessionRecordBody(room)
      expect(record.phase).toBe('active')
      expect(record.lifecycleSync).toBeNull()
      expect((await db.select().from(matches).where(eq(matches.id, openLobby.id)).limit(1))[0]?.status).toBe('active')
      expect((await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, openLobby.id)).limit(1))[0]?.phase).toBe('active')
    }
    finally {
      console.warn = originalConsoleWarn
      console.error = originalConsoleError
      console.log = originalConsoleLog
      sqlite.close()
    }
  })

  test('connecting to a cancelled draft room recovers a missed lifecycle sync', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const d1 = createSqliteD1Database(sqlite)
    const env: { DB?: D1Database, KV?: KVNamespace, CIVUP_SECRET?: string } = { DB: d1, KV: kv, CIVUP_SECRET: 'secret' }
    const room = new SessionDO(createFakeDurableObjectState(), env as any)
    const openLobby = buildLobby({
      memberPlayerIds: ['p1', 'p2'],
      slots: ['p1', 'p2'],
    })
    const accessToken = await createSessionAccessToken('secret', {
      userId: 'p1',
      sessionId: openLobby.id,
      channelId: openLobby.channelId,
    })
    const originalConsoleWarn = console.warn
    const originalConsoleError = console.error
    const originalConsoleLog = console.log
    console.warn = (() => {}) as typeof console.warn
    console.error = (() => {}) as typeof console.error
    console.log = (() => {}) as typeof console.log

    try {
      await createSessionFromLobby(room, openLobby, [
        { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
        { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 11 },
      ])
      await startDraft(room, { hostId: 'p1', now: 20 })

      const connection = createFakeConnection()
      await room.onConnect(connection.connection, { request: draftStatusRequest(accessToken) } as any)

      env.DB = undefined
      await room.onMessage(connection.connection, JSON.stringify({ type: 'cancel', reason: 'cancel' }))

      expect((await getSessionRecordBody(room)).phase).toBe('draft')
      expect((await db.select().from(matches).where(eq(matches.id, openLobby.id)).limit(1))[0]?.status).toBe('drafting')

      env.DB = d1
      const reconnect = createFakeConnection()
      await room.onConnect(reconnect.connection, { request: draftStatusRequest(accessToken) } as any)

      const record = await getSessionRecordBody(room)
      expect(record.phase).toBe('cancelled')
      expect(record.lifecycleSync).toBeNull()
      expect((await db.select().from(matches).where(eq(matches.id, openLobby.id)).limit(1))[0]?.status).toBe('cancelled')
      expect((await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, openLobby.id)).limit(1))[0]?.phase).toBe('cancelled')
    }
    finally {
      console.warn = originalConsoleWarn
      console.error = originalConsoleError
      console.log = originalConsoleLog
      sqlite.close()
    }
  })

  test('pending terminal lifecycle sync retries from alarm after transient backend outage', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const d1 = createSqliteD1Database(sqlite)
    const env: { DB?: D1Database, KV?: KVNamespace } = { DB: d1, KV: kv }
    const room = new SessionDO(createFakeDurableObjectState(), env as any)
    const openLobby = buildLobby({
      memberPlayerIds: ['p1', 'p2'],
      slots: ['p1', 'p2'],
    })
    const originalDateNow = Date.now
    const originalConsoleWarn = console.warn
    console.warn = (() => {}) as typeof console.warn

    try {
      await createSessionFromLobby(room, openLobby, [
        { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
        { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 11 },
      ])
      const started = await startDraft(room, { hostId: 'p1', now: 20 })
      const completed = await room.fetch(sessionRequest('/commands/draft-lifecycle-sync', {
        method: 'POST',
        body: JSON.stringify({ ...buildCompletePayload(openLobby.id, started.seats), finalized: true }),
      }))
      expect(completed.status).toBe(200)
      const finalized = await room.fetch(sessionRequest('/commands/draft-lifecycle', {
        method: 'POST',
        body: JSON.stringify({ type: 'draft-finalized', at: 35 }),
      }))
      expect(finalized.status).toBe(200)
      await db.insert(matchBans).values({ matchId: openLobby.id, civId: 'aztec', bannedBy: 'p1', phase: 0 })

      env.DB = undefined
      Date.now = () => 1_000
      const deferred = await room.fetch(sessionRequest('/commands/session-lifecycle', {
        method: 'POST',
        body: JSON.stringify({ type: 'mark-reported', matchId: openLobby.id, reportedById: 'p1', at: 40 }),
      }))

      expect(deferred.status).toBe(503)
      const pending = await getSessionRecordBody(room)
      expect(pending.phase).toBe('reported')
      expect(pending.terminalSync).toMatchObject({
        command: expect.objectContaining({ type: 'mark-reported', matchId: openLobby.id, reportedById: 'p1', at: 40 }),
        attempts: 1,
        nextRetryAt: 2_000,
      })
      expect((await db.select().from(matches).where(eq(matches.id, openLobby.id)).limit(1))[0]?.status).toBe('active')
      expect(await db.select().from(matchBans).where(eq(matchBans.matchId, openLobby.id))).toHaveLength(1)

      env.DB = d1
      Date.now = () => 2_000
      await room.onAlarm()

      const record = await getSessionRecordBody(room)
      expect(record.phase).toBe('reported')
      expect(record.terminalSync).toBeNull()
      const [match] = await db.select().from(matches).where(eq(matches.id, openLobby.id)).limit(1)
      expect(match).toMatchObject({ status: 'completed', completedAt: 40 })
      expect(JSON.parse(match!.draftData ?? '{}').reportedById).toBe('p1')
      expect((await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, openLobby.id)).limit(1))[0]).toMatchObject({ phase: 'reported', closedAt: 40 })
      expect(await db.select().from(matchBans).where(eq(matchBans.matchId, openLobby.id))).toHaveLength(0)
    }
    finally {
      Date.now = originalDateNow
      console.warn = originalConsoleWarn
      sqlite.close()
    }
  })

  test('terminal lifecycle sync reports linked tournament matches', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const room = new SessionDO(createFakeDurableObjectState(), {
      DB: createSqliteD1Database(sqlite),
      KV: kv,
    } as any)
    const openLobby = buildLobby({
      memberPlayerIds: ['p1', 'p2'],
      slots: ['p1', 'p2'],
    })

    try {
      await createSessionFromLobby(room, openLobby, [
        { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
        { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 11 },
      ])
      await startDraft(room, { hostId: 'p1', now: 20 })
      await insertDraftingQualifierTournamentLink(db, openLobby.id, openLobby.id)
      await db.update(matchParticipants).set({ placement: 1 }).where(eq(matchParticipants.playerId, 'p1'))
      await db.update(matchParticipants).set({ placement: 2 }).where(eq(matchParticipants.playerId, 'p2'))
      const completed = await room.fetch(sessionRequest('/commands/draft-lifecycle', {
        method: 'POST',
        body: JSON.stringify({ type: 'draft-completed', opensSwapWindow: false, at: 30 }),
      }))
      expect(completed.status).toBe(200)

      await sessionLifecycleCommand(room, { type: 'mark-reported', matchId: openLobby.id, at: 40 })

      const [link] = await db.select().from(tournamentMatches).where(eq(tournamentMatches.sessionId, openLobby.id)).limit(1)
      expect(link).toMatchObject({ status: 'reported', winnerId: 'p1' })
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

    const staleRawResponse = await room.fetch(sessionRequest('/commands/open-lobby', {
      method: 'POST',
      body: JSON.stringify({
        type: 'set-steam-lobby-link',
        expectedVersion: 1,
        now: 30,
        steamLobbyLink: 'steam://join/stale',
      }),
    }))
    expect(staleRawResponse.status).toBe(409)
    expect((await staleRawResponse.json() as any).error).toContain('Session version is stale')
    const staleRecord = await getSessionRecordBody(room)
    expect(staleRecord.version).toBe(2)
    expect(staleRecord.projectionState.steamLobbyLink).toBeNull()

    const futureRawResponse = await room.fetch(sessionRequest('/commands/open-lobby', {
      method: 'POST',
      body: JSON.stringify({
        type: 'set-steam-lobby-link',
        expectedVersion: 99,
        now: 30,
        steamLobbyLink: 'steam://join/future',
      }),
    }))
    expect(futureRawResponse.status).toBe(409)
    expect((await futureRawResponse.json() as any).error).toContain('Session version is mismatched')
    const futureRecord = await getSessionRecordBody(room)
    expect(futureRecord.version).toBe(2)
    expect(futureRecord.projectionState.steamLobbyLink).toBeNull()

    const projectionStaleRawResponse = await room.fetch(sessionRequest('/commands/session-projection', {
      method: 'POST',
      body: JSON.stringify({
        type: 'set-steam-lobby-link',
        expectedVersion: 1,
        now: 30,
        steamLobbyLink: 'steam://join/stale',
      }),
    }))
    expect(projectionStaleRawResponse.status).toBe(409)

    const projectionFutureRawResponse = await room.fetch(sessionRequest('/commands/session-projection', {
      method: 'POST',
      body: JSON.stringify({
        type: 'set-steam-lobby-link',
        expectedVersion: 99,
        now: 30,
        steamLobbyLink: 'steam://join/future',
      }),
    }))
    expect(projectionFutureRawResponse.status).toBe(409)
    expect((await projectionFutureRawResponse.json() as any).error).toContain('Session version is mismatched')

    const noOpResponse = await openLobbyCommand(room, {
      type: 'set-steam-lobby-link',
      expectedVersion: 2,
      now: 30,
      steamLobbyLink: null,
    })
    expect(noOpResponse.record.version).toBe(2)
    expect(noOpResponse.record.projectionState.steamLobbyLink).toBeNull()

    const rosterResponse = await openLobbyCommand(room, {
      type: 'set-roster',
      expectedVersion: 2,
      now: 31,
      memberPlayerIds: ['p1', 'p2'],
      slots: ['p1', 'p2'],
      lastActivityAt: 31,
      queueEntries: [
        { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10, sourceGuild: { id: '111111111111111111' } },
        { playerId: 'p2', displayName: 'Player Two', avatarUrl: 'avatar-2', joinedAt: 11, sourceGuild: { id: '111111111111111111' } },
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

  test('draft start retries repair match creation after canonical draft commit', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const d1 = createFailingQueryD1(createSqliteD1Database(sqlite), query => query.toLowerCase().includes('insert into') && query.toLowerCase().includes('matches'))
    const originalConsoleWarn = console.warn
    const originalRandom = Math.random
    console.warn = (() => {}) as typeof console.warn
    const room = new SessionDO(createFakeDurableObjectState(), {
      DB: d1.database,
      KV: kv,
    } as any)
    const openLobby = buildLobby({
      memberPlayerIds: ['p1', 'p2'],
      slots: ['p1', 'p2'],
    })

    try {
      await createSessionFromLobby(room, openLobby, [
        { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
        { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 11 },
      ])

      Math.random = () => 0
      d1.failNextMatchingQuery()
      const failedStart = await room.fetch(sessionRequest('/commands/start-draft', {
        method: 'POST',
        body: JSON.stringify({ hostId: 'p1', now: 20 }),
      }))
      expect(failedStart.status).toBe(503)
      const pending = await getSessionRecordBody(room)
      expect(pending.phase).toBe('draft')
      expect(pending.draftStartSync).toMatchObject({ attempts: 1 })
      expect(pending.roster.slots).toEqual(['p2', 'p1'])
      expect(await db.select().from(matches).where(eq(matches.id, openLobby.id))).toHaveLength(0)

      Math.random = () => 0.999
      const retried = await startDraft(room, { hostId: 'p1', now: 21 })
      expect(retried.matchId).toBe(openLobby.id)
      const record = await getSessionRecordBody(room)
      expect(record.phase).toBe('draft')
      expect(record.draftStartSync).toBeNull()
      expect(record.roster.slots).toEqual(['p2', 'p1'])
      expect(await db.select().from(matches).where(eq(matches.id, openLobby.id))).toHaveLength(1)
      const [directoryRow] = await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, openLobby.id)).limit(1)
      expect(JSON.parse(directoryRow!.rosterJson).slots).toEqual(['p2', 'p1'])
    }
    finally {
      console.warn = originalConsoleWarn
      Math.random = originalRandom
      sqlite.close()
    }
  })

  test('selected draft socket connect repairs pending draft start sync', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const d1 = createFailingQueryD1(createSqliteD1Database(sqlite), query => query.toLowerCase().includes('insert into') && query.toLowerCase().includes('matches'))
    const originalConsoleWarn = console.warn
    console.warn = (() => {}) as typeof console.warn
    const room = new SessionDO(createFakeDurableObjectState(), {
      CIVUP_SECRET: 'secret',
      DB: d1.database,
      KV: kv,
    } as any)
    const openLobby = buildLobby({
      memberPlayerIds: ['p1', 'p2'],
      slots: ['p1', 'p2'],
    })
    const accessToken = await createSessionAccessToken('secret', {
      userId: 'p1',
      sessionId: openLobby.id,
      channelId: openLobby.channelId,
    })

    try {
      await createSessionFromLobby(room, openLobby, [
        { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
        { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 11 },
      ])

      d1.failNextMatchingQuery()
      const failedStart = await room.fetch(sessionRequest('/commands/start-draft', {
        method: 'POST',
        body: JSON.stringify({ hostId: 'p1', now: 20 }),
      }))
      expect(failedStart.status).toBe(503)
      expect((await getSessionRecordBody(room)).draftStartSync).toMatchObject({ attempts: 1 })
      expect(await db.select().from(matches).where(eq(matches.id, openLobby.id))).toHaveLength(0)

      const connection = createFakeConnection()
      await room.onConnect(connection.connection, { request: draftStatusRequest(accessToken) } as any)

      expect(connection.closed).toBeNull()
      expect(connection.messages[0]).toMatchObject({
        type: 'init',
        state: {
          matchId: openLobby.id,
          status: 'waiting',
        },
      })
      expect((await getSessionRecordBody(room)).draftStartSync).toBeNull()
      expect(await db.select().from(matches).where(eq(matches.id, openLobby.id))).toHaveLength(1)
    }
    finally {
      console.warn = originalConsoleWarn
      sqlite.close()
    }
  })

  test('older lifecycle events cannot overwrite newer pending lifecycle sync', async () => {
    const { sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const d1 = createSqliteD1Database(sqlite)
    const env: { DB?: D1Database, KV?: KVNamespace } = { DB: d1, KV: kv }
    const room = new SessionDO(createFakeDurableObjectState(), env as any)
    const openLobby = buildLobby({
      memberPlayerIds: ['p1', 'p2'],
      slots: ['p1', 'p2'],
    })
    const originalConsoleWarn = console.warn
    console.warn = (() => {}) as typeof console.warn

    try {
      await createSessionFromLobby(room, openLobby, [
        { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
        { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 11 },
      ])
      const started = await startDraft(room, { hostId: 'p1', now: 20 })
      const newerPayload = { ...buildCompletePayload(openLobby.id, started.seats), eventId: `${openLobby.id}:complete:2`, eventSequence: 2 }
      const olderPayload = { ...buildCompletePayload(openLobby.id, started.seats), eventId: `${openLobby.id}:complete:1`, eventSequence: 1 }

      env.DB = undefined
      const deferred = await room.fetch(sessionRequest('/commands/draft-lifecycle-sync', {
        method: 'POST',
        body: JSON.stringify(newerPayload),
      }))
      expect(deferred.status).toBe(503)

      const ignored = await room.fetch(sessionRequest('/commands/draft-lifecycle-sync', {
        method: 'POST',
        body: JSON.stringify(olderPayload),
      }))
      expect(ignored.status).toBe(200)
      const body = await ignored.json() as any
      expect(body.ignored).toBe(true)
      expect((await getSessionRecordBody(room)).lifecycleSync?.payload.eventSequence).toBe(2)
    }
    finally {
      console.warn = originalConsoleWarn
      sqlite.close()
    }
  })

  test('terminal lifecycle rejects missing match rows before marking terminal', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const room = new SessionDO(createFakeDurableObjectState(), {
      DB: createSqliteD1Database(sqlite),
      KV: kv,
    } as any)
    const openLobby = buildLobby({
      memberPlayerIds: ['p1', 'p2'],
      slots: ['p1', 'p2'],
    })

    try {
      await createSessionFromLobby(room, openLobby, [
        { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
        { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 11 },
      ])
      await startDraft(room, { hostId: 'p1', now: 20 })
      const completed = await room.fetch(sessionRequest('/commands/draft-lifecycle', {
        method: 'POST',
        body: JSON.stringify({ type: 'draft-completed', opensSwapWindow: false, at: 30 }),
      }))
      expect(completed.status).toBe(200)
      await db.delete(matchParticipants).where(eq(matchParticipants.matchId, openLobby.id))
      await db.delete(matchBans).where(eq(matchBans.matchId, openLobby.id))
      await db.delete(matches).where(eq(matches.id, openLobby.id))

      const missing = await room.fetch(sessionRequest('/commands/session-lifecycle', {
        method: 'POST',
        body: JSON.stringify({ type: 'mark-reported', matchId: openLobby.id, at: 40 }),
      }))
      expect(missing.status).toBe(409)
      expect((await missing.json() as any).error).toContain('not found')
      expect((await getSessionRecordBody(room)).phase).toBe('active')
    }
    finally {
      sqlite.close()
    }
  })

  test('reported Discord repair preserves tournament result images', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const d1 = createSqliteD1Database(sqlite)
    const room = new SessionDO(createFakeDurableObjectState(), {
      DB: d1,
      KV: kv,
      DISCORD_TOKEN: 'token',
      ALLOWED_DISCORD_GUILD_ID: '111111111111111111',
    } as any)
    const openLobby = buildLobby({
      memberPlayerIds: ['p1', 'p2'],
      slots: ['p1', 'p2'],
    })
    const requests: Array<{ method: string, url: string, contentType: string | null }> = []

    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.url.includes('cdn.discordapp.com')) return new Response('not found', { status: 404 })
      requests.push({ method: request.method, url: request.url, contentType: request.headers.get('content-type') })
      if (request.method === 'PATCH' && request.url.includes('/channels/channel-1/messages/message-1')) {
        return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
      }
      if (request.method === 'POST' && request.url.includes('/channels/tournament-archive/messages')) {
        return new Response(JSON.stringify({ id: 'archive-message' }), { headers: { 'Content-Type': 'application/json' } })
      }
      return new Response('unexpected request', { status: 500 })
    }) as typeof fetch

    try {
      await createSessionFromLobby(room, openLobby, [
        { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
        { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 11 },
      ])
      await startDraft(room, { hostId: 'p1', now: 20 })
      await insertDraftingTournamentLink(db, openLobby.id, openLobby.id)
      await kv.put('system:channel:tournament-archive', 'tournament-archive')
      await db.update(matches).set({ status: 'completed', completedAt: 40 }).where(eq(matches.id, openLobby.id))
      await db.update(matchParticipants).set({ civId: null, placement: 1 }).where(eq(matchParticipants.playerId, 'p1'))
      await db.update(matchParticipants).set({ civId: null, placement: 2 }).where(eq(matchParticipants.playerId, 'p2'))

      const response = await room.fetch(sessionRequest('/commands/reported-discord-sync', {
        method: 'POST',
        body: JSON.stringify({ matchId: openLobby.id }),
      }))

      expect(response.status).toBe(200)
      expect(requests).toEqual([
        expect.objectContaining({ method: 'PATCH', url: 'https://discord.com/api/v10/channels/channel-1/messages/message-1' }),
        expect.objectContaining({ method: 'POST', url: 'https://discord.com/api/v10/channels/tournament-archive/messages' }),
      ])
      expect(requests.every(request => request.contentType?.startsWith('multipart/form-data'))).toBe(true)
    }
    finally {
      sqlite.close()
    }
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

async function createSessionFromLobby(room: SessionDO, lobby: ReturnType<typeof buildLobby>, queueEntries: unknown[]): Promise<any> {
  const entries = queueEntries.map((entry) => {
    if (!entry || typeof entry !== 'object' || 'sourceGuild' in entry) return entry
    return { ...entry, sourceGuild: { id: lobby.guildId } }
  })
  const response = await room.fetch(sessionRequest('/commands/create-from-lobby', {
    method: 'POST',
    body: JSON.stringify({ lobby, queueEntries: entries }),
  }))
  expect(response.status).toBe(200)
  return await response.json()
}

async function startDraft(room: SessionDO, command: unknown): Promise<any> {
  const response = await room.fetch(sessionRequest('/commands/start-draft', {
    method: 'POST',
    body: JSON.stringify(command),
  }))
  expect(response.status).toBe(200)
  return await response.json()
}

async function sessionLifecycleCommand(room: SessionDO, command: unknown): Promise<any> {
  const response = await room.fetch(sessionRequest('/commands/session-lifecycle', {
    method: 'POST',
    body: JSON.stringify(command),
  }))
  expect(response.status).toBe(200)
  return await response.json()
}

async function getSessionRecordBody(room: SessionDO): Promise<any> {
  const response = await room.fetch(sessionRequest('/record'))
  expect(response.status).toBe(200)
  const body = await response.json() as any
  return body.record
}

async function insertDraftingTournamentLink(db: any, sessionId: string, matchId: string): Promise<void> {
  const now = Date.now()
  await db.insert(tournaments).values({
    id: 'tournament-session-test',
    name: 'Session Test Cup',
    mode: '1v1',
    status: 'top_cut',
    scoring: 'open_win_rate',
    rematchPolicy: 'warn',
    minGames: 6,
    topCut: 8,
    roleId: null,
    createdById: 'admin',
    createdAt: now,
    updatedAt: now,
  })
  await insertTournamentEntryFixtures(db, 'tournament-session-test', now)
  await db.insert(tournamentMatches).values({
    sessionId,
    tournamentId: 'tournament-session-test',
    matchId,
    stage: 'semifinal',
    status: 'drafting',
    playerOneId: null,
    playerTwoId: null,
    winnerId: 'p1',
    entryOneId: 'tournament-session-test-entry-p1',
    entryTwoId: 'tournament-session-test-entry-p2',
    winnerEntryId: 'tournament-session-test-entry-p1',
    createdAt: now,
    updatedAt: now,
  })
  await db.insert(tournamentCutPairings).values({
    id: `${sessionId}-pairing`,
    tournamentId: 'tournament-session-test',
    round: 'semifinal',
    seedOne: 1,
    seedTwo: 2,
    playerOneId: null,
    playerTwoId: null,
    sessionId,
    matchId,
    winnerId: 'p1',
    entryOneId: 'tournament-session-test-entry-p1',
    entryTwoId: 'tournament-session-test-entry-p2',
    winnerEntryId: 'tournament-session-test-entry-p1',
    status: 'drafting',
    createdAt: now,
    updatedAt: now,
  })
}

async function insertDraftingQualifierTournamentLink(db: any, sessionId: string, matchId: string): Promise<void> {
  const now = Date.now()
  await db.insert(tournaments).values({
    id: 'tournament-qualifier-session-test',
    name: 'Session Test Cup',
    mode: '1v1',
    status: 'qualifier',
    scoring: 'open_win_rate',
    rematchPolicy: 'warn',
    minGames: 6,
    topCut: 8,
    roleId: null,
    createdById: 'admin',
    createdAt: now,
    updatedAt: now,
  })
  await insertTournamentEntryFixtures(db, 'tournament-qualifier-session-test', now)
  await db.insert(tournamentMatches).values({
    sessionId,
    tournamentId: 'tournament-qualifier-session-test',
    matchId,
    stage: 'qualifier',
    status: 'drafting',
    playerOneId: 'p1',
    playerTwoId: 'p2',
    winnerId: null,
    entryOneId: 'tournament-qualifier-session-test-entry-p1',
    entryTwoId: 'tournament-qualifier-session-test-entry-p2',
    winnerEntryId: null,
    createdAt: now,
    updatedAt: now,
  })
}

async function insertTournamentEntryFixtures(db: any, tournamentId: string, now: number): Promise<void> {
  await db.insert(tournamentEntries).values([
    { id: `${tournamentId}-entry-p1`, tournamentId, seed: 1, status: 'active', createdAt: now, updatedAt: now },
    { id: `${tournamentId}-entry-p2`, tournamentId, seed: 2, status: 'active', createdAt: now, updatedAt: now },
  ])
  await db.insert(tournamentEntryMembers).values([
    { entryId: `${tournamentId}-entry-p1`, tournamentId, position: 0, playerId: 'p1', displayName: 'Player One', avatarUrl: null, active: true, linkedAt: now, createdAt: now, updatedAt: now },
    { entryId: `${tournamentId}-entry-p2`, tournamentId, position: 0, playerId: 'p2', displayName: 'Player Two', avatarUrl: null, active: true, linkedAt: now, createdAt: now, updatedAt: now },
  ])
}

function buildCompletePayload(matchId: string, seats: DraftSeat[]) {
  const completedAt = 30
  return {
    eventId: `${matchId}:complete:1`,
    eventKind: 'DraftCompleted',
    eventSequence: 1,
    outcome: 'complete',
    matchId,
    hostId: seats[0]?.playerId,
    completedAt,
    state: {
      matchId,
      formatId: 'default-1v1',
      seats,
      steps: [],
      currentStepIndex: 0,
      submissions: {},
      bans: [],
      picks: seats.map((_, seatIndex) => ({
        civId: allLeaderIds[seatIndex] ?? allLeaderIds[0]!,
        seatIndex,
        stepIndex: seatIndex,
      })),
      availableCivIds: [],
      status: 'complete',
      cancelReason: null,
    } satisfies DraftState,
  }
}

function buildCancelledPayload(matchId: string, seats: DraftSeat[], reason: 'cancel' | 'scrub' | 'timeout' | 'revert') {
  const cancelledAt = 30
  return {
    eventId: `${matchId}:cancelled:${reason}:1`,
    eventKind: 'DraftCancelled',
    eventSequence: 1,
    outcome: 'cancelled',
    matchId,
    hostId: seats[0]?.playerId,
    cancelledAt,
    reason,
    state: {
      matchId,
      formatId: 'default-1v1',
      seats,
      steps: [],
      currentStepIndex: 0,
      submissions: {},
      bans: [],
      picks: [],
      availableCivIds: [],
      status: 'cancelled',
      cancelReason: reason,
    } satisfies DraftState,
  }
}

function createFailingSessionDirectoryD1(base: D1Database) {
  let pendingSessionDirectoryFailures = 0
  return {
    database: {
      ...base,
      prepare(query: string) {
        return wrapFailingStatement(base.prepare(query), query, () => {
          if (pendingSessionDirectoryFailures <= 0) return false
          if (!query.includes('session_directory')) return false
          pendingSessionDirectoryFailures -= 1
          return true
        })
      },
    } as D1Database,
    failNextSessionDirectoryWrite() {
      pendingSessionDirectoryFailures += 1
    },
  }
}

function createFailingQueryD1(base: D1Database, matchesQuery: (query: string) => boolean) {
  let pendingFailures = 0
  return {
    database: {
      ...base,
      prepare(query: string) {
        return wrapFailingStatement(base.prepare(query), query, () => {
          if (pendingFailures <= 0) return false
          if (!matchesQuery(query)) return false
          pendingFailures -= 1
          return true
        })
      },
    } as D1Database,
    failNextMatchingQuery() {
      pendingFailures += 1
    },
  }
}

function wrapFailingStatement(
  statement: D1PreparedStatement,
  query: string,
  shouldFail: () => boolean,
): D1PreparedStatement {
  return {
    ...statement,
    bind(...values: unknown[]) {
      return wrapFailingBoundStatement(statement.bind(...values), query, shouldFail)
    },
  } as D1PreparedStatement
}

function wrapFailingBoundStatement(
  statement: D1PreparedStatement,
  query: string,
  shouldFail: () => boolean,
): D1PreparedStatement {
  const maybeFail = () => {
    if (shouldFail()) throw new Error(`Injected D1 failure for ${query}`)
  }
  return {
    ...statement,
    bind(...values: unknown[]) {
      return wrapFailingBoundStatement(statement.bind(...values), query, shouldFail)
    },
    async first(columnName?: string) {
      maybeFail()
      return await statement.first(columnName)
    },
    async run() {
      maybeFail()
      return await statement.run()
    },
    async all() {
      maybeFail()
      return await statement.all()
    },
    async raw() {
      maybeFail()
      return await statement.raw()
    },
  } as D1PreparedStatement
}

function sessionRequest(pathname: string, init?: RequestInit): Request {
  const headers = new Headers(init?.headers)
  headers.set(PARTYSERVER_ROOM_HEADER, 'session-1')
  headers.set(PARTYSERVER_NAMESPACE_HEADER, 'session')
  return new Request(`https://session.local${pathname}`, { ...init, headers })
}

function draftStatusRequest(accessToken: string): Request {
  return sessionRequest(`/?accessToken=${encodeURIComponent(accessToken)}`, {
    headers: {
      'X-CivUp-Internal-Secret': 'secret',
      'X-CivUp-Activity-User-Id': 'p1',
      'X-CivUp-Activity-Guild-Id': '111111111111111111',
    },
  })
}

type FakeDurableObjectState = DurableObjectState & { __webSockets: WebSocket[] }

function createFakeDurableObjectState(): FakeDurableObjectState {
  return createFakeDurableObjectStateWithStorage().state
}

function createFakeDurableObjectStateWithStorage(): { state: FakeDurableObjectState, storage: Map<string, unknown> } {
  const storage = new Map<string, unknown>()
  const webSockets: WebSocket[] = []
  let alarmAt: number | null = null
  const state = {
    __webSockets: webSockets,
    async blockConcurrencyWhile(callback: () => Promise<void> | void) {
      await callback()
    },
    waitUntil(promise: Promise<unknown>) {
      void promise.catch(() => {})
    },
    getWebSockets() {
      return webSockets
    },
    acceptWebSocket(socket: WebSocket) {
      webSockets.push(socket)
    },
    storage: {
      async get(key: string) {
        return storage.get(key)
      },
      async put(key: string, value: unknown) {
        storage.set(key, value)
      },
      async delete(key: string) {
        return storage.delete(key)
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
  } as unknown as FakeDurableObjectState
  return { state, storage }
}

function addFakeAcceptedConnection(state: DurableObjectState, connection: WebSocket) {
  const webSockets = (state as Partial<FakeDurableObjectState>).__webSockets
  if (!webSockets) throw new Error('Fake DurableObjectState is missing web socket storage')
  webSockets.push(connection)
}

function createFakeConnection() {
  const messages: any[] = []
  let attachment: unknown = null
  let connectionState: unknown = null
  let closed: { code: number, reason: string } | null = null
  let readyState = 1
  return {
    messages,
    get closed() {
      return closed
    },
    connection: {
      send(message: string) {
        messages.push(JSON.parse(message))
      },
      close(code = 1000, reason = '') {
        readyState = 3
        closed = { code, reason }
      },
      setState(state: unknown) {
        connectionState = state
      },
      serializeAttachment(value: unknown) {
        attachment = value
      },
      deserializeAttachment() {
        return attachment
      },
      get state() {
        return connectionState
      },
      get readyState() {
        return readyState
      },
    } as any,
  }
}

function buildLobby(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    mode: '1v1',
    status: 'open',
    guildId: '111111111111111111',
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

function buildActiveSessionRecord(overrides: Record<string, unknown> = {}) {
  const id = typeof overrides.id === 'string' ? overrides.id : 'legacy-active-match'
  const matchId = typeof overrides.matchId === 'string' ? overrides.matchId : id
  return {
    id,
    phase: 'active',
    version: 1,
    hostId: 'p1',
    guildId: '111111111111111111',
    channelId: 'channel-1',
    mode: '1v1',
    matchId,
    config: { ...DEFAULT_DRAFT_CONFIG, minRole: null, maxRole: null },
    roster: {
      participants: [
        { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 1_700_000_000_000, slotIndex: 0 },
        { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 1_700_000_000_000, slotIndex: 1 },
      ],
      slots: ['p1', 'p2'],
    },
    lastArrange: null,
    projectionState: {
      channelId: 'channel-1',
      messageId: 'message-1',
      steamLobbyLink: null,
    },
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_050_000,
    lastActivityAt: 1_700_000_050_000,
    closedAt: null,
    frozenAt: 1_700_000_000_000,
    draftStartSync: null,
    lifecycleEventSequence: 0,
    lifecycleSync: null,
    projectionSync: null,
    terminalSync: null,
    ...overrides,
  }
}
