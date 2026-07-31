import { matchBans, matchRepairs, matches, matchParticipants, playerRatingEvents, players, sessionDirectory } from '@civup/db'
import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { getChannelForMatch } from '../../src/services/activity/index.ts'
import { pruneAbandonedMatches } from '../../src/services/match/cleanup.ts'
import { createLobby, getExistingTestLobbyRuntime, getLobbyById, setLobbyMemberPlayerIds, setLobbyStatus, startTestSessionDraft } from '../helpers/lobby-runtime.ts'
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

  test('skips abandoned matches that still have rating events', async () => {
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
      await db.insert(playerRatingEvents).values({
        matchId,
        playerId: 'host',
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

      expect(requestedSessionIds).toEqual(['broken-live-session'])
      expect((await db.select().from(sessionDirectory))[0]?.phase).toBe('active')
      expect(result.queuedRepairIds).toHaveLength(1)
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
