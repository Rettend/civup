import { matches, matchParticipants, playerRatings, players, seasonPeakModeRanks, seasonPeakRanks } from '@civup/db'
import { seasonReset } from '@civup/rating'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createDraftMatch } from '../../src/services/match/index.ts'
import { recalculateLeaderboardMode } from '../../src/services/match/ratings.ts'
import { previewRankedRoles, syncRankedRoles } from '../../src/services/ranked/role-sync.ts'
import { endSeason, getActiveSeason, startSeason, syncSeasonPeakModeRanks, syncSeasonPeakRanks, syncSeasonPeaksForPlayers } from '../../src/services/season/index.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const NOW = 1_700_000_000_000
const DAY_MS = 86_400_000
const PLAYER_ID = '100010000000000001'
const HERO_ID = '100010000000000099'
const TIER_4 = 'tier4'
const TIER_5 = 'tier5'

describe('season services', () => {
  test('startSeason and endSeason manage the active season lifecycle', async () => {
    const { db, sqlite } = await createTestDatabase()

    const first = await startSeason(db, { now: NOW })
    expect(first.seasonNumber).toBe(1)
    expect(first.name).toBe('Season 1')
    expect(first.active).toBeTrue()
    expect(first.didSoftReset).toBeTrue()
    expect(first.softReset).toBeTrue()

    const active = await getActiveSeason(db)
    expect(active?.id).toBe(first.id)

    await expect(startSeason(db, { now: NOW + 1 })).rejects.toThrow('still active')

    const ended = await endSeason(db, { now: NOW + DAY_MS })
    expect(ended.active).toBeFalse()
    expect(ended.endsAt).toBe(NOW + DAY_MS)
    expect(await getActiveSeason(db)).toBeNull()

    const second = await startSeason(db, { now: NOW + 2 * DAY_MS })
    expect(second.seasonNumber).toBe(2)
    expect(second.name).toBe('Season 2')
    expect(second.didSoftReset).toBeTrue()
    expect(second.softReset).toBeTrue()

    sqlite.close()
  })

  test('startSeason soft-resets current ratings by default', async () => {
    const { db, sqlite } = await createTestDatabase()
    await seedPlayerIdentity(db, PLAYER_ID)
    await seedPlayerIdentity(db, HERO_ID)
    await seedRating(db, {
      playerId: PLAYER_ID,
      mode: 'duel',
      mu: 40,
      sigma: 6,
      gamesPlayed: 6,
      wins: 4,
      lastPlayedAt: NOW - DAY_MS,
    })
    await seedRating(db, {
      playerId: HERO_ID,
      mode: 'ffa',
      mu: 31,
      sigma: 3,
      gamesPlayed: 11,
      wins: 7,
      lastPlayedAt: NOW - 2 * DAY_MS,
    })

    const season = await startSeason(db, { now: NOW })
    expect(season.didSoftReset).toBeTrue()

    const ratings = await db.select().from(playerRatings)
    expect(ratings).toHaveLength(2)

    const duelRating = ratings.find(row => row.playerId === PLAYER_ID && row.mode === 'duel')
    expect(duelRating?.mu).toBe(40)
    expect(duelRating?.sigma).toBeCloseTo(seasonReset(40, 6).sigma, 10)
    expect(duelRating?.gamesPlayed).toBe(0)
    expect(duelRating?.wins).toBe(0)
    expect(duelRating?.lastPlayedAt).toBe(NOW - DAY_MS)

    const ffaRating = ratings.find(row => row.playerId === HERO_ID && row.mode === 'ffa')
    expect(ffaRating?.mu).toBe(31)
    expect(ffaRating?.sigma).toBeCloseTo(seasonReset(31, 3).sigma, 10)
    expect(ffaRating?.gamesPlayed).toBe(0)
    expect(ffaRating?.wins).toBe(0)
    expect(ffaRating?.lastPlayedAt).toBe(NOW - 2 * DAY_MS)

    sqlite.close()
  })

  test('startSeason preserves ratings when softReset is disabled', async () => {
    const { db, sqlite } = await createTestDatabase()
    await seedPlayerIdentity(db, PLAYER_ID)
    await seedRating(db, {
      playerId: PLAYER_ID,
      mode: 'duel',
      mu: 40,
      sigma: 6,
      gamesPlayed: 6,
      wins: 4,
      lastPlayedAt: NOW - DAY_MS,
    })

    const season = await startSeason(db, { now: NOW, seasonNumber: 8, softReset: false })
    expect(season.didSoftReset).toBeFalse()
    expect(season.softReset).toBeFalse()

    const ratings = await db.select().from(playerRatings)
    expect(ratings).toHaveLength(1)
    expect(ratings[0]?.mu).toBe(40)
    expect(ratings[0]?.sigma).toBe(6)
    expect(ratings[0]?.gamesPlayed).toBe(6)
    expect(ratings[0]?.wins).toBe(4)

    sqlite.close()
  })

  test('startSeason accepts a custom starting season number', async () => {
    const { db, sqlite } = await createTestDatabase()

    const first = await startSeason(db, { now: NOW, seasonNumber: 8 })
    expect(first.id).toBe('season-8')
    expect(first.seasonNumber).toBe(8)
    expect(first.name).toBe('Season 8')
    expect(first.softReset).toBeTrue()

    await endSeason(db, { now: NOW + DAY_MS })

    const second = await startSeason(db, { now: NOW + 2 * DAY_MS })
    expect(second.id).toBe('season-9')
    expect(second.seasonNumber).toBe(9)
    expect(second.name).toBe('Season 9')

    await endSeason(db, { now: NOW + 3 * DAY_MS })

    await expect(startSeason(db, { now: NOW + 4 * DAY_MS, seasonNumber: 8 })).rejects.toThrow('next available season')

    sqlite.close()
  })

  test('recalculateLeaderboardMode preserves pre-season games across the first season boundary', async () => {
    const { db, sqlite } = await createTestDatabase()
    const rivalId = playerIdFor('rival', 1)
    await seedPlayerIdentity(db, PLAYER_ID)
    await seedPlayerIdentity(db, rivalId)

    await db.insert(matches).values({
      id: 'duel-before-s8',
      gameMode: '1v1',
      status: 'completed',
      seasonId: null,
      createdAt: NOW - 2 * DAY_MS,
      completedAt: NOW - 2 * DAY_MS + 1_000,
      draftData: null,
    })
    await db.insert(matchParticipants).values([
      {
        matchId: 'duel-before-s8',
        playerId: PLAYER_ID,
        team: null,
        civId: null,
        placement: 1,
        ratingBeforeMu: null,
        ratingBeforeSigma: null,
        ratingAfterMu: null,
        ratingAfterSigma: null,
      },
      {
        matchId: 'duel-before-s8',
        playerId: rivalId,
        team: null,
        civId: null,
        placement: 2,
        ratingBeforeMu: null,
        ratingBeforeSigma: null,
        ratingAfterMu: null,
        ratingAfterSigma: null,
      },
    ])

    await startSeason(db, { now: NOW, seasonNumber: 8, softReset: false })

    const result = await recalculateLeaderboardMode(db, 'duel')
    expect('error' in result).toBeFalse()
    if ('error' in result) return

    const ratings = await db.select().from(playerRatings).where(eq(playerRatings.mode, 'duel'))
    const hero = ratings.find(row => row.playerId === PLAYER_ID)
    const rival = ratings.find(row => row.playerId === rivalId)

    expect(hero?.gamesPlayed).toBe(1)
    expect(hero?.wins).toBe(1)
    expect(rival?.gamesPlayed).toBe(1)
    expect(rival?.wins).toBe(0)

    sqlite.close()
  })

  test('createDraftMatch tags new matches with the active season', async () => {
    const { db, sqlite } = await createTestDatabase()
    const season = await startSeason(db, { now: NOW })

    await createDraftMatch(db, {
      matchId: 'match-1',
      mode: 'ffa',
      seats: [{ playerId: PLAYER_ID, displayName: 'Player One' }],
    })

    const [match] = await db.select().from(matches).where(eq(matches.id, 'match-1')).limit(1)
    expect(match?.seasonId).toBe(season.id)

    sqlite.close()
  })

  test('syncSeasonPeakRanks keeps the best tier reached in a season', async () => {
    const { db, sqlite } = await createTestDatabase()
    const season = await startSeason(db, { now: NOW })
    await seedPlayerIdentity(db, PLAYER_ID)

    const first = await syncSeasonPeakRanks(db, {
      seasonId: season.id,
      candidates: [{ playerId: PLAYER_ID, tier: TIER_5, sourceMode: null }],
      activePlayerIds: new Set([PLAYER_ID]),
      now: NOW + 1,
    })
    expect(first.inserted).toBe(1)

    const second = await syncSeasonPeakRanks(db, {
      seasonId: season.id,
      candidates: [{ playerId: PLAYER_ID, tier: TIER_4, sourceMode: 'ffa' }],
      activePlayerIds: new Set([PLAYER_ID]),
      now: NOW + 2,
    })
    expect(second.updated).toBe(1)

    const third = await syncSeasonPeakRanks(db, {
      seasonId: season.id,
      candidates: [{ playerId: PLAYER_ID, tier: TIER_5, sourceMode: null }],
      activePlayerIds: new Set([PLAYER_ID]),
      now: NOW + 3,
    })
    expect(third.skipped).toBe(1)

    const [peak] = await db
      .select()
      .from(seasonPeakRanks)
      .where(eq(seasonPeakRanks.playerId, PLAYER_ID))
      .limit(1)

    expect(peak?.tier).toBe(TIER_4)
    expect(peak?.sourceMode).toBe('ffa')
    expect(peak?.achievedAt).toBe(NOW + 2)

    sqlite.close()
  })

  test('syncSeasonPeakModeRanks keeps the best per-mode tier and rating in a season', async () => {
    const { db, sqlite } = await createTestDatabase()
    const season = await startSeason(db, { now: NOW })
    await seedPlayerIdentity(db, PLAYER_ID)

    const first = await syncSeasonPeakModeRanks(db, {
      seasonId: season.id,
      candidates: [{ playerId: PLAYER_ID, mode: 'ffa', tier: null, rating: 612 }],
      activeModesByPlayerId: new Map([[PLAYER_ID, new Set(['ffa'])]]),
      now: NOW + 1,
    })
    expect(first.inserted).toBe(1)

    const second = await syncSeasonPeakModeRanks(db, {
      seasonId: season.id,
      candidates: [{ playerId: PLAYER_ID, mode: 'ffa', tier: TIER_5, rating: 637 }],
      activeModesByPlayerId: new Map([[PLAYER_ID, new Set(['ffa'])]]),
      now: NOW + 2,
    })
    expect(second.updated).toBe(1)

    const third = await syncSeasonPeakModeRanks(db, {
      seasonId: season.id,
      candidates: [{ playerId: PLAYER_ID, mode: 'ffa', tier: TIER_5, rating: 630 }],
      activeModesByPlayerId: new Map([[PLAYER_ID, new Set(['ffa'])]]),
      now: NOW + 3,
    })
    expect(third.skipped).toBe(1)

    const [peak] = await db
      .select()
      .from(seasonPeakModeRanks)
      .where(eq(seasonPeakModeRanks.playerId, PLAYER_ID))
      .limit(1)

    expect(peak?.mode).toBe('ffa')
    expect(peak?.tier).toBe(TIER_5)
    expect(peak?.rating).toBe(637)
    expect(peak?.achievedAt).toBe(NOW + 2)

    sqlite.close()
  })

  test('ranked sync records peaks only for players active during the current season', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const season = await startSeason(db, { now: NOW - DAY_MS })

    await seedPlayers(db, 'ffa', 7, { prefix: 'inactive', lastPlayedAt: NOW - 2 * DAY_MS, gamesPlayed: 10 })
    await seedPlayerIdentity(db, HERO_ID)
    await seedRating(db, {
      playerId: HERO_ID,
      mode: 'ffa',
      mu: 50,
      sigma: 6,
      gamesPlayed: 10,
      lastPlayedAt: NOW,
    })

    await syncRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      now: NOW,
    })

    const peakRows = await db
      .select()
      .from(seasonPeakRanks)
      .where(eq(seasonPeakRanks.seasonId, season.id))

    expect(peakRows).toHaveLength(1)
    expect(peakRows[0]?.playerId).toBe(HERO_ID)
    expect(peakRows[0]?.tier).toBe(TIER_4)
    expect(peakRows[0]?.sourceMode).toBe('ffa')

    sqlite.close()
  })

  test('participant-scoped season peak sync updates only requested players from ranked preview', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const season = await startSeason(db, { now: NOW - DAY_MS })

    await seedPlayers(db, 'ffa', 7, { prefix: 'active', lastPlayedAt: NOW })
    await seedPlayerIdentity(db, HERO_ID)
    await seedRating(db, {
      playerId: HERO_ID,
      mode: 'ffa',
      mu: 50,
      sigma: 6,
      gamesPlayed: 6,
      lastPlayedAt: NOW,
    })

    const rivalId = playerIdFor('rival', 1)
    await seedPlayerIdentity(db, rivalId)
    await seedRating(db, {
      playerId: rivalId,
      mode: 'duel',
      mu: 44,
      sigma: 6,
      gamesPlayed: 6,
      lastPlayedAt: NOW,
    })

    const preview = await previewRankedRoles({ db, kv, guildId: 'guild-1', now: NOW })
    const result = await syncSeasonPeaksForPlayers(db, {
      playerIds: [HERO_ID],
      playerPreviews: preview.playerPreviews,
      now: NOW + 1,
    })

    expect(result.seasonId).toBe(season.id)
    expect(result.overall.inserted).toBe(1)

    const peakRows = await db
      .select()
      .from(seasonPeakRanks)
      .where(eq(seasonPeakRanks.seasonId, season.id))

    const peakModeRows = await db
      .select()
      .from(seasonPeakModeRanks)
      .where(eq(seasonPeakModeRanks.seasonId, season.id))

    expect(peakRows).toHaveLength(1)
    expect(peakRows[0]?.playerId).toBe(HERO_ID)
    expect(peakModeRows).toHaveLength(1)
    expect(peakModeRows[0]?.playerId).toBe(HERO_ID)
    expect(peakModeRows[0]?.mode).toBe('ffa')

    sqlite.close()
  })
})

