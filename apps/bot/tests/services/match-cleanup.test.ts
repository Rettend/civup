import { matches, matchParticipants, players } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { getChannelForMatch, storeMatchMapping, storeUserMatchMappings } from '../../src/services/activity/index.ts'
import { attachLobbyMatch, createLobby, getLobbyById, setLobbyMemberPlayerIds, setLobbyStatus } from '../../src/services/lobby/index.ts'
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
      await db.insert(matches).values({
        id: 'match-1',
        gameMode: '1v1',
        status: 'completed',
        createdAt: 1,
        completedAt: 2,
        seasonId: null,
        draftData: null,
      })
      await db.insert(matchParticipants).values([
        { matchId: 'match-1', playerId: 'host', team: 0, civId: null, placement: 1, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'match-1', playerId: 'player-2', team: 1, civId: null, placement: 2, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ])

      const lobby = await createLobby(kv, {
        mode: '1v1',
        hostId: 'host',
        channelId: 'channel-1',
        messageId: 'message-1',
      })
      const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, ['host', 'player-2'], lobby)
      const draftingLobby = await attachLobbyMatch(kv, lobby.id, 'match-1', withMembers ?? lobby)
      const activeLobby = await setLobbyStatus(kv, lobby.id, 'active', draftingLobby!)

      await storeMatchMapping(kv, 'channel-1', 'match-1')
      await storeUserMatchMappings(kv, ['host', 'player-2'], 'match-1')

      const result = await pruneAbandonedMatches(db, kv)

      expect(result.removedMatchIds).toEqual([])
      expect(result.clearedLiveLobbyMatchIds).toEqual(['match-1'])
      expect(await getLobbyById(kv, activeLobby!.id)).toBeNull()
      expect(await kv.get('lobby:match:match-1')).toBeNull()
      expect(await kv.get('lobby:host:host')).toBeNull()
      expect(await getChannelForMatch(kv, 'match-1')).toBeNull()
      expect(await kv.get('activity-user:host')).toBeNull()
      expect(await kv.get('activity-user:player-2')).toBeNull()
    }
    finally {
      sqlite.close()
    }
  })
})
