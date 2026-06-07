import { matches, matchParticipants, players } from '@civup/db'
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
      expect(field(fields, 'Overview')).toMatchObject({
        value: 'Picks: 4 (57%)\nWins: 2 (50%)',
        inline: true,
      })
      expect(field(fields, 'Overview')?.value).not.toContain('Bans:')
      expect(field(fields, '1v1')).toMatchObject({
        value: 'Picks: 2 (67%)\nWins: 1 (50%)',
        inline: true,
      })
      expect(field(fields, 'FFA')).toMatchObject({
        value: 'Picks: 1 (33%)\nWins: 1 (100%)',
        inline: true,
      })
      expect(field(fields, '2v2')).toMatchObject({
        value: 'Picks: 1 (100%)\nWins: 0 (0%)',
        inline: true,
      })
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
})

function field(fields: Array<{ name: string, value: string, inline?: boolean }>, name: string) {
  return fields.find(field => field.name === name)
}
