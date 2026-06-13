import { matches, matchParticipants, playerCivStats, playerRatings, players } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { leaderStatsEmbed } from '../../src/embeds/leader-card.ts'
import { createTestDatabase } from '../helpers/test-env.ts'

describe('leader stats embed', () => {
  test('shows game modes as inline fields and uses leader thumbnail', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'P2', avatarUrl: null, createdAt: 1 },
      ])
      await seedLeaderMatch('m-1v1-win', '1v1', 1)
      await seedLeaderMatch('m-1v1-loss', '1v1', 2)
      await seedLeaderMatch('m-ffa-win', 'ffa', 1)
      await seedLeaderMatch('m-2v2-loss', '2v2', 2)
      await seedOtherMatch('m-other-1v1', '1v1')
      await seedOtherMatch('m-other-ffa-1', 'ffa')
      await seedOtherMatch('m-other-ffa-2', 'ffa')

      const embed = await leaderStatsEmbed(db, 'rome-trajan')
      const json = embed.toJSON() as {
        description?: string
        thumbnail?: { url?: string }
        fields?: Array<{ name: string, value: string, inline?: boolean }>
      }
      const fields = json.fields ?? []

      expect(json.description).toBe('Trajan - Rome')
      expect(json.thumbnail?.url).toContain('/1470104020193382522.webp')
      expect(fields.some(field => field.name === 'Modes')).toBe(false)
      expect(fields.slice(0, 5).map(field => field.name)).toEqual(['Overview', 'Duel', 'Duo', 'FFA', 'Best Players'])
      expect(field(fields, 'Overview')).toMatchObject({
        value: 'Picks: 4 (57%)\nWins: 2 (50%)',
        inline: true,
      })
      expect(field(fields, 'Overview')?.value).not.toContain('Bans:')
      expect(field(fields, 'Duel')).toMatchObject({
        value: 'Picks: 2 (67%)\nWins: 1 (50%)',
        inline: true,
      })
      expect(field(fields, 'Duo')).toMatchObject({
        value: 'Picks: 1 (100%)\nWins: 0 (0%)',
        inline: true,
      })
      expect(field(fields, 'FFA')).toMatchObject({
        value: 'Picks: 1 (33%)\nWins: 1 (100%)',
        inline: true,
      })
      expect(field(fields, 'Best Players')?.value).toBe('Not enough player data')
    }
    finally {
      sqlite.close()
    }

    async function seedLeaderMatch(matchId: string, gameMode: string, placement: number): Promise<void> {
      await db.insert(matches).values({
        id: matchId,
        gameMode,
        status: 'completed',
        isOld: false,
        seasonId: null,
        draftData: JSON.stringify({ state: { bans: [] } }),
        createdAt: 1,
        completedAt: 1,
      })
      await db.insert(matchParticipants).values([
        {
          matchId,
          playerId: 'p1',
          team: gameMode === 'ffa' ? null : 1,
          civId: 'rome-trajan',
          placement,
          ratingBeforeMu: null,
          ratingBeforeSigma: null,
          ratingAfterMu: null,
          ratingAfterSigma: null,
        },
        {
          matchId,
          playerId: 'p2',
          team: gameMode === 'ffa' ? null : 2,
          civId: 'russia-peter',
          placement: placement === 1 ? 2 : 1,
          ratingBeforeMu: null,
          ratingBeforeSigma: null,
          ratingAfterMu: null,
          ratingAfterSigma: null,
        },
      ])
    }

    async function seedOtherMatch(matchId: string, gameMode: string): Promise<void> {
      await db.insert(matches).values({
        id: matchId,
        gameMode,
        status: 'completed',
        isOld: false,
        seasonId: null,
        draftData: JSON.stringify({ state: { bans: [] } }),
        createdAt: 1,
        completedAt: 1,
      })
      await db.insert(matchParticipants).values([
        {
          matchId,
          playerId: 'p1',
          team: gameMode === 'ffa' ? null : 1,
          civId: 'russia-peter',
          placement: 1,
          ratingBeforeMu: null,
          ratingBeforeSigma: null,
          ratingAfterMu: null,
          ratingAfterSigma: null,
        },
        {
          matchId,
          playerId: 'p2',
          team: gameMode === 'ffa' ? null : 2,
          civId: 'america-abraham-lincoln',
          placement: 2,
          ratingBeforeMu: null,
          ratingBeforeSigma: null,
          ratingAfterMu: null,
          ratingAfterSigma: null,
        },
      ])
    }
  })

  test('shows best players using strict global-Elo-aware leader ranks', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'Perfect Sample', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'High Elo Strong', avatarUrl: null, createdAt: 1 },
        { id: 'p3', displayName: 'Baseline', avatarUrl: null, createdAt: 1 },
      ])
      await db.insert(playerCivStats).values([
        { seasonId: '', gameMode: '1v1', playerId: 'p1', civId: 'rome-trajan', picks: 5, wins: 5, updatedAt: 1 },
        { seasonId: '', gameMode: '1v1', playerId: 'p2', civId: 'rome-trajan', picks: 11, wins: 7, updatedAt: 1 },
        { seasonId: '', gameMode: '1v1', playerId: 'p3', civId: 'rome-trajan', picks: 30, wins: 0, updatedAt: 1 },
      ])
      await db.insert(playerRatings).values({
        playerId: 'p2',
        mode: 'global',
        mu: 36.111,
        sigma: 8.333,
        gamesPlayed: 20,
        wins: 14,
        lastPlayedAt: 1,
      })

      const embed = await leaderStatsEmbed(db, 'rome-trajan')
      const json = embed.toJSON() as { fields?: Array<{ name: string, value: string, inline?: boolean }> }
      const bestPlayers = field(json.fields ?? [], 'Best Players')

      expect(bestPlayers?.value.split('\n')[0]).toContain('High Elo Strong')
      expect(bestPlayers?.value.split('\n')[0]).toContain('`#1 `')
      expect(bestPlayers?.value.split('\n')[1]).toContain('Perfect Sample')
      expect(bestPlayers?.value.split('\n')[1]).toContain('`#2 `')
    }
    finally {
      sqlite.close()
    }
  })

  test('smooths relation performance before sorting matchup fields', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await db.insert(players).values([
        { id: 'p1', displayName: 'Yongle Player', avatarUrl: null, createdAt: 1 },
        { id: 'p2', displayName: 'Opponent', avatarUrl: null, createdAt: 1 },
      ])

      let matchIndex = 0
      const seedRelationSeries = async (civId: string, games: number, wins: number) => {
        for (let index = 0; index < games; index += 1) {
          const didWin = index < wins
          const matchId = `relation-smooth-${matchIndex}`
          matchIndex += 1

          await db.insert(matches).values({
            id: matchId,
            gameMode: '1v1',
            status: 'completed',
            isOld: false,
            seasonId: null,
            draftData: null,
            createdAt: matchIndex,
            completedAt: matchIndex,
          })
          await db.insert(matchParticipants).values([
            {
              matchId,
              playerId: 'p1',
              team: 0,
              civId: 'china-yongle',
              placement: didWin ? 1 : 2,
              ratingBeforeMu: null,
              ratingBeforeSigma: null,
              ratingAfterMu: null,
              ratingAfterSigma: null,
            },
            {
              matchId,
              playerId: 'p2',
              team: 1,
              civId,
              placement: didWin ? 2 : 1,
              ratingBeforeMu: null,
              ratingBeforeSigma: null,
              ratingAfterMu: null,
              ratingAfterSigma: null,
            },
          ])
        }
      }

      await seedRelationSeries('rome-trajan', 7, 5)
      await seedRelationSeries('korea-seondeok', 2, 2)
      await seedRelationSeries('babylon-hammurabi', 6, 0)
      await seedRelationSeries('japan-hojo-tokimune', 2, 0)

      const embed = await leaderStatsEmbed(db, 'china-yongle')
      const json = embed.toJSON() as { fields?: Array<{ name: string, value: string, inline?: boolean }> }
      const bestAgainstLine = field(json.fields ?? [], 'Best Against')?.value.split('\n')[0] ?? ''
      const worstAgainstLine = field(json.fields ?? [], 'Worst Against')?.value.split('\n')[0] ?? ''

      expect(bestAgainstLine).toContain('Trajan')
      expect(bestAgainstLine).toContain('5/7  71%')
      expect(worstAgainstLine).toContain('Hammurabi')
      expect(worstAgainstLine).toContain('0/6   0%')
    }
    finally {
      sqlite.close()
    }
  })
})

function field(fields: Array<{ name: string, value: string, inline?: boolean }>, name: string) {
  return fields.find(field => field.name === name)
}
