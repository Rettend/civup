import type { GameMode } from '@civup/game'
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
const TIER_2 = 'tier2'
const TIER_4 = 'tier4'
const TIER_5 = 'tier5'

describe('player rank views', () => {
  test('builds overall and per-mode ranked data for a player', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier5: '11111111111111111',
      tier4: '22222222222222222',
      tier3: '33333333333333333',
      tier2: '44444444444444444',
      tier1: '55555555555555555',
    })

    await seedPlayers(db, 'ffa', 8, { prefix: 'ffa' })
    await seedPlayers(db, 'duel', 8, { prefix: 'duel' })
    await seedPlayerIdentity(db, HERO_ID)
    await seedRating(db, { playerId: HERO_ID, mode: 'ffa', mu: 24, sigma: 8.333, gamesPlayed: 10, lastPlayedAt: NOW })
    await seedRating(db, { playerId: HERO_ID, mode: 'duel', mu: 40, sigma: 6, gamesPlayed: 10, lastPlayedAt: NOW })

    const profile = await getPlayerRankProfile(db, kv, 'guild-1', HERO_ID, NOW)

    expect(profile.overallTier).toBe(TIER_4)
    expect(profile.overallRoleId).toBe('22222222222222222')
    expect(profile.modes.ffa.tier).toBe(TIER_5)
    expect(profile.modes.ffa.tierLabel).toBe('Role 5')
    expect(profile.modes.ffa.tierRoleId).toBe('11111111111111111')
    expect(profile.modes.duel.tier).toBe(TIER_4)
    expect(profile.modes.duel.tierLabel).toBe('Role 4')
    expect(profile.modes.duel.tierRoleId).toBe('22222222222222222')
    expect(profile.modes.duo.rating).toBeNull()
    expect(profile.modes.squad.rating).toBeNull()

    sqlite.close()
  })

  test('renders ranked role data in stats and rank embeds', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier5: '11111111111111111',
      tier4: '22222222222222222',
      tier3: '33333333333333333',
      tier2: '44444444444444444',
      tier1: '55555555555555555',
    })

    await seedPlayers(db, 'ffa', 8, { prefix: 'ffa' })
    await seedPlayers(db, 'duel', 8, { prefix: 'duel' })
    await seedPlayerIdentity(db, HERO_ID)
    await seedRating(db, { playerId: HERO_ID, mode: 'ffa', mu: 24, sigma: 8.333, gamesPlayed: 10, lastPlayedAt: NOW })
    await seedRating(db, { playerId: HERO_ID, mode: 'duel', mu: 40, sigma: 6, gamesPlayed: 10, lastPlayedAt: NOW })
    await seedSeason(db, { id: 'season-2', seasonNumber: 2, name: 'Season 2', startsAt: NOW - 2 * 86_400_000, endsAt: null, active: true })
    await seedSeason(db, { id: 'season-1', seasonNumber: 1, name: 'Season 1', startsAt: NOW - 20 * 86_400_000, endsAt: NOW - 10 * 86_400_000, active: false })
    await db.insert(seasonPeakRanks).values({ seasonId: 'season-1', playerId: HERO_ID, tier: TIER_2, sourceMode: 'duel', achievedAt: NOW - 15_000 })
    await db.insert(seasonPeakModeRanks).values([
      { seasonId: 'season-1', playerId: HERO_ID, mode: 'ffa', tier: TIER_5, rating: 631, achievedAt: NOW - 20_000 },
      { seasonId: 'season-1', playerId: HERO_ID, mode: 'duel', tier: TIER_2, rating: 711, achievedAt: NOW - 15_000 },
    ])
    await seedCompletedSeasonMatch(db, {
      matchId: 'season-1-ffa-1',
      seasonId: 'season-1',
      gameMode: 'ffa',
      playerId: HERO_ID,
      placement: 1,
      completedAt: NOW - 30_000,
    })
    await seedCompletedSeasonMatch(db, {
      matchId: 'season-1-duel-1',
      seasonId: 'season-1',
      gameMode: '1v1',
      playerId: HERO_ID,
      placement: 1,
      completedAt: NOW - 25_000,
    })
    await seedCompletedSeasonMatch(db, {
      matchId: 'season-1-duel-2',
      seasonId: 'season-1',
      gameMode: '1v1',
      playerId: HERO_ID,
      placement: 2,
      completedAt: NOW - 24_000,
    })
    await kv.put('ranked-roles:season-snapshots:guild-1', JSON.stringify({
      bySeasonId: {
        'season-1': {
          seasonNumber: 1,
          seasonName: 'Season 1',
          roles: {
            tier5: '61111111111111111',
            tier4: '62222222222222222',
            tier3: '63333333333333333',
            tier2: '64444444444444444',
            tier1: '65555555555555555',
          },
        },
      },
    }))

    const profile = await getPlayerRankProfile(db, kv, 'guild-1', HERO_ID, NOW)
    const history = await listPlayerSeasonSnapshotHistory(db, kv, 'guild-1', HERO_ID)
    const stats = (await playerCardEmbed(db, HERO_ID, 'all', { rankProfile: profile })).toJSON()
    const rank = (await rankEmbed(db, HERO_ID, profile, {
      activeSeason: { id: 'season-2', seasonNumber: 2, name: 'Season 2' },
      seasonHistory: history,
    })).toJSON()

    expect(stats.description).toContain('<@100010000000000099> - <@&22222222222222222>')
    expect(JSON.stringify(stats.fields)).toContain('Rating: <@&11111111111111111> (964)')
    expect(JSON.stringify(stats.fields)).toContain('Rating: <@&22222222222222222> (1540)')

    expect(rank.description).toContain('<@100010000000000099> - <@&22222222222222222>')
    expect(rank.fields?.[0]?.name).toBe('S2')
    expect(JSON.stringify(rank.fields)).toContain('S2')
    expect(JSON.stringify(rank.fields)).toContain('FFA')
    expect(JSON.stringify(rank.fields)).toContain('Duel')
    expect(JSON.stringify(rank.fields)).toContain('Rating: <@&11111111111111111> (964)')
    expect(JSON.stringify(rank.fields)).toContain('Rating: <@&22222222222222222> (1540)')
    expect(JSON.stringify(rank.fields)).toContain('S1')
    expect(JSON.stringify(rank.fields)).toContain('Rating: <@&11111111111111111> (631)')
    expect(JSON.stringify(rank.fields)).toContain('Rating: <@&44444444444444444> (711)')
    expect(JSON.stringify(rank.fields)).not.toContain('Duo')
    expect(JSON.stringify(rank.fields)).not.toContain('Squad')

    sqlite.close()
  })

  test('shows an empty new current season without leaking previous season stats', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier5: '11111111111111111',
      tier4: '22222222222222222',
      tier3: '33333333333333333',
      tier2: '44444444444444444',
      tier1: '55555555555555555',
    })

    await seedPlayerIdentity(db, HERO_ID)
    await seedSeason(db, { id: 'season-2', seasonNumber: 2, name: 'Season 2', startsAt: NOW - 1_000, endsAt: null, active: true })
    await seedSeason(db, { id: 'season-1', seasonNumber: 1, name: 'Season 1', startsAt: NOW - 20_000, endsAt: NOW - 10_000, active: false })
    await db.insert(seasonPeakRanks).values({ seasonId: 'season-1', playerId: HERO_ID, tier: TIER_5, sourceMode: 'duel', achievedAt: NOW - 15_000 })
    await db.insert(seasonPeakModeRanks).values({
      seasonId: 'season-1',
      playerId: HERO_ID,
      mode: 'duel',
      tier: TIER_5,
      rating: 683,
      achievedAt: NOW - 15_000,
    })
    await seedCompletedSeasonMatch(db, {
      matchId: 'season-1-duel-1',
      seasonId: 'season-1',
      gameMode: '1v1',
      playerId: HERO_ID,
      placement: 1,
      completedAt: NOW - 12_000,
    })
    await kv.put('ranked-roles:season-snapshots:guild-1', JSON.stringify({
      bySeasonId: {
        'season-1': {
          seasonNumber: 1,
          seasonName: 'Season 1',
          roles: {
            tier5: '61111111111111111',
            tier4: '62222222222222222',
            tier3: '63333333333333333',
            tier2: '64444444444444444',
            tier1: '65555555555555555',
          },
        },
      },
    }))

    const profile = await getPlayerRankProfile(db, kv, 'guild-1', HERO_ID, NOW)
    const history = await listPlayerSeasonSnapshotHistory(db, kv, 'guild-1', HERO_ID)
    const stats = (await playerCardEmbed(db, HERO_ID, 'all', { rankProfile: profile })).toJSON()
    const rank = (await rankEmbed(db, HERO_ID, profile, {
      activeSeason: { id: 'season-2', seasonNumber: 2, name: 'Season 2' },
      seasonHistory: history,
    })).toJSON()

    expect(stats.description).toContain('<@100010000000000099> - <@&11111111111111111>')
    expect(JSON.stringify(stats.fields)).toContain('No games played yet.')
    expect(JSON.stringify(stats.fields)).not.toContain('Recent Matches')
    expect(JSON.stringify(stats.fields)).not.toContain('Top Leaders')

    expect(rank.fields?.[0]?.name).toBe('S2')
    expect(JSON.stringify(rank.fields)).toContain('S2')
    expect(JSON.stringify(rank.fields)).toContain('No ranked games yet.')
    expect(JSON.stringify(rank.fields)).toContain('S1')
    expect(JSON.stringify(rank.fields)).toContain('Rating: <@&11111111111111111> (683)')

    sqlite.close()
  })

  test('shows seeded current-season ratings immediately in stats and rank', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier5: '11111111111111111',
      tier4: '22222222222222222',
      tier3: '33333333333333333',
      tier2: '44444444444444444',
      tier1: '55555555555555555',
    })

    await seedPlayerIdentity(db, HERO_ID)
    await seedSeason(db, { id: 'season-2', seasonNumber: 2, name: 'Season 2', startsAt: NOW - 1_000, endsAt: null, active: true })
    await seedRating(db, { playerId: HERO_ID, mode: 'duel', mu: 40, sigma: 6, gamesPlayed: 0, lastPlayedAt: NOW - 10_000 })

    const profile = await getPlayerRankProfile(db, kv, 'guild-1', HERO_ID, NOW)
    const history = await listPlayerSeasonSnapshotHistory(db, kv, 'guild-1', HERO_ID)
    const stats = (await playerCardEmbed(db, HERO_ID, 'all', { rankProfile: profile })).toJSON()
    const rank = (await rankEmbed(db, HERO_ID, profile, {
      activeSeason: { id: 'season-2', seasonNumber: 2, name: 'Season 2' },
      seasonHistory: history,
    })).toJSON()

    expect(JSON.stringify(stats.fields)).toContain('Rating: Unranked (1540)')
    expect(JSON.stringify(stats.fields)).toContain('Games: 0')
    expect(JSON.stringify(stats.fields)).toContain('Wins: 0 (0%)')
    expect(JSON.stringify(stats.fields)).not.toContain('Recent Matches')
    expect(JSON.stringify(stats.fields)).not.toContain('Top Leaders')

    expect(rank.fields?.[0]?.name).toBe('S2')
    expect(JSON.stringify(rank.fields)).toContain('Duel')
    expect(JSON.stringify(rank.fields)).toContain('Rating: Unranked (1540)')
    expect(JSON.stringify(rank.fields)).toContain('Games: 0')
    expect(JSON.stringify(rank.fields)).toContain('Wins: 0 (0%)')
    expect(JSON.stringify(rank.fields)).not.toContain('No ranked games yet.')

    sqlite.close()
  })

  test('renders old match history without empty leader placeholders', async () => {
    const { db, sqlite } = await createTestDatabase()

    await seedPlayerIdentity(db, HERO_ID)
    await seedPlayerIdentity(db, '100010000000000098')
    await seedPlayerIdentity(db, '100010000000000097')
    await seedPlayerIdentity(db, '100010000000000096')
    await seedPlayerIdentity(db, '100010000000000095')
    await seedRating(db, { playerId: HERO_ID, mode: 'duel', mu: 30, sigma: 6, gamesPlayed: 1, lastPlayedAt: NOW })
    await seedRating(db, { playerId: HERO_ID, mode: 'duo', mu: 29, sigma: 6, gamesPlayed: 1, lastPlayedAt: NOW })

    await seedCompletedMatch(db, {
      matchId: 'old-duel-1',
      gameMode: '1v1',
      completedAt: NOW - 2_000,
      isOld: true,
      participants: [
        { playerId: HERO_ID, team: 0, placement: 1, civId: 'babylon-hammurabi' },
        { playerId: '100010000000000098', team: 1, placement: 2, civId: 'rome-trajan' },
      ],
    })
    await seedCompletedMatch(db, {
      matchId: 'old-duo-1',
      gameMode: '2v2',
      completedAt: NOW - 1_000,
      isOld: true,
      participants: [
        { playerId: HERO_ID, team: 0, placement: 1, civId: null },
        { playerId: '100010000000000097', team: 0, placement: 1, civId: null },
        { playerId: '100010000000000096', team: 1, placement: 2, civId: null },
        { playerId: '100010000000000095', team: 1, placement: 2, civId: null },
      ],
    })

    const stats = (await playerCardEmbed(db, HERO_ID)).toJSON()
    const recentMatchesField = stats.fields?.find(field => field.name === 'Recent Matches')

    expect(recentMatchesField?.value).toContain('Hammurabi')
    expect(recentMatchesField?.value).not.toContain('[empty]')
    expect(recentMatchesField?.value).toContain('2v2')
    expect(recentMatchesField?.value).toContain('2v2 [old]')

    sqlite.close()
  })
})

async function seedPlayers(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  mode: 'duel' | 'duo' | 'squad' | 'ffa' | 'red-death',
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
      gamesPlayed: 12,
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
    mode: 'duel' | 'duo' | 'squad' | 'ffa' | 'red-death'
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
    gameMode: GameMode
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

async function seedCompletedMatch(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  row: {
    matchId: string
    gameMode: GameMode
    completedAt: number
    isOld?: boolean
    participants: Array<{
      playerId: string
      team: number | null
      placement: number
      civId: string | null
    }>
  },
): Promise<void> {
  await db.insert(matches).values({
    id: row.matchId,
    gameMode: row.gameMode,
    status: 'completed',
    isOld: row.isOld ?? false,
    seasonId: null,
    draftData: null,
    createdAt: row.completedAt - 10_000,
    completedAt: row.completedAt,
  })

  await db.insert(matchParticipants).values(row.participants.map(participant => ({
    matchId: row.matchId,
    playerId: participant.playerId,
    team: participant.team,
    civId: participant.civId,
    placement: participant.placement,
    ratingBeforeMu: null,
    ratingBeforeSigma: null,
    ratingAfterMu: null,
    ratingAfterSigma: null,
  })))
}