async function seedPlayers(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  mode: 'duel' | 'duo' | 'squad' | 'ffa' | 'red-death',
  count: number,
  options: { prefix: string, lastPlayedAt: number, gamesPlayed?: number },
): Promise<void> {
  for (let index = 1; index <= count; index++) {
    const playerId = playerIdFor(options.prefix, index)
    await seedPlayerIdentity(db, playerId)
    await seedRating(db, {
      playerId,
      mode,
      mu: 40 - index,
      sigma: 6,
      gamesPlayed: options.gamesPlayed ?? 6,
      lastPlayedAt: options.lastPlayedAt,
    })
  }
}

async function seedPlayerIdentity(db: Awaited<ReturnType<typeof createTestDatabase>>['db'], playerId: string): Promise<void> {
  await db.insert(players).values({
    id: playerId,
    displayName: playerId,
    avatarUrl: null,
    createdAt: NOW,
  }).onConflictDoNothing()
}

async function seedRating(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  row: {
    playerId: string
    mode: 'duel' | 'duo' | 'squad' | 'ffa' | 'red-death'
    mu: number
    sigma: number
    gamesPlayed: number
    wins?: number
    lastPlayedAt: number
  },
): Promise<void> {
  const values = {
    ...row,
    wins: row.wins ?? 0,
  }

  await db.insert(playerRatings).values(values).onConflictDoUpdate({
    target: [playerRatings.playerId, playerRatings.mode],
    set: values,
  })
}

function playerIdFor(prefix: string, index: number): string {
  const prefixValue = [...prefix].reduce((total, char) => total + char.charCodeAt(0), 0)
  return `1${String(prefixValue).padStart(4, '0')}${String(index).padStart(12, '0')}`
}
