import type { Database } from '@civup/db'
import { divisionRankPolicies, divisionRankStates, divisionQualityCredits, matches, matchParticipants, matchPlayerCivStatContributions, playerCivStats, playerRatingEvents, playerRatings, players, publicRatingCalibrations, publicRatingDecayPolicies, publicRatingSeeds, seasonMatchReports, seasonRatingCheckpoints, seasonRatingConfigurations, seasonRatingStates, seasons } from '@civup/db'
import { calibratePublicRatings, ONE_DIVISION_RANK_POLICY_VERSION, PUBLIC_RATING_BANDS, PUBLIC_RATING_FORMULA_VERSION } from '@civup/rating'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { prepareSeasonReport, runAtomicSeasonBatch } from '../../src/services/season/report.ts'
import { reportMatch } from '../../src/services/match/report.ts'
import { prepareSeasonReplay } from '../../src/services/season/replay.ts'
import { initializeQualityCheckpointPage } from '../../src/services/ranked/quality-checkpoint.ts'
import { initializeSeasonCheckpointPage } from '../../src/services/season/checkpoints.ts'
import { cancelMatchByModerator, resolveMatchByModerator } from '../../src/services/match/moderation.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

async function setup() {
  const fixture = await createTestDatabase()
  const db = new Proxy(fixture.db, {
    get(target, property) {
      if (property === 'batch') return async (queries: Array<{ run(): unknown }>) => fixture.sqlite.transaction(() => queries.map(query => query.run()))()
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as Database
  await db.insert(players).values(['p', 'q'].map(id => ({ id, displayName: id, createdAt: 0 })))
  await db.insert(seasons).values({ id: 's9', seasonNumber: 9, name: 'Season 9', startsAt: 1000, active: true, ratingSystem: 'rp', isolatedRatingsEnabled: true })
  for (const scope of ['global', 'duel']) {
    const calibration = calibratePublicRatings({ scope, version: `test-${scope}`, sourceDigest: 'fixture', qualifiedHiddenScores: Array.from({ length: 101 }, (_, index) => index) })
    await db.insert(publicRatingCalibrations).values({ ...calibration, calibration, createdAt: 1000 })
    await db.insert(seasonRatingConfigurations).values({ seasonId: 's9', mode: scope, formulaVersion: PUBLIC_RATING_FORMULA_VERSION, calibrationVersion: calibration.version })
  }
  const addMatch = async (id: string, createdAt: number, seasonId = 's9', isOld = false) => {
    await db.insert(matches).values({ id, seasonId, gameMode: '1v1', createdAt, status: 'active', isOld, draftData: JSON.stringify({ completedAt: createdAt + 1 }) })
    await db.insert(matchParticipants).values(['p', 'q'].map((playerId, team) => ({ matchId: id, playerId, team, placement: team + 1 })))
    const [match] = await db.select().from(matches).where(eq(matches.id, id))
    const participants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, id))
    return { match: match!, participants }
  }
  return { db, sqlite: fixture.sqlite, addMatch }
}

describe('atomic season reporting', () => {
  let clock: ReturnType<typeof spyOn>
  beforeEach(() => { clock = spyOn(Date, 'now').mockReturnValue(3000) })
  afterEach(() => { clock.mockRestore() })
  test.each(['p', 'q'])('restoring a cancelled rated match with winner %s matches uninterrupted history', async (winner) => {
    const fixtures = await Promise.all([setup(), setup()])
    try {
      for (const [index, { db, addMatch }] of fixtures.entries()) {
        for (const [id, at] of [['target', 1100], ['later', 1300]] as const) {
          const input = await addMatch(id, at)
          if (index === 1 && id === 'target' && winner === 'q') {
            for (const row of input.participants) {
              row.placement = row.playerId === winner ? 1 : 2
              await db.update(matchParticipants).set({ placement: row.placement }).where(eq(matchParticipants.playerId, row.playerId))
            }
          }
          await runAtomicSeasonBatch(db, (await prepareSeasonReport(db, { ...input, acceptedAt: at + 1, now: at + 1, opponentTierByPlayerId: new Map() })).queries)
          await db.update(matches).set({ status: 'completed' }).where(eq(matches.id, id))
        }
      }
      const { db } = fixtures[0]!
      await runAtomicSeasonBatch(db, (await prepareSeasonReplay(db, 's9', { matchId: 'target', cancel: true }, 1500)).queries)
      await db.update(matches).set({ status: 'cancelled' }).where(eq(matches.id, 'target'))
      const participants = (await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, 'target'))).map(row => ({ ...row, placement: row.playerId === winner ? 1 : 2 }))
      const replay = await prepareSeasonReplay(db, 's9', { matchId: 'target', participants, restore: true }, 1600)
      expect(replay.matchIds).toEqual(['target', 'later'])
      await runAtomicSeasonBatch(db, replay.queries)
      const saved = await db.select().from(playerRatingEvents)
      // A retry after a terminal-write interruption must preserve the restored winner.
      expect(await resolveMatchByModerator(db, createTestKv(), { matchId: 'target', placements: winner === 'p' ? '<@q>' : '<@p>', resolvedAt: 3000 }, { allowDirectTerminalWriteForTests: true })).toMatchObject({ match: { status: 'completed' } })
      expect(await db.select().from(playerRatingEvents)).toEqual(saved)
      const normalize = (rows: typeof saved) => rows.map(({ updatedAt, ...row }) => row).sort((a, b) => `${a.matchId}:${a.playerId}:${a.mode}`.localeCompare(`${b.matchId}:${b.playerId}:${b.mode}`))
      expect(normalize(saved)).toEqual(normalize(await fixtures[1]!.db.select().from(playerRatingEvents)))
      expect(await db.select().from(seasonMatchReports)).toEqual(await fixtures[1]!.db.select().from(seasonMatchReports))
      await expect(prepareSeasonReplay(db, 's9', undefined, 3000)).resolves.toBeDefined()
    }
    finally { for (const fixture of fixtures) fixture.sqlite.close() }
  })
  test('cancelled first-report recovery preserves the saved winner and never rates twice', async () => {
    const { db, sqlite, addMatch } = await setup()
    try {
      const input = await addMatch('cancelled-first-report', 1100)
      await db.update(matches).set({ status: 'cancelled' }).where(eq(matches.id, input.match.id))
      input.match.status = 'cancelled'
      const reportInput = { ...input, acceptedAt: 1200, now: 1200, opponentTierByPlayerId: new Map() }
      // Participant reporting cannot bypass cancellation; only moderator resolution opts in.
      await expect(runAtomicSeasonBatch(db, (await prepareSeasonReport(db, reportInput)).queries)).rejects.toThrow()
      expect(await db.select().from(playerRatingEvents)).toHaveLength(0)
      await runAtomicSeasonBatch(db, (await prepareSeasonReport(db, { ...reportInput, allowCancelled: true })).queries)
      const events = await db.select().from(playerRatingEvents)
      const ratings = await db.select().from(playerRatings)
      const reports = await db.select().from(seasonMatchReports)
      // Simulate a saved rating transaction whose terminal lifecycle update was interrupted.
      const result = await resolveMatchByModerator(db, createTestKv(), { matchId: input.match.id, placements: '<@q>', resolvedAt: 3000 }, { allowDirectTerminalWriteForTests: true })
      expect(result).toMatchObject({ match: { status: 'completed' } })
      expect((await db.select().from(matchParticipants)).find(row => row.playerId === 'p')!.placement).toBe(1)
      expect(await db.select().from(playerRatingEvents)).toEqual(events)
      expect(await db.select().from(playerRatings)).toEqual(ratings)
      expect(await db.select().from(seasonMatchReports)).toEqual(reports)
    }
    finally { sqlite.close() }
  })
  test('a recent substitution replays over 100 connected reports and players with overall divisions atomically', async () => {
    const { db, sqlite, addMatch } = await setup()
    try {
      await db.insert(players).values([...Array.from({ length: 101 }, (_, i) => `opponent-${i}`), 'sub'].map(id => ({ id, displayName: id, createdAt: 0 })))
      for (let i = 0; i < 101; i++) {
        const input = await addMatch(`large-${i}`, 1100 + i)
        await db.update(matchParticipants).set({ playerId: `opponent-${i}` }).where(eq(matchParticipants.playerId, 'q'))
        input.participants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, input.match.id))
        await runAtomicSeasonBatch(db, (await prepareSeasonReport(db, { ...input, acceptedAt: 1300 + i, now: 1300 + i, opponentTierByPlayerId: new Map() })).queries)
        await db.update(matches).set({ status: 'completed', completedAt: 1300 + i }).where(eq(matches.id, input.match.id))
      }
      await db.update(seasons).set({ publicReadsEnabled: true }).where(eq(seasons.id, 's9'))
      await db.insert(divisionRankPolicies).values({ guildId: 'guild', seasonId: 's9', version: ONE_DIVISION_RANK_POLICY_VERSION, phase: 'active', updatedAt: 1500,
        configJson: JSON.stringify({ preparation: { unrankedRoleId: 'unranked', roleIdsByMinimum: Object.fromEntries(PUBLIC_RATING_BANDS.map(b => [b.minimum, `role-${b.minimum}`])) } }) })
      for (const player of ['p', ...Array.from({ length: 101 }, (_, i) => `opponent-${i}`)]) {
        while (!await initializeQualityCheckpointPage(db, 'guild', player, 1500)) {}
      }
      const participants = (await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, 'large-0'))).map(row => ({ ...row, playerId: row.playerId === 'p' ? 'sub' : row.playerId }))
      const replay = await prepareSeasonReplay(db, 's9', { matchId: 'large-0', participants }, 1500)
      expect(replay.matchIds).toHaveLength(101)
      expect(replay.queries.length).toBeGreaterThan(400)
      for (const query of replay.queries) expect((query as unknown as { toSQL(): { params: unknown[] } }).toSQL().params.length).toBeLessThanOrEqual(100)
      await runAtomicSeasonBatch(db, replay.queries)
      expect(await db.select().from(playerRatingEvents)).toHaveLength(404)
      expect((await db.select().from(seasonRatingStates).where(eq(seasonRatingStates.playerId, 'p'))).every(row => row.seasonGames === 100)).toBe(true)
      expect((await db.select().from(seasonRatingStates).where(eq(seasonRatingStates.playerId, 'sub'))).every(row => row.seasonGames === 1)).toBe(true)
      expect(await db.select().from(divisionRankStates)).toHaveLength(103)
      expect((await prepareSeasonReplay(db, 's9', undefined, 1600)).matchIds).toHaveLength(101)
    }
    finally { sqlite.close() }
  })
  test('historical checkpoint pages resume, verify complete summaries, and reject partial or racing sources', async () => {
    const { db, sqlite, addMatch } = await setup()
    try {
      for (let i = 0; i < 41; i++) {
        const input = await addMatch(`checkpoint-${i}`, 1100 + i)
        await runAtomicSeasonBatch(db, (await prepareSeasonReport(db, { ...input, acceptedAt: 1200 + i, now: 1200 + i, opponentTierByPlayerId: new Map() })).queries)
        await db.update(matches).set({ status: 'completed', completedAt: 1200 + i }).where(eq(matches.id, input.match.id))
      }
      const saved = await db.select().from(seasonRatingCheckpoints)
      const before = await db.select().from(seasonRatingStates)
      await db.delete(seasonRatingCheckpoints)
      await expect(prepareSeasonReplay(db, 's9', { matchId: 'checkpoint-40', cancel: true }, 1400)).rejects.toThrow('checkpoints are not ready')
      await expect(initializeSeasonCheckpointPage(db, 's9', 'p', 'global', 1)).rejects.toThrow()
      expect(await db.select().from(seasonRatingCheckpoints)).toHaveLength(0)
      sqlite.exec("update rating_maintenance set state='paused', generation=1")
      expect(await initializeSeasonCheckpointPage(db, 's9', 'p', 'global', 1)).toBe(false)
      expect(await db.select().from(seasonRatingCheckpoints)).toHaveLength(40)
      await expect(prepareSeasonReplay(db, 's9', { matchId: 'checkpoint-40', cancel: true }, 1400)).rejects.toThrow('checkpoints are not ready')
      sqlite.exec("update season_rating_states set season_games=season_games+1 where player_id='p' and mode='global'")
      await expect(initializeSeasonCheckpointPage(db, 's9', 'p', 'global', 1)).rejects.toThrow('saved season summary')
      expect(await db.select().from(seasonRatingCheckpoints)).toHaveLength(40)
      sqlite.exec("update season_rating_states set season_games=season_games-1 where player_id='p' and mode='global'")
      expect(await initializeSeasonCheckpointPage(db, 's9', 'p', 'global', 1)).toBe(true)
      for (const [playerId, mode] of [['p', 'duel'], ['q', 'global'], ['q', 'duel']] as const) {
        while (!await initializeSeasonCheckpointPage(db, 's9', playerId, mode, 1)) {}
      }
      const rebuilt = await db.select().from(seasonRatingCheckpoints)
      const normalize = (rows: typeof rebuilt) => rows.map(row => ({ ...row, fromHistory: false, summary: JSON.parse(row.summary) }))
        .sort((a, b) => a.sequence - b.sequence || a.playerId.localeCompare(b.playerId) || a.mode.localeCompare(b.mode))
      expect(normalize(rebuilt)).toEqual(normalize(saved))
      expect(await db.select().from(seasonRatingStates)).toEqual(before)
      const prepared = await prepareSeasonReplay(db, 's9', { matchId: 'checkpoint-40', cancel: true }, 1400)
      sqlite.exec("update season_rating_checkpoints set summary=json_set(summary,'$.seasonWins',0) where player_id='p' and mode='global' and match_id='checkpoint-39'")
      await expect(runAtomicSeasonBatch(db, prepared.queries)).rejects.toThrow()
      expect(await db.select().from(seasonRatingStates)).toEqual(before)
    }
    finally { sqlite.close() }
  })
  test('replay accepts machine-rounding differences but rejects materially changed rating events', async () => {
    const { db, sqlite, addMatch } = await setup()
    try {
      const input = await addMatch('rounding', 1100)
      await runAtomicSeasonBatch(db, (await prepareSeasonReport(db, { ...input, acceptedAt: 1200, now: 1200, opponentTierByPlayerId: new Map() })).queries)
      await db.update(matches).set({ status: 'completed', completedAt: 1200 }).where(eq(matches.id, 'rounding'))
      sqlite.exec("update player_rating_events set public_rating_after=public_rating_after+0.0000000000001 where match_id='rounding' and player_id='p' and mode='global'")
      expect((await prepareSeasonReplay(db, 's9', { matchId: 'rounding', cancel: true }, 1300)).matchIds).toEqual(['rounding'])
      sqlite.exec("update player_rating_events set public_rating_after=public_rating_after+0.001 where match_id='rounding' and player_id='p' and mode='global'")
      await expect(prepareSeasonReplay(db, 's9', { matchId: 'rounding', cancel: true }, 1300)).rejects.toThrow('No-op season replay did not reproduce')
    }
    finally { sqlite.close() }
  })

  test('cancellation skips unrelated reports and restores late-joining opponents from their own chain prefixes', async () => {
    const { db, sqlite, addMatch } = await setup()
    try {
      await db.insert(players).values(['r', 's', 't'].map(id => ({ id, displayName: id, createdAt: 0 })))
      async function play(id: string, first: string, second: string, at: number) {
        const input = await addMatch(id, at)
        await db.delete(matchParticipants).where(eq(matchParticipants.matchId, id))
        await db.insert(matchParticipants).values(input.participants.map((row, index) => ({ ...row, playerId: index === 0 ? first : second })))
        const participants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, id))
        await runAtomicSeasonBatch(db, (await prepareSeasonReport(db, { match: input.match, participants, acceptedAt: at, now: at, opponentTierByPlayerId: new Map() })).queries)
        await db.update(matches).set({ status: 'completed', completedAt: at }).where(eq(matches.id, id))
      }
      await play('target', 'p', 'q', 1100)
      for (let i = 0; i < 42; i++) await play(`unrelated-${i}`, 'r', 's', 1200 + i)
      await play('connected', 'p', 'r', 1300)
      await play('transitive', 'r', 't', 1400)
      const original = (await db.select().from(playerRatingEvents)).filter(row => row.matchId.startsWith('unrelated-'))
      const replay = await prepareSeasonReplay(db, 's9', { matchId: 'target', cancel: true }, 1500)
      expect(replay.matchIds).toEqual(['target', 'connected', 'transitive'])
      await runAtomicSeasonBatch(db, replay.queries)
      const after = await db.select().from(playerRatingEvents)
      expect(after.filter(row => row.matchId.startsWith('unrelated-'))).toEqual(original)
      expect(after.filter(row => row.matchId === 'target')).toHaveLength(0)
      expect((await db.select().from(playerRatings)).filter(row => row.playerId === 'r').every(row => row.effectiveGames === 44)).toBe(true)
    }
    finally { sqlite.close() }
  })

  test('v2 report and cancellation commit overall assignments with ratings, and reject concurrent other-mode changes', async () => {
    const { db, sqlite, addMatch } = await setup()
    try {
      for (let i = 0; i < 3; i++) {
        const input = await addMatch(`prior-${i}`, 1100 + i)
        await runAtomicSeasonBatch(db, (await prepareSeasonReport(db, { ...input, acceptedAt: 1200 + i, now: 1200 + i, opponentTierByPlayerId: new Map() })).queries)
        await db.update(matches).set({ status: 'completed' }).where(eq(matches.id, input.match.id))
      }
      await db.update(seasons).set({ publicReadsEnabled: true }).where(eq(seasons.id, 's9'))
      await db.insert(divisionRankPolicies).values({ guildId: 'guild', seasonId: 's9', version: 'best-mode-quality-v1', phase: 'active', updatedAt: 1300,
        configJson: JSON.stringify({ preparation: { unrankedRoleId: 'unranked', roleIdsByMinimum: Object.fromEntries(PUBLIC_RATING_BANDS.map(b => [b.minimum, `role-${b.minimum}`])) } }) })
      const match = await addMatch('fourth', 1400)
      const input = { ...match, acceptedAt: 1500, now: 1500, opponentTierByPlayerId: new Map() }
      for (const player of ['p', 'q']) await initializeQualityCheckpointPage(db, 'guild', player, 1500)
      const prepared = await prepareSeasonReport(db, input)
      await db.insert(playerRatings).values({ playerId: 'p', mode: 'duo', effectiveGames: 0, publicRating: 750 })
      await expect(runAtomicSeasonBatch(db, prepared.queries)).rejects.toThrow()
      expect((await db.select().from(playerRatingEvents)).filter(e => e.matchId === 'fourth')).toHaveLength(0)
      expect(await db.select().from(divisionRankStates)).toHaveLength(0)
      await runAtomicSeasonBatch(db, (await prepareSeasonReport(db, input)).queries)
      const assigned = await db.select().from(divisionRankStates)
      expect(assigned).toHaveLength(2)
      for (const state of assigned) {
        const result = JSON.parse(state.resultJson!)
        expect(result.policyVersion).toBe(ONE_DIVISION_RANK_POLICY_VERSION)
        expect(result.band).not.toBeNull()
        expect(result.qualityUplift).toBeLessThanOrEqual(1)
        expect(state.projectionPending).toBe(true)
        expect(state.pending).toBe(true)
      }
      expect(await db.select().from(divisionQualityCredits)).toHaveLength(8)
      await db.update(matches).set({ status: 'completed' }).where(eq(matches.id, 'fourth'))
      const replay = await prepareSeasonReplay(db, 's9', { matchId: 'fourth', cancel: true }, 1600)
      await runAtomicSeasonBatch(db, replay.queries)
      for (const state of await db.select().from(divisionRankStates)) expect(JSON.parse(state.resultJson!).band).toBeNull()
      expect(await db.select().from(divisionQualityCredits)).toHaveLength(6)
      expect((await db.select().from(playerRatings)).filter(r => r.mode === 'duel').every(r => r.effectiveGames === 3)).toBe(true)
    }
    finally { sqlite.close() }
  })

  test('moderators cannot scrap past-season games even within the late reporting window', async () => {
    const { db, sqlite, addMatch } = await setup()
    try {
      const now = Date.now()
      await db.insert(seasons).values({ id: 's8', seasonNumber: 8, name: 'Season 8', startsAt: 0, endsAt: 1000, reportingDeadline: now + 60_000, isolatedRatingsEnabled: true })
      const rated = await addMatch('rated', 500, 's8')
      await runAtomicSeasonBatch(db, (await prepareSeasonReport(db, { ...rated, acceptedAt: now, now, opponentTierByPlayerId: new Map() })).queries)
      const current = await addMatch('current', 1100)
      await runAtomicSeasonBatch(db, (await prepareSeasonReport(db, { ...current, acceptedAt: now, now, opponentTierByPlayerId: new Map() })).queries)
      await addMatch('scrap', 600, 's8')
      await db.update(matchParticipants).set({ placement: null }).where(eq(matchParticipants.matchId, 'scrap'))
      const ratings = await db.select().from(playerRatings)
      const states = await db.select().from(seasonRatingStates)
      const events = await db.select().from(playerRatingEvents)
      const kv = createTestKv()
      const options = { allowDirectTerminalWriteForTests: true }
      expect(await cancelMatchByModerator(db, kv, { matchId: 'scrap', cancelledAt: now }, options)).toMatchObject({ error: expect.stringContaining('older season') })
      expect(await cancelMatchByModerator(db, kv, { matchId: 'rated', cancelledAt: now }, options)).toMatchObject({ error: expect.stringContaining('older season') })
      await db.update(matches).set({ status: 'completed' }).where(eq(matches.id, 'rated'))
      expect(await cancelMatchByModerator(db, kv, { matchId: 'rated', cancelledAt: now }, options)).toHaveProperty('error')
      expect(await db.select().from(playerRatings)).toEqual(ratings)
      expect(await db.select().from(seasonRatingStates)).toEqual(states)
      expect(await db.select().from(playerRatingEvents)).toEqual(events)
    }
    finally { sqlite.close() }
  })
  test('completed late-season retries repair missing statistics once without changing results, ratings or the reporter', async () => {
    const { db, sqlite, addMatch } = await setup()
    try {
      const current = await addMatch('current', 1100)
      await runAtomicSeasonBatch(db, (await prepareSeasonReport(db, { ...current, acceptedAt: 1200, now: 1200, opponentTierByPlayerId: new Map() })).queries)
      await db.insert(seasons).values({ id: 's8', seasonNumber: 8, name: 'Season 8', startsAt: 0, endsAt: 1000, reportingDeadline: 2000, isolatedRatingsEnabled: true })
      const old = await addMatch('old', 500, 's8')
      await db.update(matchParticipants).set({ civId: 'rome-trajan' }).where(eq(matchParticipants.matchId, old.match.id))
      old.participants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, old.match.id))
      await runAtomicSeasonBatch(db, (await prepareSeasonReport(db, { ...old, acceptedAt: 1900, now: 1900, opponentTierByPlayerId: new Map() })).queries)
      await db.update(matches).set({ status: 'completed', completedAt: 1900, draftData: JSON.stringify({ completedAt: 501, reportedById: 'p' }) }).where(eq(matches.id, old.match.id))
      await db.update(seasons).set({ finalizedAt: 2100 }).where(eq(seasons.id, 's8'))
      const ratingRows = await db.select().from(playerRatings)
      const states = await db.select().from(seasonRatingStates)
      const events = await db.select().from(playerRatingEvents)
      const [saved] = await db.select().from(matches).where(eq(matches.id, old.match.id))
      const kv = createTestKv()
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await reportMatch(db, kv, { matchId: old.match.id, reporterId: 'q', placements: 'q' })
        expect(result).toMatchObject({ idempotent: true, historicalSeason: true, match: saved })
        const statistics = await db.select().from(playerCivStats)
        expect(statistics.map(row => [row.playerId, row.picks, row.wins]).sort()).toEqual([['p', 1, 1], ['q', 1, 0]])
        expect(await db.select().from(matchPlayerCivStatContributions)).toHaveLength(1)
      }
      expect(await db.select().from(playerRatings)).toEqual(ratingRows)
      expect(await db.select().from(seasonRatingStates)).toEqual(states)
      expect(await db.select().from(playerRatingEvents)).toEqual(events)
    }
    finally { sqlite.close() }
  })
  test('decay is recorded once, leaves opponents unchanged, and correction replay restores the right reserve', async () => {
    const fixtures = await Promise.all([setup(), setup()])
    const day = 86_400_000
    try {
      for (const [index, { db, addMatch }] of fixtures.entries()) {
        await db.update(publicRatingDecayPolicies).set({ enabledAt: index === 0 ? 1000 : 1000 + 1000 * day })
        for (const mode of ['duel', 'global']) for (const playerId of ['p', 'q']) {
          const rating = playerId === 'p' ? 1600 : 1300
          const mu = playerId === 'p' ? 40 : 30
          const evidence = { gamesPlayed: 40, wins: 20, importedGames: 0, effectiveGames: 40, winsVsTier1: 3, winsVsTier2Plus: 6, effectiveWinsVsTier1: 3, effectiveWinsVsTier2Plus: 6 }
          await db.insert(publicRatingSeeds).values({ seasonId: 's9', playerId, mode, rating, hiddenMu: mu, hiddenSigma: 3, sourceMu: mu, sourceSigma: 3, sourceHiddenScore: mu - 2.25, effectiveAt: 1000, formulaVersion: PUBLIC_RATING_FORMULA_VERSION, calibrationVersion: `test-${mode}`, seedVersion: 'test', evidence })
          await db.insert(seasonRatingStates).values({ seasonId: 's9', playerId, mode, mu, sigma: 3, publicRating: rating, evidence, updatedAt: 1000 })
          await db.insert(playerRatings).values({ playerId, mode, mu, sigma: 3, publicRating: rating, ...evidence, updatedAt: 1000 })
        }
        const match = await addMatch('return', 1000 + 79 * day)
        const options = { ...match, acceptedAt: 1000 + 80 * day, now: 1000 + 80 * day, opponentTierByPlayerId: new Map([['p', 'tier1'], ['q', 'tier2']]) }
        await runAtomicSeasonBatch(db, (await prepareSeasonReport(db, options)).queries)
        await db.update(matches).set({ status: 'completed', completedAt: options.acceptedAt }).where(eq(matches.id, 'return'))
        const saved = await db.select().from(playerRatingEvents)
        await runAtomicSeasonBatch(db, (await prepareSeasonReport(db, options)).queries)
        expect(await db.select().from(playerRatingEvents)).toEqual(saved)
        await expect(prepareSeasonReplay(db, 's9')).resolves.toBeDefined()
      }
      const [decayed, normal] = await Promise.all(fixtures.map(({ db }) => db.select().from(playerRatingEvents)))
      expect(decayed.filter(row => row.playerId === 'p').every(row => row.publicDecayDelta === -40 && row.publicRatingBefore === 1560)).toBe(true)
      for (const event of decayed.filter(row => row.playerId === 'q')) {
        const other = normal.find(row => row.playerId === event.playerId && row.mode === event.mode)!
        expect(event.publicRatingAfter).toBe(other.publicRatingAfter)
        expect(event.ratingAfterMu).toBe(other.ratingAfterMu)
        expect(event.ratingAfterSigma).toBe(other.ratingAfterSigma)
      }
      const { db, addMatch } = fixtures[0]!
      const next = await addMatch('return2', 1000 + 99 * day)
      await runAtomicSeasonBatch(db, (await prepareSeasonReport(db, { ...next, acceptedAt: 1000 + 100 * day, now: 1000 + 100 * day, opponentTierByPlayerId: new Map() })).queries)
      await db.update(matches).set({ status: 'completed' }).where(eq(matches.id, 'return2'))
      expect(await prepareSeasonReplay(db, 's9', { matchId: 'return2' }, 1000 + 101 * day)).toBeDefined()
      await runAtomicSeasonBatch(db, (await prepareSeasonReplay(db, 's9', { matchId: 'return', cancel: true }, 1000 + 101 * day)).queries)
      const remaining = await db.select().from(playerRatingEvents).where(eq(playerRatingEvents.playerId, 'p'))
      expect(remaining.every(row => row.publicDecayDelta === -80 && row.publicDecayAfter?.bankUntil === 1000 + 114 * day)).toBe(true)
      await expect(prepareSeasonReplay(db, 's9')).resolves.toBeDefined()
    }
    finally { for (const fixture of fixtures) fixture.sqlite.close() }
  })
  test('division grace survives retries and replay, expires next game, and returns when that game is cancelled', async () => {
    const { db, sqlite, addMatch } = await setup()
    try {
      let held: number | null = null
      for (let index = 0; index < 8; index++) {
        const input = await addMatch(`badge-${index}`, 1100 + index)
        const options = { ...input, acceptedAt: 1200 + index, now: 1200 + index, opponentTierByPlayerId: new Map() }
        await runAtomicSeasonBatch(db, (await prepareSeasonReport(db, options)).queries)
        await db.update(matches).set({ status: 'completed', completedAt: 1200 + index }).where(eq(matches.id, input.match.id))
        const rows = await db.select().from(playerRatings).where(eq(playerRatings.playerId, 'q'))
        held = rows.find(row => row.mode === 'duel')!.publicBadge
        if (held != null) {
          await runAtomicSeasonBatch(db, (await prepareSeasonReport(db, options)).queries)
          expect(await db.select().from(playerRatings).where(eq(playerRatings.playerId, 'q'))).toEqual(rows)
          break
        }
      }
      expect(held).not.toBeNull()
      await expect(prepareSeasonReplay(db, 's9')).resolves.toBeDefined()
      const next = await addMatch('badge-next', 1150)
      await runAtomicSeasonBatch(db, (await prepareSeasonReport(db, { ...next, acceptedAt: 1300, now: 1300, opponentTierByPlayerId: new Map() })).queries)
      await db.update(matches).set({ status: 'completed', completedAt: 1300 }).where(eq(matches.id, next.match.id))
      expect((await db.select().from(playerRatings).where(eq(playerRatings.playerId, 'q'))).every(row => row.publicBadge == null)).toBe(true)
      await runAtomicSeasonBatch(db, (await prepareSeasonReplay(db, 's9', { matchId: next.match.id, cancel: true })).queries)
      expect((await db.select().from(playerRatings).where(eq(playerRatings.playerId, 'q'))).find(row => row.mode === 'duel')!.publicBadge).toBe(held)
    }
    finally { sqlite.close() }
  })
  test('substitution creates only missing newcomer seeds and restores the removed player without changing opponents opening state', async () => {
    const { db, sqlite, addMatch } = await setup()
    try {
      const match = await addMatch('sub', 1100)
      await runAtomicSeasonBatch(db, (await prepareSeasonReport(db, { ...match, acceptedAt: 1300, now: 1300, opponentTierByPlayerId: new Map() })).queries)
      await db.update(matches).set({ status: 'completed', completedAt: 1300 }).where(eq(matches.id, 'sub'))
      const seeds = await db.select().from(publicRatingSeeds)
      await db.insert(players).values({ id: 'newcomer', displayName: 'Newcomer', createdAt: 0 })
      const participants = match.participants.map(row => ({ ...row, playerId: row.playerId === 'p' ? 'newcomer' : row.playerId }))
      await runAtomicSeasonBatch(db, (await prepareSeasonReplay(db, 's9', { matchId: 'sub', participants }, 1400)).queries)
      expect((await db.select().from(playerRatings).where(eq(playerRatings.playerId, 'p'))).every(row => row.gamesPlayed === 0 && row.publicRating === 750)).toBe(true)
      expect((await db.select().from(playerRatingEvents)).every(event => event.playerId !== 'p')).toBe(true)
      expect((await db.select().from(publicRatingSeeds)).filter(seed => seed.playerId !== 'newcomer')).toEqual(seeds)
      expect(await db.select().from(publicRatingSeeds)).toHaveLength(6)
      await expect(prepareSeasonReplay(db, 's9')).resolves.toBeDefined()
    }
    finally { sqlite.close() }
  })
  test.each([
    { mode: '2v2', scope: 'duo', count: 4, permanentAlly: false },
    { mode: '4v4', scope: 'squad', count: 8, permanentAlly: false },
    { mode: 'ffa', scope: 'ffa', count: 12, permanentAlly: false },
    { mode: 'ffa', scope: 'ffa', count: 12, permanentAlly: true },
  ])('live/imported $mode (paired: $permanentAlly) reproduces both scopes and stays inside atomic limits', async ({ mode, scope, count, permanentAlly }) => {
    const { db, sqlite } = await setup()
    try {
      await db.update(seasons).set({ publicReadsEnabled: true }).where(eq(seasons.id, 's9'))
      await db.insert(divisionRankPolicies).values({ guildId: 'guild', seasonId: 's9', version: ONE_DIVISION_RANK_POLICY_VERSION, phase: 'active', updatedAt: 1000,
        configJson: JSON.stringify({ preparation: { unrankedRoleId: 'unranked', roleIdsByMinimum: Object.fromEntries(PUBLIC_RATING_BANDS.map(b => [b.minimum, `role-${b.minimum}`])) } }) })
      const calibration = calibratePublicRatings({ scope, version: `test-${scope}`, sourceDigest: 'fixture', qualifiedHiddenScores: Array.from({ length: 101 }, (_, index) => index) })
      await db.insert(publicRatingCalibrations).values({ ...calibration, calibration, createdAt: 1000 })
      await db.insert(seasonRatingConfigurations).values({ seasonId: 's9', mode: scope, formulaVersion: PUBLIC_RATING_FORMULA_VERSION, calibrationVersion: calibration.version })
      const ids = Array.from({ length: count }, (_, index) => `player-${index}`)
      await db.insert(players).values(ids.map(id => ({ id, displayName: id, createdAt: 0 })))
      for (const [index, isOld] of [false, true].entries()) {
        const id = `format-${index}`
        await db.insert(matches).values({ id, gameMode: mode, seasonId: 's9', status: 'active', isOld, createdAt: 1200 - index,
          draftData: JSON.stringify({ completedAt: 1250, permanentAlly }) })
        await db.insert(matchParticipants).values(ids.map((playerId, seat) => ({ matchId: id, playerId,
          team: mode === 'ffa' ? null : Math.floor(seat / (count / 2)),
          placement: mode === 'ffa' ? Math.floor(seat / (permanentAlly ? 2 : 1)) + 1 : Math.floor(seat / (count / 2)) + 1,
        })))
        const [match] = await db.select().from(matches).where(eq(matches.id, id))
        const participants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, id))
        await runAtomicSeasonBatch(db, (await prepareSeasonReport(db, { match: match!, participants, acceptedAt: 1300 + index, now: 1300 + index, opponentTierByPlayerId: new Map() })).queries)
        await db.update(matches).set({ status: 'completed', completedAt: 1300 + index }).where(eq(matches.id, id))
      }
      const original = await db.select().from(playerRatings)
      expect(original).toHaveLength(count * 2)
      expect(original.every(row => row.effectiveGames === 1.5 && row.gamesPlayed === 2 && row.lastPlayedAt === 1300)).toBe(true)
      await runAtomicSeasonBatch(db, (await prepareSeasonReplay(db, 's9')).queries)
      expect(await db.select().from(playerRatings)).toEqual(original)
      expect(await db.select().from(divisionRankStates)).toHaveLength(count)
    }
    finally { sqlite.close() }
  })
  test('moderator retries preserve committed placements, and pending lifecycle cancellation cannot leave rated cancelled matches', async () => {
    const { db, sqlite, addMatch } = await setup()
    try {
      const pending = await addMatch('pending', 1100)
      await runAtomicSeasonBatch(db, (await prepareSeasonReport(db, { ...pending, acceptedAt: 1200, now: 1200, opponentTierByPlayerId: new Map() })).queries)
      const events = await db.select().from(playerRatingEvents)
      const options = { allowDirectTerminalWriteForTests: true }
      const kv = createTestKv()
      expect(await cancelMatchByModerator(db, kv, { matchId: 'pending', cancelledAt: 1400 }, options)).toMatchObject({ error: expect.stringContaining('Finish the saved report') })
      const retry = await resolveMatchByModerator(db, kv, { matchId: 'pending', placements: 'q', resolvedAt: 1500 }, options)
      expect(retry).toMatchObject({ match: { status: 'completed' } })
      expect((await db.select().from(matchParticipants).where(eq(matchParticipants.playerId, 'p')))[0]!.placement).toBe(1)
      expect(await db.select().from(playerRatingEvents)).toEqual(events)
      const correction = await resolveMatchByModerator(db, kv, { matchId: 'pending', placements: 'q', resolvedAt: 1600 }, options)
      expect('error' in correction).toBe(false)
      expect((await db.select().from(matchParticipants).where(eq(matchParticipants.playerId, 'p')))[0]!.placement).toBe(2)
      expect(await cancelMatchByModerator(db, kv, { matchId: 'pending', cancelledAt: 1700 }, options)).toMatchObject({ match: { status: 'cancelled' } })
      expect(await cancelMatchByModerator(db, kv, { matchId: 'pending', cancelledAt: 1800 }, options)).toMatchObject({ match: { status: 'cancelled' } })
      expect(await db.select().from(playerRatingEvents)).toHaveLength(0)
    }
    finally { sqlite.close() }
  })

  test('replay restores returning players to frozen opening activity and rejects evidence-only stale writes', async () => {
    const { db, sqlite, addMatch } = await setup()
    try {
      const evidence = { gamesPlayed: 20, wins: 10, effectiveGames: 20, importedGames: 0, winsVsTier1: 0, winsVsTier2Plus: 0, effectiveWinsVsTier1: 0, effectiveWinsVsTier2Plus: 0 }
      for (const mode of ['duel', 'global']) {
        await db.insert(publicRatingSeeds).values({ seasonId: 's9', playerId: 'p', mode, rating: 850, hiddenMu: 40, hiddenSigma: 6,
          sourceMu: 40, sourceSigma: 3, sourceHiddenScore: 37.75, effectiveAt: 1000, lastPlayedAt: 500,
          formulaVersion: PUBLIC_RATING_FORMULA_VERSION, calibrationVersion: `test-${mode}`, seedVersion: 's9-compression-v1', evidence })
        await db.insert(seasonRatingStates).values({ seasonId: 's9', playerId: 'p', mode, mu: 40, sigma: 6, publicRating: 850,
          evidence, lastPlayedAt: 500, updatedAt: 1000 })
        await db.insert(playerRatings).values({ playerId: 'p', mode, mu: 40, sigma: 6, publicRating: 850, ...evidence, lastPlayedAt: 500, updatedAt: 1000 })
      }
      const match = await addMatch('return', 1100)
      const prepare = () => prepareSeasonReport(db, { ...match, acceptedAt: 1300, now: 1300, opponentTierByPlayerId: new Map() })
      const stale = await prepare()
      await db.update(playerRatings).set({ wins: 11 }).where(eq(playerRatings.playerId, 'p'))
      await expect(runAtomicSeasonBatch(db, stale.queries)).rejects.toThrow()
      expect(await db.select().from(seasonMatchReports)).toHaveLength(0)
      await db.update(playerRatings).set({ wins: 10 }).where(eq(playerRatings.playerId, 'p'))
      await runAtomicSeasonBatch(db, (await prepare()).queries)
      await db.update(matches).set({ status: 'completed', completedAt: 1300 }).where(eq(matches.id, 'return'))
      await runAtomicSeasonBatch(db, (await prepareSeasonReplay(db, 's9', { matchId: 'return', cancel: true }, 1400)).queries)
      const rows = await db.select().from(playerRatings).where(eq(playerRatings.playerId, 'p'))
      expect(rows.every(row => row.lastPlayedAt === 500 && row.gamesPlayed === 20 && row.mu === 40 && row.publicRating === 850)).toBe(true)
      await expect(prepareSeasonReplay(db, 's9')).resolves.toBeDefined()
    }
    finally { sqlite.close() }
  })
  test('seeded replay reproduces out-of-start-order reports and supports corrections and cancellations without replacing seeds', async () => {
    const { db, sqlite, addMatch } = await setup()
    try {
      const one = await addMatch('one', 1200)
      const two = await addMatch('two', 1100)
      for (const [index, input] of [one, two].entries()) {
        await runAtomicSeasonBatch(db, (await prepareSeasonReport(db, { ...input, acceptedAt: 1500 + index, now: 1500 + index, opponentTierByPlayerId: new Map([['q', 'tier1']]) })).queries)
        await db.update(matches).set({ status: 'completed', completedAt: 1500 + index }).where(eq(matches.id, input.match.id))
      }
      const original = await db.select().from(playerRatings)
      const seeds = await db.select().from(publicRatingSeeds)
      await runAtomicSeasonBatch(db, (await prepareSeasonReplay(db, 's9', undefined, 1700)).queries)
      expect(await db.select().from(playerRatings)).toEqual(original)
      await runAtomicSeasonBatch(db, (await prepareSeasonReplay(db, 's9', { matchId: 'one', participants: one.participants.map(row => ({ ...row, placement: row.placement === 1 ? 2 : 1 })) }, 1800)).queries)
      expect(await db.select().from(playerRatings)).not.toEqual(original)
      await expect(prepareSeasonReplay(db, 's9')).resolves.toBeDefined()
      await runAtomicSeasonBatch(db, (await prepareSeasonReplay(db, 's9', { matchId: 'two', cancel: true }, 1900)).queries)
      expect((await db.select().from(playerRatingEvents)).every(event => event.matchId === 'one')).toBe(true)
      expect((await db.select().from(seasonRatingStates)).every(state => state.seasonGames === 1)).toBe(true)
      await expect(prepareSeasonReplay(db, 's9')).resolves.toBeDefined()
      expect(await db.select().from(publicRatingSeeds)).toEqual(seeds)
      const three = await addMatch('three', 1300)
      const stale = await prepareSeasonReplay(db, 's9')
      await runAtomicSeasonBatch(db, (await prepareSeasonReport(db, { ...three, acceptedAt: 2000, now: 2000, opponentTierByPlayerId: new Map() })).queries)
      const fresh = await db.select().from(playerRatings)
      await expect(runAtomicSeasonBatch(db, stale.queries)).rejects.toThrow()
      expect(await db.select().from(playerRatings)).toEqual(fresh)
      await db.update(seasons).set({ active: false, endsAt: 2500 }).where(eq(seasons.id, 's9'))
      await expect(prepareSeasonReplay(db, 's9')).rejects.toThrow('active public season')
    }
    finally { sqlite.close() }
  })
  test('normal reports append in acceptance order, agree with both summaries, and retry without changing seeds', async () => {
    const { db, sqlite, addMatch } = await setup()
    try {
      const first = await addMatch('first', 1200)
      const earlierStart = await addMatch('earlier-start', 1100, 's9', true)
      const a = await prepareSeasonReport(db, { ...first, acceptedAt: 1500, now: 1500, opponentTierByPlayerId: new Map() })
      await runAtomicSeasonBatch(db, a.queries)
      const seeds = await db.select().from(publicRatingSeeds)
      expect(seeds).toHaveLength(4)
      expect(seeds.every(seed => seed.rating === 750)).toBe(true)
      const b = await prepareSeasonReport(db, { ...earlierStart, acceptedAt: 1600, now: 1600, opponentTierByPlayerId: new Map() })
      await runAtomicSeasonBatch(db, b.queries)
      const reports = await db.select().from(seasonMatchReports).orderBy(seasonMatchReports.sequence)
      expect(reports.map(row => row.matchId)).toEqual(['first', 'earlier-start'])
      const events = await db.select().from(playerRatingEvents).where(eq(playerRatingEvents.matchId, 'earlier-start'))
      const live = await db.select().from(playerRatings)
      const states = await db.select().from(seasonRatingStates)
      for (const event of events) {
        const row = live.find(row => row.playerId === event.playerId && row.mode === event.mode)!
        const state = states.find(row => row.playerId === event.playerId && row.mode === event.mode)!
        expect(row).toMatchObject({ mu: event.ratingAfterMu, sigma: event.ratingAfterSigma, publicRating: event.publicRatingAfter, effectiveGames: 1.5, gamesPlayed: 2 })
        expect(state).toMatchObject({ mu: row.mu, sigma: row.sigma, publicRating: row.publicRating, revision: 2, seasonGames: 2 })
        expect(event.publicSequence).toBe(reports[1]!.sequence)
      }
      const retry = await prepareSeasonReport(db, { ...first, acceptedAt: 1700, now: 1700, opponentTierByPlayerId: new Map() })
      expect(retry).toMatchObject({ idempotent: true, queries: [], acceptedAt: 1500 })
      expect(await db.select().from(publicRatingSeeds)).toEqual(seeds)
      expect(await db.select().from(playerRatings)).toEqual(live)
      const delayed = await addMatch('earlier-acceptance', 1300)
      await runAtomicSeasonBatch(db, (await prepareSeasonReport(db, { ...delayed, acceptedAt: 1400, now: 1800, opponentTierByPlayerId: new Map() })).queries)
      expect((await db.select().from(playerRatings)).every(row => row.lastPlayedAt === 1500)).toBe(true)
      expect((await db.select().from(seasonMatchReports).orderBy(seasonMatchReports.sequence)).at(-1)!.matchId).toBe('earlier-acceptance')
    }
    finally { sqlite.close() }
  })

  test('a concurrent stale preparation rolls back every scope, event, seed, and report order allocation', async () => {
    const { db, sqlite, addMatch } = await setup()
    try {
      const first = await addMatch('first', 1100)
      const second = await addMatch('second', 1200)
      const prepare = (match: typeof first) => prepareSeasonReport(db, { ...match, acceptedAt: 1500, now: 1500, opponentTierByPlayerId: new Map() })
      const a = await prepare(first)
      const stale = await prepare(second)
      await runAtomicSeasonBatch(db, a.queries)
      const state = await db.select().from(seasonRatingStates)
      const summaries = await db.select().from(playerRatings)
      await expect(runAtomicSeasonBatch(db, stale.queries)).rejects.toThrow()
      expect(await db.select().from(seasonRatingStates)).toEqual(state)
      expect(await db.select().from(playerRatings)).toEqual(summaries)
      expect(await db.select().from(seasonMatchReports)).toHaveLength(1)
      expect(await db.select().from(publicRatingSeeds)).toHaveLength(4)
      expect(await db.select().from(playerRatingEvents)).toHaveLength(4)
      await runAtomicSeasonBatch(db, (await prepare(second)).queries)
      expect(await db.select().from(seasonMatchReports)).toHaveLength(2)
    }
    finally { sqlite.close() }
  })

  test('late S8 acceptance can cross its deadline but never writes live S9 ratings or seeds', async () => {
    const { db, sqlite, addMatch } = await setup()
    try {
      const current = await addMatch('new', 1100)
      await runAtomicSeasonBatch(db, (await prepareSeasonReport(db, { ...current, acceptedAt: 1200, now: 1200, opponentTierByPlayerId: new Map() })).queries)
      const live = await db.select().from(playerRatings)
      const seeds = await db.select().from(publicRatingSeeds)
      const s9 = await db.select().from(seasonRatingStates)
      await db.insert(seasons).values({ id: 's8', seasonNumber: 8, name: 'Season 8', startsAt: 0, endsAt: 1000, reportingDeadline: 2000, isolatedRatingsEnabled: true })
      const late = await addMatch('old', 500, 's8')
      await runAtomicSeasonBatch(db, (await prepareSeasonReport(db, { ...late, acceptedAt: 1999, now: 2001, opponentTierByPlayerId: new Map([['q', 'tier1']]) })).queries)
      expect(await db.select().from(playerRatings)).toEqual(live)
      expect(await db.select().from(publicRatingSeeds)).toEqual(seeds)
      expect(await db.select().from(seasonRatingStates).where(eq(seasonRatingStates.seasonId, 's9'))).toEqual(s9)
      const events = await db.select().from(playerRatingEvents).where(eq(playerRatingEvents.matchId, 'old'))
      expect(events.every(event => event.publicRatingAfter == null && event.seasonId === 's8' && event.winsVsTier1Delta === 0)).toBe(true)
      const tooLate = await addMatch('too-late', 600, 's8')
      await expect(prepareSeasonReport(db, { ...tooLate, acceptedAt: 2000, now: 2000, opponentTierByPlayerId: new Map() })).rejects.toThrow('older season')
      await db.update(seasons).set({ finalizedAt: 2100 }).where(eq(seasons.id, 's8'))
      expect((await prepareSeasonReport(db, { ...late, acceptedAt: 2200, now: 2200, opponentTierByPlayerId: new Map() })).idempotent).toBe(true)
    }
    finally { sqlite.close() }
  })

  test('the report service finishes a committed rating batch after a lifecycle interruption without replaying it', async () => {
    const { db, sqlite, addMatch } = await setup()
    try {
      const match = await addMatch('pending-lifecycle', 1100)
      await runAtomicSeasonBatch(db, (await prepareSeasonReport(db, { ...match, acceptedAt: 1300, now: 1300, opponentTierByPlayerId: new Map() })).queries)
      const events = await db.select().from(playerRatingEvents)
      const result = await reportMatch(db, createTestKv(), { matchId: match.match.id, reporterId: 'p', placements: 'q' }, { allowDirectTerminalWriteForTests: true })
      expect(result).toMatchObject({ idempotent: true, match: { status: 'completed', completedAt: 1300 } })
      expect(await db.select().from(playerRatingEvents)).toEqual(events)
      expect((await db.select().from(matchParticipants).where(eq(matchParticipants.playerId, 'p')))[0]!.placement).toBe(1)
      const fresh = await addMatch('normal-report', 1500)
      const next = await reportMatch(db, createTestKv(), { matchId: fresh.match.id, reporterId: 'p', placements: 'p' }, { allowDirectTerminalWriteForTests: true })
      expect('error' in next).toBe(false)
      expect(await db.select().from(seasonMatchReports)).toHaveLength(2)
    }
    finally { sqlite.close() }
  })
})
