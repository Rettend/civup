import { matches, matchParticipants, playerRatings, players, seasonPeakModeRanks, seasonPeakRanks, seasons } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { playerCardEmbed } from '../../src/embeds/player-card.ts'
import { rankEmbed } from '../../src/embeds/rank.ts'
import { getPlayerRankProfile } from '../../src/services/player/rank.ts'
import { setRankedRoleCurrentRoles } from '../../src/services/ranked/roles.ts'
import { listPlayerSeasonSnapshotHistory } from '../../src/services/season/snapshot-roles.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const NOW = 1_700_000_000_000
const HERO_ID = '100010000000000099'

describe('player rank views', () => {
  test('builds overall and per-mode ranked data for a player', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      pleb: '11111111111111111',
      squire: '22222222222222222',
      gladiator: '33333333333333333',
      legion: '44444444444444444',
      champion: '55555555555555555',
    })

    await seedPlayers(db, 'ffa', 8, { prefix: 'ffa' })
    await seedPlayers(db, 'duel', 8, { prefix: 'duel' })
    await seedPlayerIdentity(db, HERO_ID)
    await seedRating(db, { playerId: HERO_ID, mode: 'ffa', mu: 24, sigma: 8.333, gamesPlayed: 6, lastPlayedAt: NOW })
    await seedRating(db, { playerId: HERO_ID, mode: 'duel', mu: 40, sigma: 6, gamesPlayed: 6, lastPlayedAt: NOW })

    const profile = await getPlayerRankProfile(db, kv, 'guild-1', HERO_ID, NOW)

    expect(profile.overallTier).toBe('squire')
    expect(profile.overallRoleId).toBe('22222222222222222')
    expect(profile.modes.ffa.tier).toBe('pleb')
    expect(profile.modes.ffa.tierLabel).toBe('Role 5')
    expect(profile.modes.ffa.tierRoleId).toBe('11111111111111111')
    expect(profile.modes.duel.tier).toBe('squire')
    expect(profile.modes.duel.tierLabel).toBe('Role 4')
    expect(profile.modes.duel.tierRoleId).toBe('22222222222222222')
    expect(profile.modes.teamers.rating).toBeNull()

    sqlite.close()
  })

  test('renders ranked role data in stats and rank embeds', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      pleb: '11111111111111111',
      squire: '22222222222222222',
      gladiator: '33333333333333333',
      legion: '44444444444444444',
      champion: '55555555555555555',
    })

    await seedPlayers(db, 'ffa', 8, { prefix: 'ffa' })
    await seedPlayers(db, 'duel', 8, { prefix: 'duel' })
    await seedPlayerIdentity(db, HERO_ID)
    await seedRating(db, { playerId: HERO_ID, mode: 'ffa', mu: 24, sigma: 8.333, gamesPlayed: 6, lastPlayedAt: NOW })
    await seedRating(db, { playerId: HERO_ID, mode: 'duel', mu: 40, sigma: 6, gamesPlayed: 6, lastPlayedAt: NOW })
    await seedSeason(db, { id: 'season-1', seasonNumber: 1, name: 'Spring', startsAt: NOW - 2 * 86_400_000, endsAt: null, active: true })
    await seedSeason(db, { id: 'season-0', seasonNumber: 0, name: 'Winter', startsAt: NOW - 20 * 86_400_000, endsAt: NOW - 10 * 86_400_000, active: false })
    await db.insert(seasonPeakRanks).values({ seasonId: 'season-0', playerId: HERO_ID, tier: 'legion', sourceMode: 'duel', achievedAt: NOW - 15_000 })
    await db.insert(seasonPeakModeRanks).values([
      { seasonId: 'season-0', playerId: HERO_ID, mode: 'ffa', tier: 'pleb', rating: 631, achievedAt: NOW - 20_000 },
      { seasonId: 'season-0', playerId: HERO_ID, mode: 'duel', tier: 'legion', rating: 711, achievedAt: NOW - 15_000 },
    ])
    await seedCompletedSeasonMatch(db, {
      matchId: 'winter-ffa-1',
      seasonId: 'season-0',
      gameMode: 'ffa',
      playerId: HERO_ID,
      placement: 1,
      completedAt: NOW - 30_000,
    })
    await seedCompletedSeasonMatch(db, {
      matchId: 'winter-duel-1',
      seasonId: 'season-0',
      gameMode: '1v1',
      playerId: HERO_ID,
      placement: 1,
      completedAt: NOW - 25_000,
    })
    await seedCompletedSeasonMatch(db, {
      matchId: 'winter-duel-2',
      seasonId: 'season-0',
      gameMode: '1v1',
      playerId: HERO_ID,
      placement: 2,
      completedAt: NOW - 24_000,
    })
    await kv.put('ranked-roles:season-snapshots:guild-1', JSON.stringify({
      bySeasonId: {
        'season-0': {
          seasonNumber: 0,
          seasonName: 'Winter',
          roles: {
            pleb: '61111111111111111',
            squire: '62222222222222222',
            gladiator: '63333333333333333',
            legion: '64444444444444444',
            champion: '65555555555555555',
          },
        },
      },
    }))

    const profile = await getPlayerRankProfile(db, kv, 'guild-1', HERO_ID, NOW)
    const history = await listPlayerSeasonSnapshotHistory(db, kv, 'guild-1', HERO_ID)
    const stats = (await playerCardEmbed(db, HERO_ID, 'all', { rankProfile: profile })).toJSON()
    const rank = (await rankEmbed(db, HERO_ID, profile, {
      activeSeason: { id: 'season-1', seasonNumber: 1, name: 'Spring' },
      seasonHistory: history,
    })).toJSON()

    expect(stats.description).toContain('<@100010000000000099> - <@&22222222222222222>')
    expect(JSON.stringify(stats.fields)).toContain('Rating: <@&11111111111111111> (637)')
    expect(JSON.stringify(stats.fields)).toContain('Rating: <@&22222222222222222> (740)')

    expect(rank.description).toContain('<@100010000000000099> - <@&22222222222222222>')
    expect(JSON.stringify(rank.fields)).toContain('Spring')
    expect(JSON.stringify(rank.fields)).toContain('FFA')
    expect(JSON.stringify(rank.fields)).toContain('Duel')
    expect(JSON.stringify(rank.fields)).toContain('Rating: <@&11111111111111111> (637)')
    expect(JSON.stringify(rank.fields)).toContain('Rating: <@&22222222222222222> (740)')
    expect(JSON.stringify(rank.fields)).toContain('Winter')
    expect(JSON.stringify(rank.fields)).toContain('Rating: <@&61111111111111111> (631)')
    expect(JSON.stringify(rank.fields)).toContain('Rating: <@&64444444444444444> (711)')
    expect(JSON.stringify(rank.fields)).not.toContain('Teamers')

    sqlite.close()
  })
})

