import type { Database } from '@civup/db'
import { civStats, civStatTotals, matches, matchCivStatContributions, matchParticipants, players } from '@civup/db'
import { allLeaderIds, getLeader } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { buildCivLeaderboardCommandPayload } from '../../src/commands/civ-leaderboard.ts'
import { CIV_LEADERBOARD_DESCRIPTION_CHAR_LIMIT, CIV_LEADERBOARD_TOP_LIMIT, civLeaderboardEmbedGroups } from '../../src/embeds/civ-leaderboard.ts'
import { backfillCivLeaderboardStatsFromHistory, buildCivLeaderboardSnapshotFromD1, rebuildCivLeaderboardSnapshot, reconcileCivLeaderboardMatchContribution } from '../../src/services/leaderboard/civ-snapshot.ts'
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
      await seedLeaderMatches({
        civId: 'rd-aliens',
        matchPrefix: 'red-death',
        playerId: 'p1',
        total: 20,
        wins: 20,
        bans: 20,
        redDeath: true,
      })

      await backfillCivLeaderboardStatsFromHistory(db)
      await rebuildCivLeaderboardSnapshot(db, kv)

      const payload = await buildCivLeaderboardCommandPayload(kv)
      const embeds = payload.embeds?.map(embed => embed.toJSON()) ?? []

      expect(payload.content).toBeUndefined()
      expect(embeds.map(embed => embed.title)).toEqual([
        'Top Picked Leaders',
        'Top Win Rate Leaders',
        'Top Banned Leaders',
      ])
      expect(embeds).toHaveLength(3)
      expect(embeds[0]?.description).toContain('`#1 `')
      expect(embeds[0]?.description).toContain('🖱️ `50%  ` 🏆 `50%  ` 🚫 `16.7%`')
      expect(embeds[0]?.description).toContain('Trajan')
      expect(embeds[0]?.description).not.toContain('`Rome`')
      expect(embeds[1]?.description).toContain('🏆 `75%  ` 🖱️ `50%  ` 🚫 `33.3%`')
      expect(embeds[2]?.description).toContain('🚫 `33.3%` 🖱️ `50%  ` 🏆 `75%  `')
      expect(embeds.map(embed => embed.description).join('\n')).not.toContain('Aliens')
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
      redDeath?: boolean
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
            ...(input.redDeath ? { redDeath: true } : {}),
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
        await reconcileCivLeaderboardMatchContribution(db, matchId)
      }
    }
  })

  test('does not rebuild when no cached civ snapshot exists', async () => {
    const kv = createTestKv()

    const payload = await buildCivLeaderboardCommandPayload(kv)

    expect(payload.embeds).toBeUndefined()
    expect(payload.content).toBe('Civ leaderboard snapshot is not available yet. Run the PPL civ leaderboard backfill script first.')
  })

  test('does not show partial aggregate snapshot before historical backfill', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values({ id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 })
      await seedCompletedMatch(db, 'partial-match', 'rome-trajan', 'p1', 1)
      await reconcileCivLeaderboardMatchContribution(db, 'partial-match', 10)
      await rebuildCivLeaderboardSnapshot(db, kv, 20)

      const payload = await buildCivLeaderboardCommandPayload(kv)

      expect(payload.embeds).toBeUndefined()
      expect(payload.content).toBe('Civ leaderboard snapshot is not available yet. Run the PPL civ leaderboard backfill script first.')
    }
    finally {
      sqlite.close()
    }
  })

  test('keeps full leaderboards below Discord embed character limits', () => {
    const rows = allLeaderIds.slice(0, 75).map((civId, index) => {
      const leader = getLeader(civId)
      const picks = 100 - index
      const wins = picks - (index % 10)
      return {
        civId,
        leaderName: leader.name,
        picks,
        bans: 80 - (index % 25),
        wins,
        winRatePct: Math.round((wins / picks) * 1000) / 10,
        banRatePct: 80 - (index % 25),
      }
    })

    const groups = civLeaderboardEmbedGroups({
      updatedAt: 1,
      historyInitialized: true,
      completedMatchCount: 100,
      rows,
    })

    expect(groups.length).toBeGreaterThanOrEqual(1)
    expect(groups.flatMap(group => group.map(embed => embed.toJSON().title))).toEqual([
      'Top Picked Leaders',
      'Top Win Rate Leaders',
      'Top Banned Leaders',
    ])
    for (const group of groups) {
      expect(embedGroupTextLength(group)).toBeLessThanOrEqual(6000)
      for (const embed of group) {
        const description = embed.toJSON().description
        expect(stringLength(description)).toBeLessThanOrEqual(CIV_LEADERBOARD_DESCRIPTION_CHAR_LIMIT)
        expect(lineCount(description)).toBeLessThan(CIV_LEADERBOARD_TOP_LIMIT)
      }
    }
  })

  test('reconciles aggregate contributions when completed match leaders change or cancel', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values({ id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 })
      await db.insert(matches).values({
        id: 'match-1',
        gameMode: 'ffa',
        status: 'completed',
        isOld: false,
        seasonId: null,
        draftData: JSON.stringify({ state: { bans: [{ civId: 'rome-trajan' }] } }),
        createdAt: 1,
        completedAt: 2,
      })
      await db.insert(matchParticipants).values({
        matchId: 'match-1',
        playerId: 'p1',
        team: null,
        civId: 'rome-trajan',
        placement: 1,
        ratingBeforeMu: null,
        ratingBeforeSigma: null,
        ratingAfterMu: null,
        ratingAfterSigma: null,
      })

      await reconcileCivLeaderboardMatchContribution(db, 'match-1', 10)
      let snapshot = await rebuildCivLeaderboardSnapshot(db, kv, 20)
      expect(snapshot.completedMatchCount).toBe(1)
      expect(snapshot.rows.find(row => row.civId === 'rome-trajan')).toMatchObject({ picks: 1, wins: 1, bans: 1 })

      await db.update(matchParticipants).set({ civId: 'russia-peter', placement: 2 })
      await db.update(matches).set({ draftData: JSON.stringify({ state: { bans: [{ civId: 'russia-peter' }] } }) })
      await reconcileCivLeaderboardMatchContribution(db, 'match-1', 30)
      snapshot = await rebuildCivLeaderboardSnapshot(db, kv, 40)
      expect(snapshot.completedMatchCount).toBe(1)
      expect(snapshot.rows.find(row => row.civId === 'rome-trajan')).toBeUndefined()
      expect(snapshot.rows.find(row => row.civId === 'russia-peter')).toMatchObject({ picks: 1, wins: 0, bans: 1 })

      await db.update(matches).set({ status: 'cancelled' })
      await reconcileCivLeaderboardMatchContribution(db, 'match-1', 50)
      snapshot = await rebuildCivLeaderboardSnapshot(db, kv, 60)
      expect(snapshot.completedMatchCount).toBe(0)
      expect(snapshot.rows).toEqual([])
    }
    finally {
      sqlite.close()
    }
  })

  test('reconciles one match contribution without historical backfill', async () => {
    const { db, sqlite } = await createTestDatabase()

    try {
      await db.insert(players).values({ id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 })
      await seedCompletedMatch('historical-match', 'rome-trajan', 1)
      await seedCompletedMatch('target-match', 'russia-peter', 2)

      await reconcileCivLeaderboardMatchContribution(db, 'target-match', 10)

      const contributionRows = await db
        .select({ matchId: matchCivStatContributions.matchId })
        .from(matchCivStatContributions)
      expect(contributionRows).toEqual([{ matchId: 'target-match' }])

      const totalRows = await db
        .select({ scope: civStatTotals.scope, completedMatchCount: civStatTotals.completedMatchCount })
        .from(civStatTotals)
      expect(totalRows).toEqual([{ scope: 'global', completedMatchCount: 1 }])

      const statRows = await db
        .select({ civId: civStats.civId, picks: civStats.picks, wins: civStats.wins, bans: civStats.bans })
        .from(civStats)
      expect(statRows).toEqual([{ civId: 'russia-peter', picks: 1, wins: 1, bans: 1 }])
    }
    finally {
      sqlite.close()
    }

    async function seedCompletedMatch(matchId: string, civId: string, createdAt: number): Promise<void> {
      await db.insert(matches).values({
        id: matchId,
        gameMode: 'ffa',
        status: 'completed',
        isOld: false,
        seasonId: null,
        draftData: JSON.stringify({ state: { bans: [{ civId }] } }),
        createdAt,
        completedAt: createdAt,
      })
      await db.insert(matchParticipants).values({
        matchId,
        playerId: 'p1',
        team: null,
        civId,
        placement: 1,
        ratingBeforeMu: null,
        ratingBeforeSigma: null,
        ratingAfterMu: null,
        ratingAfterSigma: null,
      })
    }
  })

  test('historical backfill is idempotent and matches historical snapshot builder', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values({ id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 })
      await seedCompletedMatch(db, 'rome-match', 'rome-trajan', 'p1', 1)
      await seedCompletedMatch(db, 'russia-match', 'russia-peter', 'p1', 2)
      await seedCompletedMatch(db, 'red-death-match', 'rd-aliens', 'p1', 3, { redDeath: true })

      const historical = await buildCivLeaderboardSnapshotFromD1(db, 10)
      const first = await backfillCivLeaderboardStatsFromHistory(db, 20)
      const second = await backfillCivLeaderboardStatsFromHistory(db, 30)
      const snapshot = await rebuildCivLeaderboardSnapshot(db, kv, 40)

      expect(first.status.historyInitialized).toBe(true)
      expect(second.status.historyInitialized).toBe(true)
      expect(first.contributionRowCount).toBe(2)
      expect(second.contributionRowCount).toBe(2)
      expect(snapshot.historyInitialized).toBe(true)
      expect(snapshot.completedMatchCount).toBe(historical.completedMatchCount)
      expect(snapshot.rows.map(row => ({ civId: row.civId, picks: row.picks, wins: row.wins, bans: row.bans }))).toEqual(
        historical.rows.map(row => ({ civId: row.civId, picks: row.picks, wins: row.wins, bans: row.bans })),
      )

      const contributionRows = await db.select({ matchId: matchCivStatContributions.matchId }).from(matchCivStatContributions)
      expect(contributionRows.map(row => row.matchId).sort()).toEqual(['rome-match', 'russia-match'])
    }
    finally {
      sqlite.close()
    }
  })
})

