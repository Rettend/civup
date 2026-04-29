import { matches, matchParticipants, players } from '@civup/db'
import { allLeaderIds, getLeader } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { buildCivLeaderboardCommandPayload } from '../../src/commands/civ-leaderboard.ts'
import { civLeaderboardEmbedGroups } from '../../src/embeds/civ-leaderboard.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

describe('civ leaderboard command payload', () => {
  test('shows picked, winrate, and banned leaderboards together', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values({ id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 })
      await seedLeaderMatches({
        civId: 'rome-trajan',
        matchPrefix: 'rome',
        playerId: 'p1',
        total: 12,
        wins: 6,
        bans: 4,
      })
      await seedLeaderMatches({
        civId: 'russia-peter',
        matchPrefix: 'russia',
        playerId: 'p1',
        total: 12,
        wins: 9,
        bans: 8,
      })

      const payload = await buildCivLeaderboardCommandPayload(db, kv)
      const embeds = payload.embeds?.map(embed => embed.toJSON()) ?? []

      expect(payload.content).toBeUndefined()
      expect(embeds.map(embed => embed.title)).toEqual([
        'Top Picked Leaders',
        'Top Win Rate Leaders',
        'Top Banned Leaders',
      ])
      expect(embeds).toHaveLength(3)
      expect(embeds[0]?.description).toContain('`#1 `')
      expect(embeds[0]?.description).toContain('Trajan — **50%** Pick, **50%** WR, **16.7%** Ban')
      expect(embeds[1]?.description).toContain('**75%** WR, **50%** Pick, **33.3%** Ban')
      expect(embeds[2]?.description).toContain('**33.3%** Ban, **50%** Pick, **75%** WR')
      expect(embeds[0]?.footer).toBeUndefined()
    }
    finally {
      sqlite.close()
    }

    async function seedLeaderMatches(input: {
      civId: string
      matchPrefix: string
      playerId: string
      total: number
      wins: number
      bans: number
    }): Promise<void> {
      for (let index = 1; index <= input.total; index++) {
        const matchId = `${input.matchPrefix}-${index}`
        await db.insert(matches).values({
          id: matchId,
          gameMode: 'ffa',
          status: 'completed',
          isOld: false,
          seasonId: null,
          draftData: JSON.stringify({
            state: {
              bans: index <= input.bans ? [{ civId: input.civId }] : [],
            },
          }),
          createdAt: index,
          completedAt: index,
        })
        await db.insert(matchParticipants).values({
          matchId,
          playerId: input.playerId,
          team: null,
          civId: input.civId,
          placement: index <= input.wins ? 1 : 2,
          ratingBeforeMu: null,
          ratingBeforeSigma: null,
          ratingAfterMu: null,
          ratingAfterSigma: null,
        })
      }
    }
  })

  test('chunks full top 25 boards below Discord embed character limits', () => {
    const rows = allLeaderIds.slice(0, 75).map((civId, index) => {
      const leader = getLeader(civId)
      const picks = 100 - index
      const wins = picks - (index % 10)
      return {
        civId,
        leaderName: leader.name,
        civilizationName: leader.civilization,
        picks,
        bans: 80 - (index % 25),
        wins,
        winRatePct: Math.round((wins / picks) * 1000) / 10,
        banRatePct: 80 - (index % 25),
      }
    })

    const groups = civLeaderboardEmbedGroups({
      updatedAt: 1,
      completedMatchCount: 100,
      rows,
    })

    expect(groups).toHaveLength(2)
    expect(groups.flatMap(group => group.map(embed => embed.toJSON().title))).toEqual([
      'Top Picked Leaders',
      'Top Win Rate Leaders',
      'Top Banned Leaders',
    ])
    for (const group of groups) {
      expect(embedGroupTextLength(group)).toBeLessThanOrEqual(6000)
    }
  })
})

function embedGroupTextLength(embeds: Array<{ toJSON: () => { title?: unknown, description?: unknown } }>): number {
  return embeds.reduce((total, embed) => {
    const json = embed.toJSON()
    return total + stringLength(json.title) + stringLength(json.description)
  }, 0)
}

function stringLength(value: unknown): number {
  return typeof value === 'string' ? value.length : 0
}
