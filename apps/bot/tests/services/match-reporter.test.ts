import { matches, matchParticipants, players } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { getChannelForMatch, storeMatchMapping, storeUserMatchMappings } from '../../src/services/activity/index.ts'
import { attachLobbyMatch, createLobby, getLobbyById, setLobbyMemberPlayerIds } from '../../src/services/lobby/index.ts'
import { getReporterIdentityFromDraftData } from '../../src/services/match/draft-data.ts'
import { reportMatch } from '../../src/services/match/report.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

describe('match reporter identity', () => {
  test('stores the reporter id in draft data and resolves footer identity from seats', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values([
        {
          id: 'p1',
          displayName: 'Player One',
          avatarUrl: 'https://cdn.discordapp.com/avatars/p1/avatar.png',
          createdAt: 1,
        },
        {
          id: 'p2',
          displayName: 'Player Two',
          avatarUrl: null,
          createdAt: 1,
        },
      ])
      await db.insert(matches).values({
        id: 'm1',
        gameMode: '1v1',
        status: 'active',
        createdAt: 1,
        completedAt: null,
        seasonId: null,
        draftData: JSON.stringify({
          state: {
            seats: [
              {
                playerId: 'p1',
                displayName: 'Fresh Reporter',
                avatarUrl: 'https://cdn.discordapp.com/avatars/p1/fresh.png',
                team: 0,
              },
              {
                playerId: 'p2',
                displayName: 'Player Two',
                avatarUrl: null,
                team: 1,
              },
            ],
          },
        }),
      })
      await db.insert(matchParticipants).values([
        {
          matchId: 'm1',
          playerId: 'p1',
          team: 0,
          civId: null,
          placement: null,
          ratingBeforeMu: null,
          ratingBeforeSigma: null,
          ratingAfterMu: null,
          ratingAfterSigma: null,
        },
        {
          matchId: 'm1',
          playerId: 'p2',
          team: 1,
          civId: null,
          placement: null,
          ratingBeforeMu: null,
          ratingBeforeSigma: null,
          ratingAfterMu: null,
          ratingAfterSigma: null,
        },
      ])

      const result = await reportMatch(db, kv, {
        matchId: 'm1',
        reporterId: 'p1',
        placements: '<@p1>',
      })

      expect('error' in result).toBe(false)
      if ('error' in result) return

      expect(getReporterIdentityFromDraftData(result.match.draftData)).toEqual({
        userId: 'p1',
        displayName: 'Fresh Reporter',
        avatarUrl: 'https://cdn.discordapp.com/avatars/p1/fresh.png',
      })
    }
    finally {
      sqlite.close()
    }
  })

  test('reportMatch clears activity residue but leaves the lobby available for message sync', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'Player One', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'Player Two', avatarUrl: null, createdAt: 1 },
      ])
      await db.insert(matches).values({
        id: 'm2',
        gameMode: '1v1',
        status: 'active',
        createdAt: 1,
        completedAt: null,
        seasonId: null,
        draftData: JSON.stringify({
          state: {
            seats: [
              { playerId: 'p1', displayName: 'Player One', avatarUrl: null, team: 0 },
              { playerId: 'p2', displayName: 'Player Two', avatarUrl: null, team: 1 },
            ],
          },
        }),
      })
      await db.insert(matchParticipants).values([
        { matchId: 'm2', playerId: 'p1', team: 0, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { matchId: 'm2', playerId: 'p2', team: 1, civId: null, placement: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ])

      const lobby = await createLobby(kv, {
        mode: '1v1',
        hostId: 'p1',
        channelId: 'channel-1',
        messageId: 'message-1',
      })
      const withMembers = await setLobbyMemberPlayerIds(kv, lobby.id, ['p1', 'p2'], lobby)
      await attachLobbyMatch(kv, lobby.id, 'm2', withMembers ?? lobby)
      await storeMatchMapping(kv, 'channel-1', 'm2')
      await storeUserMatchMappings(kv, ['p1', 'p2'], 'm2')

      const result = await reportMatch(db, kv, {
        matchId: 'm2',
        reporterId: 'p1',
        placements: '<@p1>',
      })

      expect('error' in result).toBe(false)
      if ('error' in result) return

      expect(await getLobbyById(kv, lobby.id)).not.toBeNull()
      expect(await kv.get('lobby:match:m2')).toBe(lobby.id)
      expect(await kv.get('lobby:host:p1')).toBe(lobby.id)
      expect(await getChannelForMatch(kv, 'm2')).toBeNull()
      expect(await kv.get('activity-user:p1')).toBeNull()
      expect(await kv.get('activity-user:p2')).toBeNull()
    }
    finally {
      sqlite.close()
    }
  })
})