async function seedCompletedMatch(
  db: Database,
  matchId: string,
  civId: string,
  playerId: string,
  createdAt: number,
  options: { redDeath?: boolean } = {},
): Promise<void> {
  await db.insert(matches).values({
    id: matchId,
    gameMode: 'ffa',
    status: 'completed',
    isOld: false,
    seasonId: null,
    draftData: JSON.stringify({
      ...(options.redDeath ? { redDeath: true } : {}),
      state: { bans: [{ civId }] },
    }),
    createdAt,
    completedAt: createdAt,
  })
  await db.insert(matchParticipants).values({
    matchId,
    playerId,
    team: null,
    civId,
    placement: 1,
    ratingBeforeMu: null,
    ratingBeforeSigma: null,
    ratingAfterMu: null,
    ratingAfterSigma: null,
  })
}

function embedGroupTextLength(embeds: Array<{ toJSON: () => { title?: unknown, description?: unknown } }>): number {
  return embeds.reduce((total, embed) => {
    const json = embed.toJSON()
    return total + stringLength(json.title) + stringLength(json.description)
  }, 0)
}

function stringLength(value: unknown): number {
  return typeof value === 'string' ? value.length : 0
}

function lineCount(value: unknown): number {
  return typeof value === 'string' ? value.split('\n').length : 0
}
