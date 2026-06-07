import type { Database } from '@civup/db'
import { civStats, civStatTotals, matchCivStatContributions, matches, matchParticipants, players } from '@civup/db'
import { allLeaderIds, getLeader } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { buildCivLeaderboardCommandPayload } from '../../src/commands/civ-leaderboard.ts'
import { CIV_LEADERBOARD_DESCRIPTION_CHAR_LIMIT, CIV_LEADERBOARD_PAGE_SIZE, CIV_LEADERBOARD_TOP_LIMIT, civLeaderboardEmbedGroups } from '../../src/embeds/civ-leaderboard.ts'
import { backfillCivLeaderboardStatsFromHistory, buildCivLeaderboardSnapshotFromD1, civLeaderboardSnapshotKey, rebuildCivLeaderboardSnapshot, reconcileCivLeaderboardMatchContribution } from '../../src/services/leaderboard/civ-snapshot.ts'
import { parsePaginationCustomId } from '../../src/services/response/pagination.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

describe('civ leaderboard command payload', () => {
  test('shows the selected civ leaderboard mode', async () => {
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

      const pickedPayload = await buildCivLeaderboardCommandPayload(db, kv, 'picked')
      const winratePayload = await buildCivLeaderboardCommandPayload(db, kv, 'winrate')
      const bannedPayload = await buildCivLeaderboardCommandPayload(db, kv, 'banned')
      const embeds = [pickedPayload, winratePayload, bannedPayload]
        .map(firstEmbedJson)

      expect(pickedPayload.content).toBeUndefined()
      expect(embeds.map(embed => embed.title)).toEqual([
        'Picked Leaders',
        'Win Rate Leaders',
        'Banned Leaders',
      ])
      expect(embeds).toHaveLength(3)
      expect(embeds[0]?.description).toContain('`#1 `')
      expect(embeds[0]?.description).toContain('🖱️ `50%  ` 🏆 `50%  ` 🚫 `16.7%`')
      expect(embeds[0]?.description).toContain('Trajan')
      expect(embeds[0]?.description).not.toContain('`Rome`')
      expect(embeds[1]?.description).toContain('🏆 `75%  ` 🖱️ `50%  ` 🚫 `33.3%`')
      expect(embeds[2]?.description).toContain('🚫 `33.3%` 🖱️ `50%  ` 🏆 `75%  `')
      expect(embeds.map(embed => embed.description).join('\n')).not.toContain('Aliens')
      expect(embeds[0]?.footer?.text).toBe('Page 1/1 - 1-2 of 2')
      expect(pickedPayload.components).toEqual([])
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

  test('rebuilds the cached civ snapshot from initialized stats', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values({ id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 })
      await seedCompletedMatch(db, 'cached-miss-match', 'rome-trajan', 'p1', 1)
      await backfillCivLeaderboardStatsFromHistory(db, 10)

      const payload = await buildCivLeaderboardCommandPayload(db, kv, 'picked')
      const embed = firstEmbedJson(payload)
      const cachedSnapshot = await kv.get(civLeaderboardSnapshotKey(), 'json') as { historyInitialized?: unknown } | null

      expect(payload.content).toBeUndefined()
      expect(embed.title).toBe('Picked Leaders')
      expect(embed.description).toContain('Trajan')
      expect(cachedSnapshot?.historyInitialized).toBe(true)
    }
    finally {
      sqlite.close()
    }
  })

  test('stays unavailable when civ stats are not initialized', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      const payload = await buildCivLeaderboardCommandPayload(db, kv, 'picked')
      const cachedSnapshot = await kv.get(civLeaderboardSnapshotKey(), 'json')

      expect(payload.embeds).toEqual([])
      expect(payload.content).toBe('Civ leaderboard history is not initialized yet.')
      expect(cachedSnapshot).toBeNull()
    }
    finally {
      sqlite.close()
    }
  })

  test('does not show partial aggregate snapshot before historical backfill', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values({ id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 })
      await seedCompletedMatch(db, 'partial-match', 'rome-trajan', 'p1', 1)
      await reconcileCivLeaderboardMatchContribution(db, 'partial-match', 10)
      await rebuildCivLeaderboardSnapshot(db, kv, 20)

      const payload = await buildCivLeaderboardCommandPayload(db, kv, 'picked')

      expect(payload.embeds).toEqual([])
      expect(payload.content).toBe('Civ leaderboard history is not initialized yet.')
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

  test('paginates selected civ leaderboard mode with bottom controls', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const rows = allLeaderIds.slice(0, 45).map((civId, index) => {
      const leader = getLeader(civId)
      const picks = 100 - index
      return {
        civId,
        leaderName: leader.name,
        picks,
        bans: index + 1,
        wins: picks - (index % 5),
        winRatePct: Math.round(((picks - (index % 5)) / picks) * 1000) / 10,
        banRatePct: index + 1,
      }
    })
    try {
      await kv.put(civLeaderboardSnapshotKey(), JSON.stringify({
        updatedAt: 1,
        historyInitialized: true,
        completedMatchCount: 100,
        rows,
      }))

      const topPayload = await buildCivLeaderboardCommandPayload(db, kv, 'picked')
      const topEmbed = firstEmbedJson(topPayload)
      const controls = topPayload.components as Array<{ components: Array<{ label: string, style: number, custom_id: string, disabled?: boolean }> }>

      expect(topEmbed?.title).toBe('Picked Leaders')
      expect(lineCount(topEmbed?.description)).toBe(CIV_LEADERBOARD_PAGE_SIZE)
      expect(topEmbed?.description).toContain('`#1 `')
      expect(topEmbed?.description).toContain(getLeader(allLeaderIds[0]!).name)
      expect(topEmbed?.footer?.text).toBe('Page 1/3 - 1-20 of 45')
      expect(controls[0]?.components.map(button => button.label)).toEqual(['Top', 'Prev', 'Next', 'Bottom'])
      expect(controls[0]?.components.map(button => button.style)).toEqual([2, 2, 2, 2])
      expect(customIds(controls)).toHaveLength(new Set(customIds(controls)).size)
      expect(controls[0]?.components[0]?.disabled).toBe(true)
      expect(controls[0]?.components[1]?.disabled).toBe(true)
      expect(controls[0]?.components[2]?.custom_id).toBe('pagination;civleaderboard:1:next:picked')
      expect(controls[0]?.components[3]?.custom_id).toBe('pagination;civleaderboard:2:bottom:picked')
      expect(parsePaginationCustomId(controls[0]?.components[2]?.custom_id)).toEqual({ namespace: 'civleaderboard', pageIndex: 1, args: ['picked'] })

      const bottomPayload = await buildCivLeaderboardCommandPayload(db, kv, 'picked', { pageIndex: 99 })
      const bottomEmbed = firstEmbedJson(bottomPayload)
      const bottomControls = bottomPayload.components as Array<{ components: Array<{ label: string, style: number, custom_id: string, disabled?: boolean }> }>

      expect(lineCount(bottomEmbed?.description)).toBe(CIV_LEADERBOARD_PAGE_SIZE)
      expect(bottomEmbed?.description).toContain('`#26`')
      expect(bottomEmbed?.description).toContain(getLeader(allLeaderIds[44]!).name)
      expect(bottomEmbed?.footer?.text).toBe('Page 3/3 - 26-45 of 45')
      expect(customIds(bottomControls)).toHaveLength(new Set(customIds(bottomControls)).size)
      expect(bottomControls[0]?.components[2]?.disabled).toBe(true)
      expect(bottomControls[0]?.components[3]?.disabled).toBe(true)
    }
    finally {
      sqlite.close()
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

  test('excludes CivBlitz matches from civ leaderboard stats', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values({ id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 })
      await seedCompletedMatch(db, 'civblitz-match', 'rome-trajan', 'p1', 1, { civBlitz: true })

      await reconcileCivLeaderboardMatchContribution(db, 'civblitz-match', 10)

      const contributionRows = await db.select({ matchId: matchCivStatContributions.matchId }).from(matchCivStatContributions)
      const snapshot = await rebuildCivLeaderboardSnapshot(db, kv, 20)

      expect(contributionRows).toEqual([])
      expect(snapshot.completedMatchCount).toBe(0)
      expect(snapshot.rows).toEqual([])
    }
    finally {
      sqlite.close()
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
      await seedCompletedMatch(db, 'civblitz-match', 'rome-trajan', 'p1', 4, { civBlitz: true })

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
  options: { redDeath?: boolean, civBlitz?: boolean } = {},
): Promise<void> {
  await db.insert(matches).values({
    id: matchId,
    gameMode: 'ffa',
    status: 'completed',
    isOld: false,
    seasonId: null,
    draftData: JSON.stringify({
      ...(options.redDeath ? { redDeath: true } : {}),
      ...(options.civBlitz ? { civBlitz: true } : {}),
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

function customIds(rows: Array<{ components: Array<{ custom_id: string }> }>): string[] {
  return rows.flatMap(row => row.components.map(component => component.custom_id))
}

function firstEmbedJson(payload: { embeds?: unknown[] }): { title?: string, description?: string, footer?: { text?: string } } {
  const embed = payload.embeds?.[0] as { toJSON?: () => { title?: string, description?: string, footer?: { text?: string } } } | undefined
  return embed?.toJSON?.() ?? {}
}
