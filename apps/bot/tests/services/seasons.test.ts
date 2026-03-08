import { matches, playerRatings, players, seasonPeakModeRanks, seasonPeakRanks } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { createDraftMatch } from '../../src/services/match/index.ts'
import { syncRankedRoles } from '../../src/services/ranked/role-sync.ts'
import { endSeason, getActiveSeason, startSeason, syncSeasonPeakModeRanks, syncSeasonPeakRanks } from '../../src/services/season/index.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const NOW = 1_700_000_000_000
const DAY_MS = 86_400_000
const PLAYER_ID = '100010000000000001'
const HERO_ID = '100010000000000099'

describe('season services', () => {
  test('startSeason and endSeason manage the active season lifecycle', async () => {
    const { db, sqlite } = await createTestDatabase()

    const first = await startSeason(db, { name: 'Spring', now: NOW })
    expect(first.seasonNumber).toBe(1)
    expect(first.active).toBeTrue()

    const active = await getActiveSeason(db)
    expect(active?.id).toBe(first.id)

    await expect(startSeason(db, { name: 'Summer', now: NOW + 1 })).rejects.toThrow('still active')

    const ended = await endSeason(db, { now: NOW + DAY_MS })
    expect(ended.active).toBeFalse()
    expect(ended.endsAt).toBe(NOW + DAY_MS)
    expect(await getActiveSeason(db)).toBeNull()

    const second = await startSeason(db, { name: 'Summer', now: NOW + 2 * DAY_MS })
    expect(second.seasonNumber).toBe(2)

    sqlite.close()
  })

  test('createDraftMatch tags new matches with the active season', async () => {
    const { db, sqlite } = await createTestDatabase()
    const season = await startSeason(db, { name: 'Spring', now: NOW })

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
    const season = await startSeason(db, { name: 'Spring', now: NOW })
    await seedPlayerIdentity(db, PLAYER_ID)

    const first = await syncSeasonPeakRanks(db, {
      seasonId: season.id,
      candidates: [{ playerId: PLAYER_ID, tier: 'pleb', sourceMode: null }],
      activePlayerIds: new Set([PLAYER_ID]),
      now: NOW + 1,
    })
    expect(first.inserted).toBe(1)

    const second = await syncSeasonPeakRanks(db, {
      seasonId: season.id,
      candidates: [{ playerId: PLAYER_ID, tier: 'squire', sourceMode: 'ffa' }],
      activePlayerIds: new Set([PLAYER_ID]),
      now: NOW + 2,
    })
    expect(second.updated).toBe(1)

    const third = await syncSeasonPeakRanks(db, {
      seasonId: season.id,
      candidates: [{ playerId: PLAYER_ID, tier: 'pleb', sourceMode: null }],
      activePlayerIds: new Set([PLAYER_ID]),
      now: NOW + 3,
    })
    expect(third.skipped).toBe(1)

    const [peak] = await db
      .select()
      .from(seasonPeakRanks)
      .where(eq(seasonPeakRanks.playerId, PLAYER_ID))
      .limit(1)

    expect(peak?.tier).toBe('squire')
    expect(peak?.sourceMode).toBe('ffa')
    expect(peak?.achievedAt).toBe(NOW + 2)

    sqlite.close()
  })

  test('syncSeasonPeakModeRanks keeps the best per-mode tier and rating in a season', async () => {
    const { db, sqlite } = await createTestDatabase()
    const season = await startSeason(db, { name: 'Spring', now: NOW })
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
      candidates: [{ playerId: PLAYER_ID, mode: 'ffa', tier: 'pleb', rating: 637 }],
      activeModesByPlayerId: new Map([[PLAYER_ID, new Set(['ffa'])]]),
      now: NOW + 2,
    })
    expect(second.updated).toBe(1)

    const third = await syncSeasonPeakModeRanks(db, {
      seasonId: season.id,
      candidates: [{ playerId: PLAYER_ID, mode: 'ffa', tier: 'pleb', rating: 630 }],
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
    expect(peak?.tier).toBe('pleb')
    expect(peak?.rating).toBe(637)
    expect(peak?.achievedAt).toBe(NOW + 2)

    sqlite.close()
  })

  test('ranked sync records peaks only for players active during the current season', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const season = await startSeason(db, { name: 'Spring', now: NOW - DAY_MS })

    await seedPlayers(db, 'ffa', 7, { prefix: 'inactive', lastPlayedAt: NOW - 2 * DAY_MS })
    await seedPlayerIdentity(db, HERO_ID)
    await seedRating(db, {
      playerId: HERO_ID,
      mode: 'ffa',
      mu: 50,
      sigma: 6,
      gamesPlayed: 6,
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
    expect(peakRows[0]?.tier).toBe('squire')
    expect(peakRows[0]?.sourceMode).toBe('ffa')

    sqlite.close()
  })
})

async function seedPlayers(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  mode: 'ffa' | 'duel' | 'teamers',
  count: number,
  options: { prefix: string, lastPlayedAt: number },
): Promise<void> {
  for (let index = 1; index <= count; index++) {
    const playerId = playerIdFor(options.prefix, index)
    await seedPlayerIdentity(db, playerId)
    await seedRating(db, {
      playerId,
      mode,
      mu: 40 - index,
      sigma: 6,
      gamesPlayed: 6,
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
    mode: 'ffa' | 'duel' | 'teamers'
    mu: number
    sigma: number
    gamesPlayed: number
    lastPlayedAt: number
  },
): Promise<void> {
  await db.insert(playerRatings).values(row).onConflictDoUpdate({
    target: [playerRatings.playerId, playerRatings.mode],
    set: row,
  })
}

function playerIdFor(prefix: string, index: number): string {
  const prefixValue = [...prefix].reduce((total, char) => total + char.charCodeAt(0), 0)
  return `1${String(prefixValue).padStart(4, '0')}${String(index).padStart(12, '0')}`
}
