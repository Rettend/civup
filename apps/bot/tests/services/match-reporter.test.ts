import { matches, matchParticipants, players } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { loadMatchReporterIdentity } from '../../src/services/match/reporter.ts'
import { reportMatch } from '../../src/services/match/report.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

describe('match reporter identity', () => {
  test('stores the reporting player identity for later embed repairs', async () => {
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
              { playerId: 'p1', team: 0 },
              { playerId: 'p2', team: 1 },
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
        reporterDisplayName: 'Fresh Reporter',
        reporterAvatarUrl: 'https://cdn.discordapp.com/avatars/p1/fresh.png',
        placements: '<@p1>',
      })

      expect('error' in result).toBe(false)
      if ('error' in result) return

      await expect(loadMatchReporterIdentity(kv, 'm1')).resolves.toEqual({
        userId: 'p1',
        displayName: 'Fresh Reporter',
        avatarUrl: 'https://cdn.discordapp.com/avatars/p1/fresh.png',
      })
    }
    finally {
      sqlite.close()
    }
  })
})
