import type { Database } from '@civup/db'
import { matches, matchParticipants, playerCivStats, playerRatingEvents, playerRatings, players, publicRatingCalibrations, publicRatingSeeds, seasonRatingStates, seasons } from '@civup/db'
import { calibratePublicRatings, PUBLIC_RATING_FORMULA_VERSION } from '@civup/rating'
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { cancelMatchByModerator, correctMatchLeadersByModerator, resolveMatchByModerator, substituteMatchPlayerByModerator } from '../../src/services/match/moderation.ts'
import { reportMatch } from '../../src/services/match/report.ts'
import { buildRankGraphImageData, renderRankGraphSvg } from '../../src/services/player/rank-graph.ts'
import { advanceSeasonRatingState, prepareSeasonOpening } from '../../src/services/season/opening.ts'
import { seasonMutationError, SEASON_REPORTING_WINDOW_MS, MATCH_CORRECTION_WINDOW_MS } from '../../src/services/season/policy.ts'
import { parseSeasonSelection, resolveSeasonSelection } from '../../src/services/season/selection.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'
import { endSeason, startSeason } from '../../src/services/season/index.ts'
import { loadSelectedSeasonRatings } from '../../src/services/season/ratings.ts'
import { listTopPlayerCivRankings } from '../../src/services/leaderboard/player-civ-stats.ts'

const calibration = calibratePublicRatings({ version: 'global-test-v1', scope: 'global', sourceDigest: 'fixture', qualifiedHiddenScores: Array.from({ length: 101 }, (_, index) => index) })
const cutoff = 1000
const oldSeason = { id: 's8', name: 'Season 8', startsAt: 0, endsAt: cutoff, active: false, reportingDeadline: cutoff + SEASON_REPORTING_WINDOW_MS, finalizedAt: null }

