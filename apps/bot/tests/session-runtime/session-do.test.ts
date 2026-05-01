import type { DraftSeat, DraftState } from '@civup/game'
import { afterEach, describe, expect, test } from 'bun:test'
import { matchBans, matchParticipants, matches, players, sessionDirectory } from '@civup/db'
import { allLeaderIds } from '@civup/game'
import { createSessionAccessToken, PARTYSERVER_NAMESPACE_HEADER, PARTYSERVER_ROOM_HEADER } from '@civup/utils'
import { eq } from 'drizzle-orm'
import { DEFAULT_DRAFT_CONFIG } from '../../src/services/lobby/normalize.ts'
import { createDraftMatch } from '../../src/services/match/draft.ts'
import { SessionDO } from '../../src/session-runtime/session-do.ts'
import { createSqliteD1Database } from '../helpers/d1.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const originalFetch = globalThis.fetch

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
      expect(body.record.roster.slots).toEqual(['p1', 'p2'])

      const [finalDirectoryRow] = await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, openLobby.id)).limit(1)
      expect(finalDirectoryRow?.phase).toBe('active')
    }
    finally {
      sqlite.close()
    }
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
      let [directoryRow] = await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, openLobby.id)).limit(1)
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
      expect(terminalMatchRow).toMatchObject({ status: 'cancelled', completedAt: 50 })

      const resolved = await sessionLifecycleCommand(room, { type: 'mark-reported', matchId: openLobby.id, at: 60 })
      expect(resolved.record).toMatchObject({ phase: 'reported', version: 6, closedAt: 60 })

      const [reportedDirectoryRow] = await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, openLobby.id)).limit(1)
      expect(reportedDirectoryRow).toMatchObject({ phase: 'reported', closedAt: 60 })
      const [reportedMatchRow] = await db.select().from(matches).where(eq(matches.id, openLobby.id)).limit(1)
      expect(reportedMatchRow).toMatchObject({ status: 'completed', completedAt: 50 })
    }
    finally {
      console.warn = originalConsoleWarn
      sqlite.close()
    }
  })

  test('terminal cancellation closes stale draft runtime access', async () => {
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

    try {
      await createSessionFromLobby(room, openLobby, [
        { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
        { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 11 },
      ])
      await startDraft(room, { hostId: 'p1', now: 20 })

      const draftConnection = createFakeConnection()
      draftConnection.connection.setState({ playerId: 'p1' })
      const connections = (room as any).connections as Set<unknown>
      connections.add(draftConnection.connection)

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

  test('opens imported active sessions without an initialized draft room', async () => {
    const { db, sqlite } = await createTestDatabase()
    const { state, storage } = createFakeDurableObjectStateWithStorage()
    const room = new SessionDO(state, {
      DB: createSqliteD1Database(sqlite),
      CIVUP_SECRET: 'secret',
    } as any)
    const matchId = 'legacy-active-match'

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
        draftData: JSON.stringify({ completedAt: 1_700_000_050_000 }),
        createdAt: 1_700_000_000_000,
        completedAt: null,
      })
      await db.insert(matchParticipants).values([
        { matchId, playerId: 'p1', team: 0, civId: 'greece-gorgo', placement: null },
        { matchId, playerId: 'p2', team: 1, civId: 'babylon-hammurabi', placement: null },
      ])
      storage.set('session-record', buildActiveSessionRecord({ id: matchId, matchId }))

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
          status: 'complete',
          seats: [
            { playerId: 'p1', displayName: 'Player One', team: 0 },
            { playerId: 'p2', displayName: 'Player Two', team: 1 },
          ],
          picks: [
            { seatIndex: 0, civId: 'greece-gorgo' },
            { seatIndex: 1, civId: 'babylon-hammurabi' },
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

      const firstStart = await startDraft(room, { hostId: 'p1', now: 20 })
      const retryStart = await startDraft(room, { hostId: 'p1', now: 21 })

      expect(firstStart.matchId).toBe(openLobby.id)
      expect(firstStart.seats).toHaveLength(2)
      expect(retryStart).toMatchObject({ matchId: openLobby.id, idempotent: true })
      expect(retryStart.seats).toEqual(firstStart.seats)
      const record = await getSessionRecordBody(room)
      expect(record.phase).toBe('draft')
      expect(record.version).toBe(2)
    }
    finally {
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
          { playerId: 'p1', displayName: 'Player One', avatarUrl: null, joinedAt: 10 },
          { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, joinedAt: 11 },
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

  test('revert lifecycle sync pushes the reopened lobby to selected draft sockets', async () => {
    const { sqlite } = await createTestDatabase()
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
      const started = await startDraft(room, { hostId: 'p1', now: 20 })
      const draftConnection = createFakeConnection()
      draftConnection.connection.setState({ playerId: 'p2' })
      const connections = (room as any).connections as Set<unknown>
      connections.add(draftConnection.connection)

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
        },
      })
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

      await createDraftMatch(db, { matchId: openLobby.id, mode: '1v1', seats: started.seats })

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
    const openLobby = buildLobby({
      memberPlayerIds: ['p1', 'p2'],
      slots: ['p1', 'p2'],
      draftConfig: { ...DEFAULT_DRAFT_CONFIG, hiddenDraft: true },
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

  test('draft start retries repair match creation after canonical draft commit', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const d1 = createFailingQueryD1(createSqliteD1Database(sqlite), query => query.toLowerCase().includes('insert into') && query.toLowerCase().includes('matches'))
    const originalConsoleWarn = console.warn
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

      d1.failNextMatchingQuery()
      const failedStart = await room.fetch(sessionRequest('/commands/start-draft', {
        method: 'POST',
        body: JSON.stringify({ hostId: 'p1', now: 20 }),
      }))
      expect(failedStart.status).toBe(503)
      const pending = await getSessionRecordBody(room)
      expect(pending.phase).toBe('draft')
      expect(pending.draftStartSync).toMatchObject({ attempts: 1 })
      expect(await db.select().from(matches).where(eq(matches.id, openLobby.id))).toHaveLength(0)

      const retried = await startDraft(room, { hostId: 'p1', now: 21 })
      expect(retried.matchId).toBe(openLobby.id)
      const record = await getSessionRecordBody(room)
      expect(record.phase).toBe('draft')
      expect(record.draftStartSync).toBeNull()
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
  const response = await room.fetch(sessionRequest('/commands/create-from-lobby', {
    method: 'POST',
    body: JSON.stringify({ lobby, queueEntries }),
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
    },
  })
}

function createFakeDurableObjectState(): DurableObjectState {
  return createFakeDurableObjectStateWithStorage().state
}

function createFakeDurableObjectStateWithStorage(): { state: DurableObjectState, storage: Map<string, unknown> } {
  const storage = new Map<string, unknown>()
  let alarmAt: number | null = null
  const state = {
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
  } as unknown as DurableObjectState
  return { state, storage }
}

function createFakeConnection() {
  const messages: any[] = []
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

function buildActiveSessionRecord(overrides: Record<string, unknown> = {}) {
  const id = typeof overrides.id === 'string' ? overrides.id : 'legacy-active-match'
  const matchId = typeof overrides.matchId === 'string' ? overrides.matchId : id
  return {
    id,
    phase: 'active',
    version: 1,
    hostId: 'p1',
    guildId: 'guild-1',
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