async function seedPlayers(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  mode: 'ffa' | 'duel' | 'teamers',
  count: number,
  options: { prefix: string },
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
      lastPlayedAt: NOW,
    })
  }
}

async function seedSeason(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  row: {
    id: string
    seasonNumber: number
    name: string
    startsAt: number
    endsAt: number | null
    active: boolean
  },
): Promise<void> {
  await db.insert(seasons).values(row)
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
  await db.insert(playerRatings).values({
    ...row,
    wins: Math.max(0, row.gamesPlayed - 2),
  }).onConflictDoUpdate({
    target: [playerRatings.playerId, playerRatings.mode],
    set: {
      ...row,
      wins: Math.max(0, row.gamesPlayed - 2),
    },
  })
}

function playerIdFor(prefix: string, index: number): string {
  const prefixValue = [...prefix].reduce((total, char) => total + char.charCodeAt(0), 0)
  return `1${String(prefixValue).padStart(4, '0')}${String(index).padStart(12, '0')}`
}

async function seedCompletedSeasonMatch(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  row: {
    matchId: string
    seasonId: string
    gameMode: 'ffa' | '1v1' | '2v2' | '3v3'
    playerId: string
    placement: number
    completedAt: number
  },
): Promise<void> {
  await db.insert(matches).values({
    id: row.matchId,
    gameMode: row.gameMode,
    status: 'completed',
    seasonId: row.seasonId,
    draftData: null,
    createdAt: row.completedAt - 10_000,
    completedAt: row.completedAt,
  })
  await db.insert(matchParticipants).values({
    matchId: row.matchId,
    playerId: row.playerId,
    team: null,
    civId: null,
    placement: row.placement,
    ratingBeforeMu: null,
    ratingBeforeSigma: null,
    ratingAfterMu: null,
    ratingAfterSigma: null,
  })
}