describe('RP season isolation', () => {
  let clock: ReturnType<typeof spyOn>
  beforeEach(() => { clock = spyOn(Date, 'now').mockReturnValue(3000) })
  afterEach(() => { clock.mockRestore() })
  test('current-season corrections allow exactly 30 days, but not older matches', () => {
    const season = { ...oldSeason, active: true, endsAt: null }
    const match = { seasonId: 's8', createdAt: 500, status: 'completed' }
    expect(seasonMutationError(season, match, 'correction', 500 + MATCH_CORRECTION_WINDOW_MS)).toBeNull()
    expect(seasonMutationError(season, match, 'correction', 501 + MATCH_CORRECTION_WINDOW_MS)).toContain('older than 30 days')
  })
  test('first reports and unreported cancellations fit the exact reporting window, not corrections', () => {
    const match = { seasonId: 's8', createdAt: 500, status: 'active' }
    expect(seasonMutationError(oldSeason, match, 'first-report', cutoff + 1)).toBeNull()
    expect(seasonMutationError(oldSeason, match, 'first-report', oldSeason.reportingDeadline)).toContain('older season')
    expect(seasonMutationError(oldSeason, match, 'first-report', oldSeason.reportingDeadline + 1, cutoff + 1)).toBeNull()
    expect(seasonMutationError(oldSeason, match, 'correction', cutoff + 1)).toContain('older season')
    expect(seasonMutationError(oldSeason, { ...match, status: 'completed' }, 'first-report', cutoff + 1)).toContain('older season')
    expect(seasonMutationError(oldSeason, { ...match, createdAt: cutoff }, 'first-report', cutoff + 1)).toContain('wrong season')
    expect(seasonMutationError({ ...oldSeason, finalizedAt: cutoff + 2 }, match, 'first-report', cutoff + 3, cutoff + 1)).toContain('older season')
    expect(seasonMutationError(oldSeason, match, 'first-report', cutoff + 1, cutoff + 2)).toContain('older season')
    expect(seasonMutationError(oldSeason, match, 'unreported-cancellation', cutoff + 1)).toBeNull()
    expect(seasonMutationError(oldSeason, match, 'unreported-cancellation', oldSeason.reportingDeadline, cutoff + 1)).toContain('older season')
    expect(seasonMutationError(oldSeason, { ...match, status: 'completed' }, 'unreported-cancellation', cutoff + 1)).toContain('older season')
    expect(seasonMutationError({ ...oldSeason, finalizedAt: cutoff + 2 }, match, 'unreported-cancellation', cutoff + 3)).toContain('older season')
  })

  test('opening seeds freeze both ratings and evidence while late reports update S8 only', () => {
    const players = [95, 100].map((hiddenScore, index) => ({
      playerId: `p${index}`, mode: 'global', mu: 40 + index, sigma: 3, hiddenScore,
      qualified: true, closingTier: 'tier1' as const,
      evidence: { gamesPlayed: 50, effectiveGames: 40, winsVsTier1: 3, winsVsTier2Plus: 15 },
      seasonGames: 20, seasonWins: 12, lastPlayedAt: 900,
    }))
    const input = { sourceSeasonId: 's8', seasonId: 's9', cutoff, resetFactor: 0.5, sourceDigest: 'fixture', calibrations: [calibration], players }
    const opening = prepareSeasonOpening(input)
    const savedSeeds = JSON.stringify(opening.seeds)
    const savedS9 = JSON.stringify(opening.openingStates)
    expect(opening.reportingDeadline).toBe(cutoff + SEASON_REPORTING_WINDOW_MS)
    expect(opening.seeds.map(seed => seed.rating)).toEqual([1400, 1449])
    expect(opening.openingStates[0]).toMatchObject({ mu: 40, seasonGames: 0, seasonWins: 0, evidence: players[0]!.evidence })
    expect(opening.openingStates[0]!.sigma).toBeGreaterThan(3)
    const late = advanceSeasonRatingState(opening.closingStates[0]!, {
      seasonId: 's8', mu: 41, sigma: 2.9, publicRating: null, win: true, imported: false,
      evidenceDelta: { effectiveGames: 1, winsVsTier1: 1 }, acceptedAt: 1100,
    })
    expect(late.seasonGames).toBe(21)
    expect(late.evidence.effectiveGames).toBe(41)
    expect(JSON.stringify(opening.seeds)).toBe(savedSeeds)
    expect(JSON.stringify(opening.openingStates)).toBe(savedS9)
    expect(opening.closingStates[0]!.evidence.effectiveGames).toBe(40)
    expect(() => advanceSeasonRatingState(opening.openingStates[0]!, { ...late, seasonId: 's8', win: true, imported: false, evidenceDelta: {}, acceptedAt: 1100 })).toThrow('another season')
    expect(() => prepareSeasonOpening({ ...input, players: [...players, players[0]!] })).toThrow('duplicate')
    expect(() => prepareSeasonOpening({ ...input, sourceDigest: 'different' })).toThrow('one snapshot')
  })

  test('migration preserves legacy history and makes opening seeds immutable', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      await db.insert(players).values({ id: 'p', displayName: 'Player', createdAt: 0 })
      await db.insert(seasons).values({ id: 's9', seasonNumber: 9, name: 'Season 9', startsAt: cutoff, ratingSystem: 'rp', active: true })
      await db.insert(publicRatingCalibrations).values({ ...calibration, calibration, createdAt: cutoff })
      await db.insert(publicRatingSeeds).values({
        seasonId: 's9', playerId: 'p', mode: 'global', rating: 1400, hiddenMu: 40, hiddenSigma: 5,
        sourceMu: 40, sourceSigma: 3, sourceHiddenScore: 37.75,
        effectiveAt: cutoff, formulaVersion: PUBLIC_RATING_FORMULA_VERSION, calibrationVersion: calibration.version,
        seedVersion: 's9-compression-v1', evidence: { effectiveGames: 40 },
      })
      expect(() => sqlite.run('UPDATE public_rating_seeds SET rating = 750')).toThrow('immutable')
      expect(() => sqlite.run('DELETE FROM public_rating_seeds')).toThrow('immutable')
      expect(() => sqlite.run('UPDATE public_rating_calibrations SET source_digest = ?', ['new'])).toThrow('immutable')
      expect(sqlite.query("SELECT name FROM sqlite_master WHERE name LIKE 'scoped_%'").all()).toHaveLength(0)
      expect((await db.select().from(publicRatingSeeds))[0]!.rating).toBe(1400)
    }
    finally { sqlite.close() }
  })

  test('current graph starts from S9 seed, excludes S8, and refuses incomplete RP instead of a hidden fallback', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    try {
      await db.insert(players).values({ id: 'p', displayName: 'Player', createdAt: 0 })
      await db.insert(seasons).values([
        { ...oldSeason, seasonNumber: 8 },
        { id: 's9', seasonNumber: 9, name: 'Season 9', startsAt: cutoff, ratingSystem: 'rp', active: true, publicReadsEnabled: true },
      ])
      await db.insert(publicRatingCalibrations).values({ ...calibration, calibration, createdAt: cutoff })
      await db.insert(publicRatingSeeds).values({
        seasonId: 's9', playerId: 'p', mode: 'global', rating: 1425.25, hiddenMu: 40, hiddenSigma: 5,
        sourceMu: 40, sourceSigma: 3, sourceHiddenScore: 37.75,
        effectiveAt: cutoff, formulaVersion: PUBLIC_RATING_FORMULA_VERSION, calibrationVersion: calibration.version,
        seedVersion: 's9-compression-v1', evidence: { effectiveGames: 40 },
      })
      await db.insert(matches).values({ id: 'old', gameMode: '1v1', status: 'completed', seasonId: 's8', createdAt: 500 })
      const event = { matchId: 'old', playerId: 'p', mode: 'global', gameMode: '1v1', ratingBeforeMu: 39, ratingBeforeSigma: 3, ratingAfterMu: 40, ratingAfterSigma: 3, matchCreatedAt: 500 }
      await db.insert(playerRatingEvents).values(event)
      const current = await buildRankGraphImageData(db, kv, 'guild', 'p', { gameLimit: 20 })
      expect(current.player.points).toEqual([{ x: 0, rating: 1425 }])
      expect(current.seasonLabel).toBe('Season 9')
      expect(current.player.games).toBe(0)
      await refreshHistoricalStandings(db)
      const old = await buildRankGraphImageData(db, kv, 'guild', 'p', { gameLimit: 20, season: 8 })
      expect(old.ratingSystem).toBe('legacy')
      expect(old.player.games).toBe(1)
      expect(old.bands.every(band => !/ (III|II|I)$/.test(band.label))).toBe(true)
      const svg = await renderRankGraphSvg(current)
      expect(svg).toContain('Season 9')
      expect(svg).not.toContain('ELO')
      await db.insert(matches).values({ id: 'new', gameMode: '1v1', status: 'completed', seasonId: 's9', createdAt: 1500 })
      await db.insert(playerRatingEvents).values({ ...event, matchId: 'new', matchCreatedAt: 1500 })
      await expect(buildRankGraphImageData(db, kv, 'guild', 'p', { gameLimit: 20 })).rejects.toThrow('incomplete')
      await db.update(seasons).set({ publicReadsEnabled: false }).where(eq(seasons.id, 's9'))
      await expect(buildRankGraphImageData(db, kv, 'guild', 'p', { gameLimit: 20 })).rejects.toThrow('not ready')
    }
    finally { sqlite.close() }
  })

  test('shared moderator paths cannot change closed results and report retries do not repair them', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    try {
      await db.insert(players).values({ id: 'p', displayName: 'Player', createdAt: 0 })
      await db.insert(seasons).values({ ...oldSeason, seasonNumber: 8, finalizedAt: 2000 })
      await db.insert(matches).values({ id: 'old', gameMode: '1v1', status: 'completed', seasonId: 's8', createdAt: 500 })
      await db.insert(matchParticipants).values({ matchId: 'old', playerId: 'p', placement: 1 })
      const before = sqlite.query('SELECT * FROM match_participants').all()
      const cancel = await cancelMatchByModerator(db, kv, { matchId: 'old', cancelledAt: 1500 }, { allowDirectTerminalWriteForTests: true })
      const resolve = await resolveMatchByModerator(db, kv, { matchId: 'old', placements: ['p'], resolvedAt: 1500 }, { allowDirectTerminalWriteForTests: true })
      const leader = await correctMatchLeadersByModerator(db, { matchId: 'old', playerId: 'p', leaderId: 'new', correctedAt: 1500 })
      const sub = await substituteMatchPlayerByModerator(db, kv, { matchId: 'old', playerId: 'p', subPlayer: { playerId: 'other', displayName: 'Other' }, correctedAt: 1500 })
      for (const result of [cancel, resolve, leader, sub]) expect('error' in result && result.error.includes('older season')).toBe(true)
      const retry = await reportMatch(db, kv, { matchId: 'old', reporterId: 'p', placements: ['p'] })
      expect(retry).toMatchObject({ idempotent: true })
      expect(sqlite.query('SELECT * FROM match_participants').all()).toEqual(before)
      expect(await db.select().from(playerRatingEvents)).toHaveLength(0)
      expect(await db.select().from(seasonRatingStates)).toHaveLength(0)
    }
    finally { sqlite.close() }
  })

  test('all moderator correction paths reject current-season matches older than 30 days before changing data', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    try {
      clock.mockReturnValue(501 + MATCH_CORRECTION_WINDOW_MS)
      await db.insert(players).values({ id: 'p', displayName: 'Player', createdAt: 0 })
      await db.insert(seasons).values({ id: 's9', seasonNumber: 9, name: 'Season 9', startsAt: 0, active: true, ratingSystem: 'rp', isolatedRatingsEnabled: true })
      await db.insert(matches).values({ id: 'old', gameMode: '1v1', status: 'completed', seasonId: 's9', createdAt: 500 })
      await db.insert(matchParticipants).values({ matchId: 'old', playerId: 'p', placement: 1 })
      const before = await db.select().from(matchParticipants)
      const options = { allowDirectTerminalWriteForTests: true }
      const results = [
        await cancelMatchByModerator(db, kv, { matchId: 'old', cancelledAt: Date.now() }, options),
        await resolveMatchByModerator(db, kv, { matchId: 'old', placements: ['p'], resolvedAt: Date.now() }, options),
        await correctMatchLeadersByModerator(db, { matchId: 'old', playerId: 'p', leaderId: 'new', correctedAt: Date.now() }),
        await substituteMatchPlayerByModerator(db, kv, { matchId: 'old', playerId: 'p', subPlayer: { playerId: 'other', displayName: 'Other' }, correctedAt: Date.now() }),
      ]
      for (const result of results) expect(result).toMatchObject({ error: expect.stringContaining('older than 30 days') })
      expect(await db.select().from(matchParticipants)).toEqual(before)
      expect(await db.select().from(playerRatingEvents)).toHaveLength(0)
      expect((await db.select().from(matches))[0]!.status).toBe('completed')
    }
    finally { sqlite.close() }
  })

  test('season selection defaults to latest when no season is active and rejects invalid choices', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      await db.insert(seasons).values({ ...oldSeason, seasonNumber: 8 })
      expect((await resolveSeasonSelection(db, 'current')).season?.id).toBe('s8')
      expect(parseSeasonSelection('8')).toBe(8)
      expect(parseSeasonSelection('all')).toBe('all')
      expect(() => parseSeasonSelection('all', false)).toThrow()
      expect(() => parseSeasonSelection('8.5')).toThrow()
      await expect(resolveSeasonSelection(db, 9)).rejects.toThrow('not found')
    }
    finally { sqlite.close() }
  })

  test('cancellation validates global replay before writing the mode or changing lifecycle', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      await db.insert(players).values(['p', 'q'].map(id => ({ id, displayName: id, createdAt: 0 })))
      await db.insert(matches).values([
        { id: 'target', gameMode: '1v1', status: 'completed', createdAt: 100 },
        { id: 'broken-global', gameMode: '3v3', status: 'completed', createdAt: 200 },
      ])
      await db.insert(matchParticipants).values([
        { matchId: 'target', playerId: 'p', team: 0, placement: 1, ratingAfterMu: 26, ratingAfterSigma: 8 },
        { matchId: 'target', playerId: 'q', team: 1, placement: 2, ratingAfterMu: 24, ratingAfterSigma: 8 },
        { matchId: 'broken-global', playerId: 'p', team: 0, placement: null },
      ])
      await db.insert(playerRatings).values({ playerId: 'p', mode: 'duel', mu: 26, sigma: 8, gamesPlayed: 1 })
      const before = sqlite.query('SELECT * FROM match_participants ORDER BY match_id, player_id').all()
      const result = await cancelMatchByModerator(db, createTestKv(), { matchId: 'target', cancelledAt: 300 }, { allowDirectTerminalWriteForTests: true })
      expect('error' in result).toBe(true)
      expect((await db.select().from(matches).where(eq(matches.id, 'target')))[0]!.status).toBe('completed')
      expect((await db.select().from(playerRatings))[0]!.mu).toBe(26)
      expect(sqlite.query('SELECT * FROM match_participants ORDER BY match_id, player_id').all()).toEqual(before)
    }
    finally { sqlite.close() }
  })

  test('oversized online cancellation refuses before lifecycle writes', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      await db.insert(players).values(['p', 'q'].map(id => ({ id, displayName: id, createdAt: 0 })))
      for (let index = 0; index < 105; index++) {
        const id = `m${index}`
        await db.insert(matches).values({ id, gameMode: '1v1', status: 'completed', createdAt: index + 1 })
        await db.insert(matchParticipants).values([
          { matchId: id, playerId: 'p', team: 0, placement: 1 },
          { matchId: id, playerId: 'q', team: 1, placement: 2 },
        ])
      }
      const result = await cancelMatchByModerator(db, createTestKv(), { matchId: 'm0', cancelledAt: 300 }, { allowDirectTerminalWriteForTests: true })
      expect('error' in result && result.error.includes('local maintenance')).toBe(true)
      expect((await db.select().from(matches).where(eq(matches.id, 'm0')))[0]!.status).toBe('completed')
      expect(await db.select().from(playerRatingEvents)).toHaveLength(0)
    }
    finally { sqlite.close() }
  })

  test('closing snapshots keep historical ratings and leader rankings stable while the next season retains qualification', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      await startSeason(db, { seasonNumber: 8, now: 100, softReset: false })
      await db.insert(players).values({ id: 'p', displayName: 'Player', createdAt: 0 })
      await db.insert(playerRatings).values({ playerId: 'p', mode: 'global', mu: 40, sigma: 3, gamesPlayed: 60, wins: 30, effectiveGames: 50, winsVsTier1: 3, winsVsTier2Plus: 8 })
      await db.insert(matches).values({ id: 'old', seasonId: 'season-8', gameMode: '1v1', createdAt: 200, status: 'completed' })
      await db.insert(matchParticipants).values({ matchId: 'old', playerId: 'p', placement: 1 })
      await db.insert(playerRatingEvents).values({ matchId: 'old', playerId: 'p', mode: 'global', gameMode: '1v1', ratingBeforeMu: 39, ratingBeforeSigma: 3, ratingAfterMu: 40, ratingAfterSigma: 3, matchCreatedAt: 200, winsDelta: 1 })
      await db.insert(playerCivStats).values({ seasonId: 'season-8', gameMode: '1v1', playerId: 'p', civId: 'test-leader', picks: 10, wins: 6, updatedAt: 900 })
      await endSeason(db, { now: 1000 })
      const selected = await resolveSeasonSelection(db, 8)
      const closing = await loadSelectedSeasonRatings(db, selected, ['p'])
      const ranking = await listTopPlayerCivRankings(db, { seasonId: 'season-8' }, 'test-leader')
      expect(closing[0]).toMatchObject({ mu: 40, sigma: 3, gamesPlayed: 1, wins: 1, effectiveGames: 50, winsVsTier1: 3 })
      expect(ranking).toHaveLength(1)
      await startSeason(db, { seasonNumber: 9, now: 1001 })
      const current = await loadSelectedSeasonRatings(db, await resolveSeasonSelection(db, 'current'), ['p'])
      expect(current[0]).toMatchObject({ gamesPlayed: 0, wins: 0, effectiveGames: 50, winsVsTier1: 3, winsVsTier2Plus: 8 })
      expect(current[0]!.sigma).toBeGreaterThan(3)
      await db.update(playerRatings).set({ mu: 5, sigma: 2 })
      expect(await loadSelectedSeasonRatings(db, selected, ['p'])).toEqual(closing)
      expect(await listTopPlayerCivRankings(db, { seasonId: 'season-8' }, 'test-leader')).toEqual(ranking)
    }
    finally { sqlite.close() }
  })

  test('a failed cancellation batch cannot update only one scope and retry repairs its terminal projection', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      await db.insert(players).values(['p', 'q'].map(id => ({ id, displayName: id, createdAt: 0 })))
      await db.insert(matches).values({ id: 'target', gameMode: '1v1', status: 'completed', createdAt: 100 })
      await db.insert(matchParticipants).values(['p', 'q'].map((id, index) => ({ matchId: 'target', playerId: id, team: index, placement: index + 1 })))
      for (const mode of ['duel', 'global']) {
        await db.insert(playerRatings).values({ playerId: 'p', mode, mu: 26, sigma: 8, gamesPlayed: 1 })
        await db.insert(playerRatingEvents).values({ matchId: 'target', playerId: 'p', mode, gameMode: '1v1', ratingBeforeMu: 25, ratingBeforeSigma: 8.333, ratingAfterMu: 26, ratingAfterSigma: 8, matchCreatedAt: 100 })
      }
      const before = { ratings: await db.select().from(playerRatings), events: await db.select().from(playerRatingEvents), participants: await db.select().from(matchParticipants) }
      let injectFailure = true
      const atomicDb = new Proxy(db, {
        get(target, property) {
          if (property === 'batch') return async (queries: Array<{ run(): unknown }>) => sqlite.transaction(() => {
            for (const [index, query] of queries.entries()) {
              query.run()
              if (injectFailure && index === 2) throw new Error('Injected atomic failure')
            }
          })()
          const value = Reflect.get(target, property)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }) as Database
      await expect(cancelMatchByModerator(atomicDb, createTestKv(), { matchId: 'target', cancelledAt: 300 }, { allowDirectTerminalWriteForTests: true })).rejects.toThrow('Injected atomic failure')
      expect(await db.select().from(playerRatings)).toEqual(before.ratings)
      expect(await db.select().from(playerRatingEvents)).toEqual(before.events)
      expect(await db.select().from(matchParticipants)).toEqual(before.participants)
      // Lifecycle is outside the rating batch; retry must clean up the still-present events.
      expect((await db.select().from(matches))[0]!.status).toBe('cancelled')
      injectFailure = false
      const retry = await cancelMatchByModerator(atomicDb, createTestKv(), { matchId: 'target', cancelledAt: 300 }, { allowDirectTerminalWriteForTests: true })
      expect('error' in retry).toBe(false)
      expect(await db.select().from(playerRatingEvents)).toHaveLength(0)
      expect(await db.select().from(playerRatings)).toHaveLength(0)
    }
    finally { sqlite.close() }
  })
})
import { refreshHistoricalStandings } from '../../src/services/season/standings.ts'
