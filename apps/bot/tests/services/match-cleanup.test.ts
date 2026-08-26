import { matchBans, matchRepairs, matches, matchParticipants, playerRatingEvents, players, sessionDirectory, sessionDirectoryMembers } from '@civup/db'
import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { getChannelForMatch } from '../../src/services/activity/index.ts'
import { pruneAbandonedMatches } from '../../src/services/match/cleanup.ts'
import { getSessionRecord } from '../../src/session-runtime/session-do-client.ts'
import { createLobby, getExistingTestLobbyRuntime, getLobbyById, setLobbyMemberPlayerIds, setLobbySlots, setLobbyStatus, startTestSessionDraft } from '../helpers/lobby-runtime.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const originalFetch = globalThis.fetch
const GUILD_ID = '111111111111111111'

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('match cleanup reconciliation', () => {
  test('clears live lobbies whose backing match is already completed', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const requests: Array<{ url: string, init?: RequestInit }> = []

    globalThis.fetch = (async (input, init) => {
      requests.push({ url: String(input), init })
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch

    try {
      await db.insert(players).values([
        { id: 'host', displayName: 'Host', avatarUrl: null, createdAt: 1 },
        { id: 'player-2', displayName: 'Player 2', avatarUrl: null, createdAt: 1 },
      ])
      const queueEntries = [
        { playerId: 'host', displayName: 'Host', avatarUrl: null, joinedAt: 1 },
        { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null, joinedAt: 1 },
      ]
      const lobby = await createLobby(kv, {
        mode: '1v1',
        hostId: 'host',
        channelId: 'channel-1',
        messageId: 'message-1',
        db,
        queueEntries,
      })
      const matchId = lobby.id
      await db.insert(matches).values({
        id: matchId,
        guildId: GUILD_ID,
        gameMode: '1v1',
        status: 'completed',
        createdAt: 1,
        completedAt: 2,
        seasonId: null,
        draftData: null,
      })
      await db.insert(matchParticipants).values([
        { matchId, playerId: 'host', team: 0, civId: null, placement: 1, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId, playerId: 'player-2', team: 1, civId: null, placement: 2, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ])

      const runtimeOptions = { db, queueEntries }
      const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, ['host', 'player-2'], lobby, runtimeOptions)
      const draftingLobby = await startTestSessionDraft(kv, lobby.id, withMembers ?? lobby, runtimeOptions)
      const activeLobby = await setLobbyStatus(kv, lobby.id, 'active', draftingLobby!)

      const result = await pruneAbandonedMatches(db, kv, { sessionNamespace: getExistingTestLobbyRuntime(kv).sessionNamespace })

      expect(result.removedMatchIds).toEqual([])
      expect(result.clearedLiveLobbyMatchIds).toEqual([matchId])
      expect((await getLobbyById(kv, activeLobby!.id))?.status).toBe('completed')
      expect(await kv.get('lobby:host:host')).toBeNull()
      expect(await getChannelForMatch(db, matchId)).toBeNull()
      const editRequest = requests.find(request => request.init?.method === 'PATCH')
      expect(editRequest).toBeDefined()
      expect(String(editRequest?.init?.body)).toContain('RESULT REPORTED')
    }
    finally {
      sqlite.close()
    }
  })

  test('retains recently cancelled matches so moderators can resolve them later', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      const matchId = 'rated-cancelled-match'
      await db.insert(players).values([
        { id: 'host', displayName: 'Host', avatarUrl: null, createdAt: 1 },
        { id: 'player-2', displayName: 'Player 2', avatarUrl: null, createdAt: 1 },
      ])
      await db.insert(matches).values({
        id: matchId,
        guildId: GUILD_ID,
        gameMode: '1v1',
        status: 'cancelled',
        createdAt: 1,
        completedAt: 2,
        seasonId: null,
        draftData: null,
      })
      await db.insert(matchParticipants).values([
        { matchId, playerId: 'host', team: 0, civId: null, placement: 1, ratingBeforeMu: 25, ratingBeforeSigma: 8.333, ratingAfterMu: 26, ratingAfterSigma: 8 },
        { matchId, playerId: 'player-2', team: 1, civId: null, placement: 2, ratingBeforeMu: 25, ratingBeforeSigma: 8.333, ratingAfterMu: 24, ratingAfterSigma: 8 },
      ])
      await db.insert(matchBans).values({ matchId, civId: 'rome', bannedBy: 'host', phase: 0 })
      const result = await pruneAbandonedMatches(db, kv, { now: 2 * 24 * 60 * 60 * 1000, allowDirectTerminalWriteForTests: true })

      expect(result.removedMatchIds).toEqual([])
      expect(await db.select().from(matches).where(eq(matches.id, matchId))).toHaveLength(1)
      expect(await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, matchId))).toHaveLength(2)
      expect(await db.select().from(matchBans).where(eq(matchBans.matchId, matchId))).toHaveLength(1)
    }
    finally {
      sqlite.close()
    }
  })

  test('batches rating-event checks for many stale matches', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      const ratedMatchId = 'stale-match-085'
      const staleMatchRows = Array.from({ length: 161 }, (_, index) => ({
        id: `stale-match-${String(index).padStart(3, '0')}`,
        guildId: GUILD_ID,
        gameMode: '1v1',
        status: 'cancelled',
        createdAt: 1,
        completedAt: 2,
        seasonId: null,
        draftData: null,
      }))

      await db.insert(players).values({ id: 'rated-player', displayName: 'Rated Player', avatarUrl: null, createdAt: 1 })
      await db.insert(matches).values(staleMatchRows)
      await db.insert(playerRatingEvents).values({
        matchId: ratedMatchId,
        playerId: 'rated-player',
        mode: 'duel',
        gameMode: '1v1',
        ratingBeforeMu: 25,
        ratingBeforeSigma: 8.333,
        ratingAfterMu: 26,
        ratingAfterSigma: 8,
        gamesDelta: 1,
        winsDelta: 1,
        importedGamesDelta: 0,
        effectiveGamesDelta: 1,
        winsVsTier1Delta: 0,
        winsVsTier2PlusDelta: 0,
        effectiveWinsVsTier1Delta: 0,
        effectiveWinsVsTier2PlusDelta: 0,
        matchCreatedAt: 1,
        matchCompletedAt: 2,
        updatedAt: 2,
      })

      const result = await pruneAbandonedMatches(db, kv, { staleCancelledMs: 0, allowDirectTerminalWriteForTests: true })

      expect(result.removedMatchIds).toHaveLength(staleMatchRows.length - 1)
      expect(result.removedMatchIds).not.toContain(ratedMatchId)
      const remaining = await db.select({ id: matches.id }).from(matches)
      expect(remaining).toEqual([{ id: ratedMatchId }])
    }
    finally {
      sqlite.close()
    }
  })

  test('directly prunes stale unrated matches whose SessionDO record is missing', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      const matchId = 'orphan-stale-match'
      await db.insert(matches).values({
        id: matchId,
        guildId: GUILD_ID,
        gameMode: '1v1',
        status: 'cancelled',
        createdAt: 1,
        completedAt: 2,
        seasonId: null,
        draftData: null,
      })

      const result = await pruneAbandonedMatches(db, kv, {
        staleCancelledMs: 0,
        sessionNamespace: missingSessionNamespace(),
      })

      expect(result.removedMatchIds).toEqual([matchId])
      expect(await db.select().from(matches).where(eq(matches.id, matchId))).toEqual([])
    }
    finally {
      sqlite.close()
    }
  })

  test('honors draft creation grace, then force-cancels a missing match through SessionDO', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      const queueEntries = [
        { playerId: 'host', displayName: 'Host', avatarUrl: null, joinedAt: 1, sourceGuild: { id: GUILD_ID } },
        { playerId: 'player-2', displayName: 'Player 2', avatarUrl: null, joinedAt: 2, sourceGuild: { id: GUILD_ID } },
      ]
      const lobby = await createLobby(kv, {
        mode: '1v1', guildId: GUILD_ID, hostId: 'host', channelId: 'channel', messageId: 'message', db, queueEntries,
      })
      const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, ['host', 'player-2'], lobby, { db, queueEntries })
      const withSlots = await setLobbySlots(kv, lobby.id, ['host', 'player-2'], withMembers ?? lobby, { db, queueEntries })
      await startTestSessionDraft(kv, lobby.id, withSlots ?? lobby, { db, queueEntries })
      const runtime = getExistingTestLobbyRuntime(kv)
      await db.delete(matchParticipants).where(eq(matchParticipants.matchId, lobby.id))
      await db.delete(matches).where(eq(matches.id, lobby.id))
      await db.update(sessionDirectory).set({ draftStartDeadlineAt: 200 }).where(eq(sessionDirectory.sessionId, lobby.id))

      await pruneAbandonedMatches(db, kv, { now: 100, sessionNamespace: runtime.sessionNamespace })
      expect((await getSessionRecord(runtime.sessionNamespace, lobby.id))?.phase).toBe('draft')
      expect((await db.select().from(sessionDirectory))[0]?.phase).toBe('draft')

      const repaired = await pruneAbandonedMatches(db, kv, { now: 201, sessionNamespace: runtime.sessionNamespace })
      expect(repaired.queuedRepairIds).toHaveLength(1)
      expect((await getSessionRecord(runtime.sessionNamespace, lobby.id))?.phase).toBe('cancelled')
      expect((await db.select().from(sessionDirectory))[0]?.phase).toBe('cancelled')
      expect((await db.select().from(sessionDirectoryMembers)).every(member => member.leftAt === 201)).toBe(true)
      expect((await db.select().from(matchRepairs))[0]).toMatchObject({ repairType: 'missing-match-row', status: 'completed' })

      await db.update(sessionDirectory).set({ phase: 'active', closedAt: null }).where(eq(sessionDirectory.sessionId, lobby.id))
      await db.update(sessionDirectoryMembers).set({ leftAt: null }).where(eq(sessionDirectoryMembers.sessionId, lobby.id))
      await pruneAbandonedMatches(db, kv, { now: 300, sessionNamespace: runtime.sessionNamespace })
      expect((await db.select().from(sessionDirectory))[0]?.phase).toBe('cancelled')
      expect((await db.select().from(sessionDirectoryMembers)).every(member => member.leftAt === 201)).toBe(true)
    }
    finally {
      sqlite.close()
    }
  })

  test('cancels and unlocks a live directory row with a null match ID', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    try {
      await db.insert(sessionDirectory).values(directoryRow('null-match-session', null))
      await db.insert(sessionDirectoryMembers).values({
        sessionId: 'null-match-session', playerId: 'host', joinedAt: 1, leftAt: null, updatedAt: 1,
      })

      await pruneAbandonedMatches(db, kv, { now: 100, allowDirectTerminalWriteForTests: true })

      expect((await db.select().from(sessionDirectory))[0]?.phase).toBe('cancelled')
      expect((await db.select().from(sessionDirectoryMembers))[0]?.leftAt).toBe(100)
      expect((await db.select().from(matchRepairs))[0]).toMatchObject({ repairType: 'null-match-id', status: 'completed' })
    }
    finally {
      sqlite.close()
    }
  })

  test('completes only fully rated active results and uses distinct session and match IDs', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'P2', avatarUrl: null, createdAt: 1 },
      ])
      await db.insert(matches).values([
        { id: 'complete-rated-match', guildId: GUILD_ID, gameMode: '1v1', status: 'active', createdAt: 1, draftCompletedAt: 2, completedAt: null, seasonId: null, draftData: null },
        { id: 'partial-rated-match', guildId: GUILD_ID, gameMode: '1v1', status: 'active', createdAt: 1, draftCompletedAt: 2, completedAt: null, seasonId: null, draftData: null },
      ])
      await db.insert(matchParticipants).values(['complete-rated-match', 'partial-rated-match'].flatMap(matchId => [
        { matchId, playerId: 'p1', team: 0, civId: null, placement: 1, ratingBeforeMu: 25, ratingBeforeSigma: 8, ratingAfterMu: 26, ratingAfterSigma: 8 },
        { matchId, playerId: 'p2', team: 1, civId: null, placement: 2, ratingBeforeMu: 25, ratingBeforeSigma: 8, ratingAfterMu: 24, ratingAfterSigma: 8 },
      ]))
      await db.insert(playerRatingEvents).values([
        ratingEvent('complete-rated-match', 'p1', 'duel'),
        ratingEvent('complete-rated-match', 'p1', 'global'),
        ratingEvent('complete-rated-match', 'p2', 'duel'),
        ratingEvent('complete-rated-match', 'p2', 'global'),
        ratingEvent('partial-rated-match', 'p1', 'global'),
        ratingEvent('partial-rated-match', 'p2', 'global'),
      ])
      await db.insert(sessionDirectory).values([
        directoryRow('stable-complete-session', 'complete-rated-match'),
        directoryRow('stable-partial-session', 'partial-rated-match'),
      ])

      await pruneAbandonedMatches(db, kv, { now: 100, staleActiveMs: 0, allowDirectTerminalWriteForTests: true })

      expect((await db.select().from(matches).where(eq(matches.id, 'complete-rated-match')))[0]?.status).toBe('completed')
      expect((await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, 'stable-complete-session')))[0]?.phase).toBe('reported')
      expect((await db.select().from(matches).where(eq(matches.id, 'partial-rated-match')))[0]?.status).toBe('active')
      expect((await db.select().from(matchRepairs).where(eq(matchRepairs.matchId, 'partial-rated-match')))[0]).toMatchObject({
        repairType: 'partial-result',
        status: 'attention',
      })
    }
    finally {
      sqlite.close()
    }
  })

  test('keeps a broken live directory visible when its SessionDO rejects cancellation', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const requestedSessionIds: string[] = []

    try {
      await db.insert(sessionDirectory).values({
        sessionId: 'broken-live-session',
        phase: 'active',
        mode: '1v1',
        guildId: GUILD_ID,
        channelId: 'channel',
        hostId: 'host',
        messageId: 'message',
        matchId: null,
        version: 1,
        rosterJson: '{}',
        configJson: '{}',
        createdAt: 1,
        updatedAt: 1,
        lastActivityAt: 1,
      })

      const result = await pruneAbandonedMatches(db, kv, {
        now: 100,
        sessionNamespace: rejectingSessionNamespace(requestedSessionIds),
      })

      expect(requestedSessionIds).toEqual(['broken-live-session', 'broken-live-session'])
      expect((await db.select().from(sessionDirectory))[0]?.phase).toBe('active')
      expect(result.queuedRepairIds).toHaveLength(1)
      expect((await db.select().from(matchRepairs))[0]).toMatchObject({ repairType: 'cleanup-retry', status: 'pending' })
    }
    finally {
      sqlite.close()
    }
  })

  test('keeps lifecycle projections unchanged when the authoritative SessionDO is missing', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    try {
      await db.insert(sessionDirectory).values(directoryRow('missing-aggregate-session', null))
      await db.insert(sessionDirectoryMembers).values({
        sessionId: 'missing-aggregate-session', playerId: 'host', joinedAt: 1, leftAt: null, updatedAt: 1,
      })

      await pruneAbandonedMatches(db, kv, { now: 100, sessionNamespace: missingSessionNamespace() })

      expect((await db.select().from(sessionDirectory))[0]?.phase).toBe('active')
      expect((await db.select().from(sessionDirectoryMembers))[0]?.leftAt).toBeNull()
      expect((await db.select().from(matchRepairs))[0]).toMatchObject({ repairType: 'cleanup-retry', status: 'pending' })
    }
    finally {
      sqlite.close()
    }
  })
})

