import { matches, playerRatingEvents, playerRatings, players, scopedPlayerRatingEvents, scopedPlayerRatings } from '@civup/db'
import { PUBLIC_RATING_START } from '@civup/rating'
import { describe, expect, test } from 'bun:test'
import { and, asc, eq } from 'drizzle-orm'
import { applyPublicRatingBackfillBatch, calculatePublicRatingBackfill, type PublicRatingBackfillEvent } from '../../scripts/public-rating-backfill-shared.ts'
import { createTestDatabase } from '../helpers/test-env.ts'

const PRIMARY_STATS_KEY = 'server:111111111111111111'
const OTHER_STATS_KEY = 'server:222222222222222222'

describe('public rating backfill', () => {
  test('replays complete chains from the public start instead of preserving temporary anchors', () => {
    const events: PublicRatingBackfillEvent[] = [
      backfillEvent('m1', 100, 25, 27),
      { ...backfillEvent('m2', 200, 27, 28), publicRatingBefore: 1090, publicRatingAfter: 1100 },
      backfillEvent('m3', 300, 28, 29),
    ]

    const calculated = calculatePublicRatingBackfill(events)

    expect(calculated.events[0]?.publicRatingBefore).toBe(PUBLIC_RATING_START)
    expect(calculated.events[1]?.publicRatingBefore).toBe(calculated.events[0]?.publicRatingAfter)
    expect(calculated.events[1]?.publicRatingAfter).not.toBe(1100)
    expect(calculated.events[2]?.publicRatingBefore).toBe(calculated.events[1]?.publicRatingAfter)
    expect(calculated.summaries[0]?.publicRating).toBe(calculated.events[2]?.publicRatingAfter)
  })

  test('rebuilds all canonical chains, mirrors only primary PPL data, and is idempotent', async () => {
    const { db, sqlite } = await createTestDatabase()
    await db.insert(players).values({ id: 'p1', displayName: 'P1', createdAt: 1 })
    await db.insert(matches).values([
      { id: 'm1', guildId: '111111111111111111', gameMode: '1v1', status: 'completed', createdAt: 100, completedAt: 150 },
      { id: 'm2', guildId: '111111111111111111', gameMode: '1v1', status: 'completed', isOld: true, createdAt: 200, completedAt: 200 },
      { id: 'm3', guildId: '222222222222222222', gameMode: '1v1', status: 'completed', createdAt: 300, completedAt: 350 },
    ])
    await db.insert(scopedPlayerRatings).values([
      summary(PRIMARY_STATS_KEY, 'duel', 28),
      summary(PRIMARY_STATS_KEY, 'global', 28),
      summary(OTHER_STATS_KEY, 'duel', 27),
    ])
    await db.insert(playerRatings).values([
      legacySummary('duel', 28),
      legacySummary('global', 28),
    ])

    const scopedEvents = [
      event(PRIMARY_STATS_KEY, 'm2', 'duel', 200, 27, 28, 1, 0.5),
      event(PRIMARY_STATS_KEY, 'm1', 'duel', 100, 25, 27, 0, 1),
      event(PRIMARY_STATS_KEY, 'm1', 'global', 100, 25, 27, 0, 1),
      event(OTHER_STATS_KEY, 'm3', 'duel', 300, 25, 27, 0, 1),
    ]
    await db.insert(scopedPlayerRatingEvents).values(scopedEvents)
    await db.insert(playerRatingEvents).values(scopedEvents
      .filter(row => row.statsKey === PRIMARY_STATS_KEY)
      .map(({ statsKey: _statsKey, ...row }) => row))

    const input: PublicRatingBackfillEvent[] = scopedEvents.map(row => ({
      statsKey: row.statsKey,
      matchId: row.matchId,
      playerId: row.playerId,
      mode: row.mode,
      matchCreatedAt: row.matchCreatedAt,
      ratingBeforeMu: row.ratingBeforeMu,
      ratingAfterMu: row.ratingAfterMu,
      importedGamesDelta: row.importedGamesDelta,
      effectiveGamesDelta: row.effectiveGamesDelta,
    }))
    const calculated = calculatePublicRatingBackfill(input)
    expect(calculated.events.map(row => `${row.statsKey}:${row.mode}:${row.matchId}`)).toEqual([
      `${PRIMARY_STATS_KEY}:duel:m1`,
      `${PRIMARY_STATS_KEY}:duel:m2`,
      `${PRIMARY_STATS_KEY}:global:m1`,
      `${OTHER_STATS_KEY}:duel:m3`,
    ])
    expect(calculated.events[1]?.publicRatingBefore).toBe(calculated.events[0]?.publicRatingAfter)

    applyPublicRatingBackfillBatch(sqlite, calculated, PRIMARY_STATS_KEY)
    const once = snapshot(sqlite)
    applyPublicRatingBackfillBatch(sqlite, calculated, PRIMARY_STATS_KEY)
    expect(snapshot(sqlite)).toEqual(once)

    const primaryScoped = await db.select().from(scopedPlayerRatingEvents).where(and(
      eq(scopedPlayerRatingEvents.statsKey, PRIMARY_STATS_KEY),
      eq(scopedPlayerRatingEvents.mode, 'duel'),
    )).orderBy(asc(scopedPlayerRatingEvents.matchCreatedAt))
    const primaryLegacy = await db.select().from(playerRatingEvents).where(eq(playerRatingEvents.mode, 'duel')).orderBy(asc(playerRatingEvents.matchCreatedAt))
    expect(primaryScoped.map(row => [row.publicRatingBefore, row.publicRatingAfter])).toEqual(
      primaryLegacy.map(row => [row.publicRatingBefore, row.publicRatingAfter]),
    )
    expect(primaryScoped[0]?.publicRatingBefore).toBe(PUBLIC_RATING_START)
    expect(primaryScoped[1]?.publicRatingBefore).toBe(primaryScoped[0]?.publicRatingAfter)
    expect(primaryScoped[1]!.publicRatingAfter! - primaryScoped[1]!.publicRatingBefore!).toBeGreaterThan(0)
    expect(primaryScoped[1]!.publicRatingAfter! - primaryScoped[1]!.publicRatingBefore!).toBeLessThan(18)

    const [primarySummary] = await db.select().from(scopedPlayerRatings).where(and(
      eq(scopedPlayerRatings.statsKey, PRIMARY_STATS_KEY),
      eq(scopedPlayerRatings.mode, 'duel'),
    ))
    const [legacy] = await db.select().from(playerRatings).where(eq(playerRatings.mode, 'duel'))
    expect(primarySummary?.publicRating).toBe(primaryScoped.at(-1)?.publicRatingAfter)
    expect(legacy?.publicRating).toBe(primarySummary?.publicRating)

    const [globalScopedEvent] = await db.select().from(scopedPlayerRatingEvents).where(eq(scopedPlayerRatingEvents.mode, 'global'))
    const [globalLegacyEvent] = await db.select().from(playerRatingEvents).where(eq(playerRatingEvents.mode, 'global'))
    const [globalScopedSummary] = await db.select().from(scopedPlayerRatings).where(eq(scopedPlayerRatings.mode, 'global'))
    const [globalLegacySummary] = await db.select().from(playerRatings).where(eq(playerRatings.mode, 'global'))
    expect(globalScopedEvent?.publicRatingBefore).toBe(PUBLIC_RATING_START)
    expect(globalLegacyEvent?.publicRatingAfter).toBe(globalScopedEvent?.publicRatingAfter)
    expect(globalScopedSummary?.publicRating).toBe(globalScopedEvent?.publicRatingAfter)
    expect(globalLegacySummary?.publicRating).toBe(globalScopedSummary?.publicRating)

    const [otherScoped] = await db.select().from(scopedPlayerRatingEvents).where(eq(scopedPlayerRatingEvents.statsKey, OTHER_STATS_KEY))
    expect(otherScoped?.publicRatingBefore).toBe(PUBLIC_RATING_START)

    sqlite.query('update scoped_player_rating_events set public_rating_before = 1090, public_rating_after = 1100 where stats_key = ? and match_id = ? and mode = ?').run(PRIMARY_STATS_KEY, 'm2', 'duel')
    sqlite.query('update player_rating_events set public_rating_before = 1090, public_rating_after = 1100 where match_id = ? and mode = ?').run('m2', 'duel')
    sqlite.query('update scoped_player_ratings set public_rating = 1100 where stats_key = ? and mode = ?').run(PRIMARY_STATS_KEY, 'duel')
    sqlite.query('update player_ratings set public_rating = 1100 where mode = ?').run('duel')
    applyPublicRatingBackfillBatch(sqlite, calculated, PRIMARY_STATS_KEY)

    const replayedScoped = sqlite.query('select public_rating_before, public_rating_after from scoped_player_rating_events where stats_key = ? and match_id = ? and mode = ?').get(PRIMARY_STATS_KEY, 'm2', 'duel') as { public_rating_before: number, public_rating_after: number }
    const replayedSummary = sqlite.query('select public_rating from scoped_player_ratings where stats_key = ? and mode = ?').get(PRIMARY_STATS_KEY, 'duel') as { public_rating: number }
    expect(replayedScoped).toEqual({
      public_rating_before: calculated.events[1]?.publicRatingBefore,
      public_rating_after: calculated.events[1]?.publicRatingAfter,
    })
    expect(replayedSummary.public_rating).toBe(calculated.events[1]?.publicRatingAfter)
    sqlite.close()
  })
})

