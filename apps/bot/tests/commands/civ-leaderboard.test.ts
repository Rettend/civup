import type { Database } from '@civup/db'
import type { GameMode } from '@civup/game'
import { matchCivStatContributions as legacyMatchCivStatContributions, matches, matchParticipants, players, scopedMatchCivStatContributions as matchCivStatContributions, tournamentMatches, tournaments } from '@civup/db'
import { allLeaderIds, getLeader, liveLeaderDataVersionLabel } from '@civup/game'
import { describe, expect, test } from 'bun:test'
import { buildCivLeaderboardCommandPayload } from '../../src/commands/civ-leaderboard.ts'
import { CIV_LEADERBOARD_DESCRIPTION_CHAR_LIMIT, CIV_LEADERBOARD_PAGE_SIZE, CIV_LEADERBOARD_TOP_LIMIT, civLeaderboardEmbedGroups } from '../../src/embeds/civ-leaderboard.ts'
import { backfillCivLeaderboardStatsFromHistory, buildCivLeaderboardSnapshotFromD1, civLeaderboardSnapshotKey, rebuildCivLeaderboardSnapshot, rebuildCivLeaderboardSnapshots, reconcileCivLeaderboardMatchContribution, repairCivLeaderboardStatsFromContributions, setCivLeaderboardDisplayConfig } from '../../src/services/leaderboard/civ-snapshot.ts'
import { parsePaginationCustomId } from '../../src/services/response/pagination.ts'
import { createStatsContext } from '../../src/services/stats/context.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const PRIMARY_GUILD_ID = '111111111111111111'
const PARTNER_GUILD_ID = '222222222222222222'
const STATS_CONTEXT = createStatsContext(PRIMARY_GUILD_ID, PRIMARY_GUILD_ID)
const PARTNER_STATS_CONTEXT = createStatsContext(PARTNER_GUILD_ID, PRIMARY_GUILD_ID)

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

      await backfillCivLeaderboardStatsFromHistory(db, STATS_CONTEXT)
      await rebuildCivLeaderboardSnapshot(db, kv, STATS_CONTEXT)

      const pickedPayload = await buildCivLeaderboardCommandPayload(db, kv, 'picked', STATS_CONTEXT)
      const winratePayload = await buildCivLeaderboardCommandPayload(db, kv, 'winrate', STATS_CONTEXT)
      const bannedPayload = await buildCivLeaderboardCommandPayload(db, kv, 'banned', STATS_CONTEXT)
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
      expect(embeds[0]?.footer?.text).toBe(`BBG ${liveLeaderDataVersionLabel} - 24 Games | Page 1/1 - 1-2 of 2`)
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
          guildId: PRIMARY_GUILD_ID,
          isOld: false,
          seasonId: null,
          draftData: JSON.stringify({
            ...(input.redDeath ? { redDeath: true } : {}),
            state: {
              availableCivIds: ['rome-trajan', 'russia-peter'],
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
        await reconcileCivLeaderboardMatchContribution(db, STATS_CONTEXT, matchId)
      }
    }
  })

  test('rebuilds the cached civ snapshot from initialized stats', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values({ id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 })
      await seedCompletedMatch(db, 'cached-miss-match', 'rome-trajan', 'p1', 1)
      await backfillCivLeaderboardStatsFromHistory(db, STATS_CONTEXT, 10)
      await kv.put(civLeaderboardSnapshotKey(STATS_CONTEXT), JSON.stringify({
        updatedAt: 9,
        historyInitialized: true,
        label: 'Old Snapshot',
        completedMatchCount: 999,
        rows: [{ civId: 'stale-leader', leaderName: 'Stale Leader', picks: 999, wins: 999, bans: 999 }],
      }))

      const payload = await buildCivLeaderboardCommandPayload(db, kv, 'picked', STATS_CONTEXT)
      const embed = firstEmbedJson(payload)
      const cachedSnapshot = await kv.get(civLeaderboardSnapshotKey(STATS_CONTEXT), 'json') as { historyInitialized?: unknown, completedMatchCount?: unknown, rows?: Array<{ poolGames?: unknown }> } | null

      expect(payload.content).toBeUndefined()
      expect(embed.title).toBe('Picked Leaders')
      expect(embed.description).toContain('Trajan')
      expect(embed.description).not.toContain('Stale Leader')
      expect(cachedSnapshot?.historyInitialized).toBe(true)
      expect(cachedSnapshot?.completedMatchCount).toBe(1)
      expect(cachedSnapshot?.rows?.[0]?.poolGames).toBe(1)
    }
    finally {
      sqlite.close()
    }
  })

  test('stays unavailable when civ stats are not initialized', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      const payload = await buildCivLeaderboardCommandPayload(db, kv, 'picked', STATS_CONTEXT)
      const cachedSnapshot = await kv.get(civLeaderboardSnapshotKey(STATS_CONTEXT), 'json')

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
      await reconcileCivLeaderboardMatchContribution(db, STATS_CONTEXT, 'partial-match', 10)
      await rebuildCivLeaderboardSnapshot(db, kv, STATS_CONTEXT, 20)

      const payload = await buildCivLeaderboardCommandPayload(db, kv, 'picked', STATS_CONTEXT)

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
        poolGames: 100,
        pickRatePct: picks,
        winRatePct: Math.round((wins / picks) * 1000) / 10,
        banRatePct: 80 - (index % 25),
      }
    })

    const groups = civLeaderboardEmbedGroups({
      updatedAt: 1,
      historyInitialized: true,
      label: 'BBG Test',
      modeScope: 'all',
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
        poolGames: 100,
        pickRatePct: picks,
        winRatePct: Math.round(((picks - (index % 5)) / picks) * 1000) / 10,
        banRatePct: index + 1,
      }
    })
    try {
      await kv.put(civLeaderboardSnapshotKey(STATS_CONTEXT), JSON.stringify({
        updatedAt: 1,
        historyInitialized: true,
        label: 'BBG Test',
        modeScope: 'all',
        completedMatchCount: 100,
        rows,
      }))

      const topPayload = await buildCivLeaderboardCommandPayload(db, kv, 'picked', STATS_CONTEXT)
      const topEmbed = firstEmbedJson(topPayload)
      const controls = topPayload.components as Array<{ components: Array<{ label: string, style: number, custom_id: string, disabled?: boolean }> }>

      expect(topEmbed?.title).toBe('Picked Leaders')
      expect(lineCount(topEmbed?.description)).toBe(CIV_LEADERBOARD_PAGE_SIZE)
      expect(topEmbed?.description).toContain('`#1 `')
      expect(topEmbed?.description).toContain(getLeader(allLeaderIds[0]!).name)
      expect(topEmbed?.footer?.text).toBe('BBG Test - 100 Games | Page 1/3 - 1-20 of 45')
      expect(controls[0]?.components.map(button => button.label)).toEqual(['Top', 'Prev', 'Next', 'Bottom'])
      expect(controls[0]?.components.map(button => button.style)).toEqual([2, 2, 2, 2])
      expect(customIds(controls)).toHaveLength(new Set(customIds(controls)).size)
      expect(controls[0]?.components[0]?.disabled).toBe(true)
      expect(controls[0]?.components[1]?.disabled).toBe(true)
      expect(controls[0]?.components[2]?.custom_id).toBe('pagination;civleaderboard:1:next:picked')
      expect(controls[0]?.components[3]?.custom_id).toBe('pagination;civleaderboard:2:bottom:picked')
      expect(parsePaginationCustomId(controls[0]?.components[2]?.custom_id)).toEqual({ namespace: 'civleaderboard', pageIndex: 1, args: ['picked'] })

      const bottomPayload = await buildCivLeaderboardCommandPayload(db, kv, 'picked', STATS_CONTEXT, { pageIndex: 99 })
      const bottomEmbed = firstEmbedJson(bottomPayload)
      const bottomControls = bottomPayload.components as Array<{ components: Array<{ label: string, style: number, custom_id: string, disabled?: boolean }> }>

      expect(lineCount(bottomEmbed?.description)).toBe(CIV_LEADERBOARD_PAGE_SIZE)
      expect(bottomEmbed?.description).toContain('`#26`')
      expect(bottomEmbed?.description).toContain(getLeader(allLeaderIds[44]!).name)
      expect(bottomEmbed?.footer?.text).toBe('BBG Test - 100 Games | Page 3/3 - 26-45 of 45')
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
        guildId: PRIMARY_GUILD_ID,
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

      await reconcileCivLeaderboardMatchContribution(db, STATS_CONTEXT, 'match-1', 10)
      let snapshot = await rebuildCivLeaderboardSnapshot(db, kv, STATS_CONTEXT, 20)
      expect(snapshot.completedMatchCount).toBe(1)
      expect(snapshot.rows.find(row => row.civId === 'rome-trajan')).toMatchObject({ picks: 1, wins: 1, bans: 1 })

      await db.update(matchParticipants).set({ civId: 'russia-peter', placement: 2 })
      await db.update(matches).set({ draftData: JSON.stringify({ state: { bans: [{ civId: 'russia-peter' }] } }) })
      await reconcileCivLeaderboardMatchContribution(db, STATS_CONTEXT, 'match-1', 30)
      snapshot = await rebuildCivLeaderboardSnapshot(db, kv, STATS_CONTEXT, 40)
      expect(snapshot.completedMatchCount).toBe(1)
      expect(snapshot.rows.find(row => row.civId === 'rome-trajan')).toBeUndefined()
      expect(snapshot.rows.find(row => row.civId === 'russia-peter')).toMatchObject({ picks: 1, wins: 0, bans: 1 })

      await db.update(matches).set({ status: 'cancelled' })
      await reconcileCivLeaderboardMatchContribution(db, STATS_CONTEXT, 'match-1', 50)
      snapshot = await rebuildCivLeaderboardSnapshot(db, kv, STATS_CONTEXT, 60)
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

      await reconcileCivLeaderboardMatchContribution(db, STATS_CONTEXT, 'target-match', 10)

      const contributionRows = await db
        .select({ matchId: matchCivStatContributions.matchId, source: matchCivStatContributions.source, modeScope: matchCivStatContributions.modeScope, completedAt: matchCivStatContributions.completedAt })
        .from(matchCivStatContributions)
      expect(contributionRows).toEqual([{ matchId: 'target-match', source: 'live', modeScope: 'all', completedAt: 2 }])
    }
    finally {
      sqlite.close()
    }

    async function seedCompletedMatch(matchId: string, civId: string, createdAt: number): Promise<void> {
      await db.insert(matches).values({
        id: matchId,
        gameMode: 'ffa',
        status: 'completed',
        guildId: PRIMARY_GUILD_ID,
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

      await reconcileCivLeaderboardMatchContribution(db, STATS_CONTEXT, 'civblitz-match', 10)

      const contributionRows = await db.select({ matchId: matchCivStatContributions.matchId }).from(matchCivStatContributions)
      const snapshot = await rebuildCivLeaderboardSnapshot(db, kv, STATS_CONTEXT, 20)

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

      const historical = await buildCivLeaderboardSnapshotFromD1(db, STATS_CONTEXT, 10)
      const first = await backfillCivLeaderboardStatsFromHistory(db, STATS_CONTEXT, 20)
      const second = await backfillCivLeaderboardStatsFromHistory(db, STATS_CONTEXT, 30)
      const snapshot = await rebuildCivLeaderboardSnapshot(db, kv, STATS_CONTEXT, 40)

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

  test('keeps civ aggregates, snapshots, and legacy writes isolated by owning server', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values({ id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 })
      await seedCompletedMatch(db, 'primary-match', 'rome-trajan', 'p1', 1)
      await seedCompletedMatch(db, 'partner-match', 'russia-peter', 'p1', 2, { guildId: PARTNER_GUILD_ID })

      await backfillCivLeaderboardStatsFromHistory(db, STATS_CONTEXT, 10)
      await backfillCivLeaderboardStatsFromHistory(db, PARTNER_STATS_CONTEXT, 20)
      const primary = await rebuildCivLeaderboardSnapshot(db, kv, STATS_CONTEXT, 30)
      const partner = await rebuildCivLeaderboardSnapshot(db, kv, PARTNER_STATS_CONTEXT, 40)

      expect(primary.rows.map(row => row.civId)).toEqual(['rome-trajan'])
      expect(partner.rows.map(row => row.civId)).toEqual(['russia-peter'])
      expect(civLeaderboardSnapshotKey(STATS_CONTEXT)).not.toBe(civLeaderboardSnapshotKey(PARTNER_STATS_CONTEXT))

      const legacyRows = await db.select({ matchId: legacyMatchCivStatContributions.matchId }).from(legacyMatchCivStatContributions)
      expect(legacyRows).toEqual([{ matchId: 'primary-match' }])
    }
    finally {
      sqlite.close()
    }
  })

  test('builds scoped civ snapshots with ffa contributing only to all', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values({ id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 })
      await seedCompletedMatch(db, 'duel-match', 'rome-trajan', 'p1', 1, { gameMode: '1v1' })
      await seedCompletedMatch(db, 'duo-match', 'russia-peter', 'p1', 2, { gameMode: '2v2' })
      await seedCompletedMatch(db, 'ffa-match', 'greece-pericles', 'p1', 3, { gameMode: 'ffa' })

      await backfillCivLeaderboardStatsFromHistory(db, STATS_CONTEXT, 10)
      const snapshots = await rebuildCivLeaderboardSnapshots(db, kv, STATS_CONTEXT, ['all', 'duel', 'duo', 'squad'], 20)

      expect(snapshots.get('all')?.completedMatchCount).toBe(3)
      expect(snapshots.get('duel')?.completedMatchCount).toBe(1)
      expect(snapshots.get('duo')?.completedMatchCount).toBe(1)
      expect(snapshots.get('squad')?.completedMatchCount).toBe(0)
      expect(snapshots.get('duel')?.rows.map(row => row.civId)).toEqual(['rome-trajan'])
      expect(snapshots.get('duo')?.rows.map(row => row.civId)).toEqual(['russia-peter'])
      expect(snapshots.get('squad')?.rows).toEqual([])

      const duelPayload = await buildCivLeaderboardCommandPayload(db, kv, 'picked', STATS_CONTEXT, { modeScope: 'duel' })
      const duoPayload = await buildCivLeaderboardCommandPayload(db, kv, 'picked', STATS_CONTEXT, { modeScope: 'duo' })
      const squadPayload = await buildCivLeaderboardCommandPayload(db, kv, 'picked', STATS_CONTEXT, { modeScope: 'squad' })

      expect(firstEmbedJson(duelPayload).title).toBe('Picked Leaders (Duel)')
      expect(firstEmbedJson(duelPayload).description).toContain('Trajan')
      expect(firstEmbedJson(duoPayload).title).toBe('Picked Leaders (Duo)')
      expect(firstEmbedJson(duoPayload).description).toContain('Peter')
      expect(firstEmbedJson(squadPayload).title).toBe('Picked Leaders (Squad)')
      expect(firstEmbedJson(squadPayload).description).toBe('No completed matches with picked leaders yet.')
    }
    finally {
      sqlite.close()
    }
  })

  test('filters visible live and beta contribution windows', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values({ id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 })
      await seedCompletedMatch(db, 'live-match', 'rome-trajan', 'p1', 10)
      await seedCompletedMatch(db, 'visible-beta-match', 'russia-peter', 'p1', 20, { leaderDataVersion: 'beta' })
      await seedCompletedMatch(db, 'hidden-beta-match', 'greece-pericles', 'p1', 30, { leaderDataVersion: 'beta' })
      await backfillCivLeaderboardStatsFromHistory(db, STATS_CONTEXT, 40)
      const config = {
        version: 1,
        label: 'BBG Mixed',
        liveFrom: 0,
        betaFrom: 15,
        betaUntil: 25,
        pendingBetaFrom: 25,
      } as const
      await setCivLeaderboardDisplayConfig(kv, STATS_CONTEXT, config)
      await repairCivLeaderboardStatsFromContributions(db, STATS_CONTEXT, 45, config)

      const snapshot = await rebuildCivLeaderboardSnapshot(db, kv, STATS_CONTEXT, 50)

      expect(snapshot.label).toBe('BBG Mixed')
      expect(snapshot.completedMatchCount).toBe(2)
      expect(snapshot.rows.map(row => row.civId).sort()).toEqual(['rome-trajan', 'russia-peter'])
      expect(snapshot.rows.find(row => row.civId === 'greece-pericles')).toBeUndefined()
    }
    finally {
      sqlite.close()
    }
  })

  test('repair keeps ineligible stored contributions hidden', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await db.insert(players).values({ id: 'p1', displayName: 'P1', avatarUrl: null, createdAt: 1 })
      await seedCompletedMatch(db, 'valid-match', 'rome-trajan', 'p1', 10)
      await seedCompletedMatch(db, 'red-death-match', 'greece-pericles', 'p1', 20, { redDeath: true })
      await seedCompletedMatch(db, 'civblitz-match', 'russia-peter', 'p1', 30, { civBlitz: true })
      await seedCompletedMatch(db, 'tournament-match', 'russia-peter', 'p1', 40)
      await db.insert(tournaments).values({
        id: 'cup',
        name: 'Cup',
        mode: '1v1',
        status: 'qualifier',
        scoring: 'open_win_rate',
        rematchPolicy: 'warn',
        minGames: 1,
        topCut: 8,
        roleId: null,
        createdById: 'admin',
        createdAt: 1,
        updatedAt: 1,
      })
      await db.insert(tournamentMatches).values({
        sessionId: 'tournament-session',
        tournamentId: 'cup',
        matchId: 'tournament-match',
        stage: 'qualifier',
        status: 'reported',
        playerOneId: null,
        playerTwoId: null,
        winnerId: null,
        createdAt: 1,
        updatedAt: 1,
      })
      await db.insert(matchCivStatContributions).values([
        storedContribution('valid-match', 'rome-trajan', 10),
        storedContribution('red-death-match', 'greece-pericles', 20),
        storedContribution('civblitz-match', 'russia-peter', 30),
        storedContribution('tournament-match', 'russia-peter', 40),
      ])

      const config = {
        version: 1,
        label: 'BBG Live',
        liveFrom: 0,
        betaFrom: null,
        betaUntil: null,
        pendingBetaFrom: 0,
      } as const
      const result = await repairCivLeaderboardStatsFromContributions(db, STATS_CONTEXT, 50, config)
      const contributionRows = await db
        .select({ matchId: matchCivStatContributions.matchId, visible: matchCivStatContributions.visible })
        .from(matchCivStatContributions)

      expect(result.snapshot.rows.map(row => row.civId)).toEqual(['rome-trajan'])
      expect(Object.fromEntries(contributionRows.map(row => [row.matchId, row.visible]))).toEqual({
        'valid-match': true,
        'red-death-match': false,
        'civblitz-match': false,
        'tournament-match': false,
      })
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
  options: { redDeath?: boolean, civBlitz?: boolean, gameMode?: GameMode, leaderDataVersion?: 'live' | 'beta', poolCivIds?: string[], guildId?: string } = {},
): Promise<void> {
  await db.insert(matches).values({
    id: matchId,
    gameMode: options.gameMode ?? 'ffa',
    status: 'completed',
    guildId: options.guildId ?? PRIMARY_GUILD_ID,
    isOld: false,
    seasonId: null,
    draftData: JSON.stringify({
      ...(options.redDeath ? { redDeath: true } : {}),
      ...(options.civBlitz ? { civBlitz: true } : {}),
      ...(options.leaderDataVersion ? { leaderDataVersion: options.leaderDataVersion } : {}),
      state: { availableCivIds: options.poolCivIds, bans: [{ civId }] },
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

function storedContribution(matchId: string, civId: string, completedAt: number): typeof matchCivStatContributions.$inferInsert {
  return {
    statsKey: STATS_CONTEXT.statsKey,
    matchId,
    completedMatchCount: 1,
    contributionsJson: JSON.stringify({
      version: 2,
      poolCivIds: [civId],
      entries: [{ civId, picks: 1, wins: 1, bans: 1 }],
    }),
    source: 'live',
    modeScope: 'all',
    completedAt,
    visible: false,
    updatedAt: 1,
  }
}

function embedGroupTextLength(embeds: Array<{ toJSON: () => { title?: unknown, description?: unknown, footer?: { text?: unknown } } }>): number {
  return embeds.reduce((total, embed) => {
    const json = embed.toJSON()
    return total + stringLength(json.title) + stringLength(json.description) + stringLength(json.footer?.text)
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
