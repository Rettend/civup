import type { Database } from '@civup/db'
import { matches, matchParticipants, matchPlayerCivStatContributions, playerCivStats, playerRatingEvents, playerRatings, players, publicRatingCalibrations, publicRatingDecayPolicies, publicRatingSeeds, seasonMatchReports, seasonRatingConfigurations, seasonRatingStates, seasons } from '@civup/db'
import { calibratePublicRatings, PUBLIC_RATING_FORMULA_VERSION } from '@civup/rating'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { prepareSeasonReport, runAtomicSeasonBatch } from '../../src/services/season/report.ts'
import { reportMatch } from '../../src/services/match/report.ts'
import { prepareSeasonReplay } from '../../src/services/season/replay.ts'
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
  test('unreported S8 games can be scrapped within the window without changing either season ratings; saved reports stay protected', async () => {
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
      expect(await cancelMatchByModerator(db, kv, { matchId: 'scrap', cancelledAt: now }, options)).toMatchObject({ match: { status: 'cancelled', seasonId: 's8' }, recalculatedMatchIds: [] })
      expect(await cancelMatchByModerator(db, kv, { matchId: 'rated', cancelledAt: now }, options)).toMatchObject({ error: 'Finish the saved report before cancelling its ratings.' })
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
      expect(await prepareSeasonReplay(db, 's9', { matchId: 'return2' })).toBeDefined()
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
      await expect(prepareSeasonReport(db, { ...tooLate, acceptedAt: 2000, now: 2000, opponentTierByPlayerId: new Map() })).rejects.toThrow('closed')
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