function backfillEvent(matchId: string, matchCreatedAt: number, ratingBeforeMu: number, ratingAfterMu: number): PublicRatingBackfillEvent {
  return {
    statsKey: PRIMARY_STATS_KEY,
    matchId,
    playerId: 'p1',
    mode: 'duel',
    matchCreatedAt,
    ratingBeforeMu,
    ratingAfterMu,
    importedGamesDelta: 0,
    effectiveGamesDelta: 1,
  }
}

function summary(statsKey: string, mode: string, mu: number) {
  return { statsKey, playerId: 'p1', mode, mu, sigma: 6, gamesPlayed: 2, wins: 2 }
}

function legacySummary(mode: string, mu: number) {
  return { playerId: 'p1', mode, mu, sigma: 6, gamesPlayed: 2, wins: 2 }
}

function event(
  statsKey: string,
  matchId: string,
  mode: string,
  matchCreatedAt: number,
  ratingBeforeMu: number,
  ratingAfterMu: number,
  importedGamesDelta: number,
  effectiveGamesDelta: number,
) {
  return {
    statsKey,
    matchId,
    playerId: 'p1',
    mode,
    gameMode: '1v1',
    ratingBeforeMu,
    ratingBeforeSigma: 7,
    ratingAfterMu,
    ratingAfterSigma: 6,
    importedGamesDelta,
    effectiveGamesDelta,
    matchCreatedAt,
    matchCompletedAt: matchCreatedAt + 50,
  }
}

function snapshot(sqlite: import('bun:sqlite').Database): string {
  return JSON.stringify({
    scopedEvents: sqlite.query('select stats_key, match_id, player_id, mode, public_rating_before, public_rating_after from scoped_player_rating_events order by stats_key, mode, match_created_at, match_id').all(),
    scopedRatings: sqlite.query('select stats_key, player_id, mode, public_rating from scoped_player_ratings order by stats_key, mode').all(),
    legacyEvents: sqlite.query('select match_id, player_id, mode, public_rating_before, public_rating_after from player_rating_events order by mode, match_created_at, match_id').all(),
    legacyRatings: sqlite.query('select player_id, mode, public_rating from player_ratings order by mode').all(),
  })
}
