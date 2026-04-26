import type { DraftSeat, DraftState } from '@civup/game'
import { afterEach, describe, expect, test } from 'bun:test'
import { matchBans, matchParticipants, matches, sessionDirectory } from '@civup/db'
import { allLeaderIds } from '@civup/game'
import { eq } from 'drizzle-orm'
import { DEFAULT_DRAFT_CONFIG } from '../../src/services/lobby/normalize.ts'
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

      const cancelled = await room.fetch(sessionRequest('/commands/session-lifecycle', {
        method: 'POST',
        body: JSON.stringify({ type: 'cancel-session', matchId: openLobby.id, at: 50 }),
      }))
      expect(cancelled.status).toBe(409)
      expect(await cancelled.json()).toEqual({ error: 'Reported sessions cannot be cancelled' })

      const [terminalDirectoryRow] = await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, openLobby.id)).limit(1)
      expect(terminalDirectoryRow).toMatchObject({ phase: 'reported', closedAt: 40 })
    }
    finally {
      console.warn = originalConsoleWarn
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
