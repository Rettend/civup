import { matchBans, matches, matchParticipants, playerRatingEvents, players } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { getChannelForMatch } from '../../src/services/activity/index.ts'
import { pruneAbandonedMatches } from '../../src/services/match/cleanup.ts'
import { createLobby, getExistingTestLobbyRuntime, getLobbyById, setLobbyMemberPlayerIds, setLobbyStatus, startTestSessionDraft } from '../helpers/lobby-runtime.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

describe('match cleanup reconciliation', () => {
  test('clears live lobbies whose backing match is already completed', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values([
        { id: 'host', displayName: 'Host', avatarUrl: null, createdAt: 1 },
        { id: 'player-2', displayName: 'Player 2', avatarUrl: null, createdAt: 1 },
      ])
      const lobby = await createLobby(kv, {
        mode: '1v1',
        hostId: 'host',
        channelId: 'channel-1',
        messageId: 'message-1',
        db,
      })
      const matchId = lobby.id
      await db.insert(matches).values({
        id: matchId,
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

      const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, ['host', 'player-2'], lobby)
      const draftingLobby = await startTestSessionDraft(kv, lobby.id, withMembers ?? lobby)
      const activeLobby = await setLobbyStatus(kv, lobby.id, 'active', draftingLobby!)

      const result = await pruneAbandonedMatches(db, kv, { sessionNamespace: getExistingTestLobbyRuntime(kv).sessionNamespace })

      expect(result.removedMatchIds).toEqual([])
      expect(result.clearedLiveLobbyMatchIds).toEqual([matchId])
      expect((await getLobbyById(kv, activeLobby!.id))?.status).toBe('completed')
      expect(await kv.get('lobby:host:host')).toBeNull()
      expect(await getChannelForMatch(db, matchId)).toBeNull()
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
})