function missingSessionNamespace(): DurableObjectNamespace {
  return {
    idFromName(name: string) {
      return name as unknown as DurableObjectId
    },
    get() {
      return {
        async fetch() {
          return new Response(JSON.stringify({ error: 'Session not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          })
        },
      } as DurableObjectStub
    },
  } as DurableObjectNamespace
}

function rejectingSessionNamespace(requestedSessionIds: string[]): DurableObjectNamespace {
  return {
    idFromName(name: string) {
      requestedSessionIds.push(name)
      return name as unknown as DurableObjectId
    },
    get() {
      return {
        async fetch() {
          return Response.json({ error: 'Injected terminal failure' }, { status: 500 })
        },
      } as DurableObjectStub
    },
  } as DurableObjectNamespace
}

function directoryRow(sessionId: string, matchId: string | null): typeof sessionDirectory.$inferInsert {
  return {
    sessionId,
    phase: 'active',
    mode: '1v1',
    guildId: GUILD_ID,
    channelId: 'channel',
    hostId: 'host',
    messageId: 'message',
    matchId,
    version: 1,
    rosterJson: '{}',
    configJson: '{}',
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
  }
}

function ratingEvent(matchId: string, playerId: string, mode: 'duel' | 'global'): typeof playerRatingEvents.$inferInsert {
  return {
    matchId,
    playerId,
    mode,
    gameMode: '1v1',
    ratingBeforeMu: 25,
    ratingBeforeSigma: 8,
    ratingAfterMu: 26,
    ratingAfterSigma: 8,
    gamesDelta: 1,
    winsDelta: playerId === 'p1' ? 1 : 0,
    importedGamesDelta: 0,
    effectiveGamesDelta: 1,
    winsVsTier1Delta: 0,
    winsVsTier2PlusDelta: 0,
    effectiveWinsVsTier1Delta: 0,
    effectiveWinsVsTier2PlusDelta: 0,
    matchCreatedAt: 1,
    matchCompletedAt: 2,
    updatedAt: 2,
  }
}
