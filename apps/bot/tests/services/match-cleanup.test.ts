import { matches, matchParticipants, players } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { getChannelForMatch } from '../../src/services/activity/index.ts'
import { createLobby, getExistingTestLobbyRuntime, getLobbyById, setLobbyMemberPlayerIds, setLobbyStatus, startTestSessionDraft } from '../helpers/lobby-runtime.ts'
import { pruneAbandonedMatches } from '../../src/services/match/cleanup.ts'
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
      expect(await getLobbyById(kv, activeLobby!.id)).toBeNull()
      expect(await kv.get('lobby:host:host')).toBeNull()
      expect(await getChannelForMatch(db, matchId)).toBeNull()
    }
    finally {
      sqlite.close()
    }
  })
})
