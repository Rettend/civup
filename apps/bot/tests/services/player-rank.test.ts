import type { GameMode } from '@civup/game'
import { matches, matchParticipants, playerRatings, players, seasonPeakModeRanks, seasonPeakRanks, seasons } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { playerCardEmbed } from '../../src/embeds/player-card.ts'
import { rankEmbed } from '../../src/embeds/rank.ts'
import { getPlayerRankProfile, getPlayerStatsRankProfile } from '../../src/services/player/rank.ts'
import { setRankedRoleCurrentRoles } from '../../src/services/ranked/roles.ts'
import { listPlayerSeasonSnapshotHistory } from '../../src/services/season/snapshot-roles.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const NOW = 1_700_000_000_000
const HERO_ID = '100010000000000099'
const TIER_1 = 'tier1'
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

    expect(profile.overallTier).toBe(TIER_1)
    expect(profile.overallRoleId).toBe('55555555555555555')
    expect(profile.modes.ffa.tier).toBe(TIER_5)
    expect(profile.modes.ffa.tierLabel).toBe('Role 5')
    expect(profile.modes.ffa.tierRoleId).toBe('11111111111111111')
    expect(profile.modes.duel.tier).toBe(TIER_1)
    expect(profile.modes.duel.tierLabel).toBe('Role 1')
    expect(profile.modes.duel.tierRoleId).toBe('55555555555555555')
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

    expect(stats.description).toContain('<@100010000000000099> - <@&55555555555555555>')
    expect(JSON.stringify(stats.fields)).toContain('Rating: <@&11111111111111111> (964)')
    expect(JSON.stringify(stats.fields)).toContain('Rating: <@&55555555555555555> (1540)')

    expect(rank.description).toContain('<@100010000000000099> - <@&55555555555555555>')
    expect(rank.fields?.[0]?.name).toBe('S2')
    expect(JSON.stringify(rank.fields)).toContain('S2')
    expect(JSON.stringify(rank.fields)).toContain('FFA')
    expect(JSON.stringify(rank.fields)).toContain('Duel')
    expect(JSON.stringify(rank.fields)).toContain('Rating: <@&11111111111111111> (964)')
    expect(JSON.stringify(rank.fields)).toContain('Rating: <@&55555555555555555> (1540)')
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

  test('hides zero-game seeded modes in current stats and rank', async () => {
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

    expect(JSON.stringify(stats.fields)).toContain('No games played yet.')
    expect(JSON.stringify(stats.fields)).not.toContain('Duel')
    expect(JSON.stringify(stats.fields)).not.toContain('Rating: Unranked (1540)')
    expect(JSON.stringify(stats.fields)).not.toContain('Recent Matches')
    expect(JSON.stringify(stats.fields)).not.toContain('Top Leaders')

    expect(rank.fields?.[0]?.name).toBe('S2')
    expect(JSON.stringify(rank.fields)).not.toContain('Duel')
    expect(JSON.stringify(rank.fields)).not.toContain('Rating: Unranked (1540)')
    expect(JSON.stringify(rank.fields)).toContain('No ranked games yet.')

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

  test('renders top common teammates and opponents with plain player names', async () => {
    const { db, sqlite } = await createTestDatabase()

    await seedPlayerIdentity(db, HERO_ID)

    for (const [playerId, displayName] of [
      ['100010000000000088', 'Teammate A'],
      ['100010000000000087', 'Teammate B'],
      ['100010000000000086', 'Teammate C'],
      ['100010000000000085', 'Teammate D'],
      ['100010000000000084', 'Teammate E'],
      ['100010000000000083', 'Teammate F'],
      ['100010000000000082', 'Opponent A'],
      ['100010000000000081', 'Opponent B'],
      ['100010000000000080', 'Opponent C'],
      ['100010000000000079', 'Opponent D'],
      ['100010000000000078', 'Opponent E'],
      ['100010000000000077', 'Opponent F'],
    ] as const) {
      await seedPlayerIdentity(db, playerId, displayName)
    }

    await seedCompletedMatch(db, {
      matchId: 'common-1',
      gameMode: '2v2',
      completedAt: NOW - 9_000,
      participants: [
        { playerId: HERO_ID, team: 0, placement: 1, civId: 'japan-hojo-tokimune' },
        { playerId: '100010000000000088', team: 0, placement: 1, civId: 'babylon-hammurabi' },
        { playerId: '100010000000000082', team: 1, placement: 2, civId: 'rome-trajan' },
        { playerId: '100010000000000081', team: 1, placement: 2, civId: 'macedon-alexander' },
      ],
    })
    await seedCompletedMatch(db, {
      matchId: 'common-2',
      gameMode: '2v2',
      completedAt: NOW - 8_000,
      participants: [
        { playerId: HERO_ID, team: 0, placement: 1, civId: 'japan-hojo-tokimune' },
        { playerId: '100010000000000088', team: 0, placement: 1, civId: 'babylon-hammurabi' },
        { playerId: '100010000000000082', team: 1, placement: 2, civId: 'rome-trajan' },
        { playerId: '100010000000000080', team: 1, placement: 2, civId: 'macedon-alexander' },
      ],
    })
    await seedCompletedMatch(db, {
      matchId: 'common-3',
      gameMode: '2v2',
      completedAt: NOW - 7_000,
      participants: [
        { playerId: HERO_ID, team: 0, placement: 2, civId: 'japan-hojo-tokimune' },
        { playerId: '100010000000000088', team: 0, placement: 2, civId: 'babylon-hammurabi' },
        { playerId: '100010000000000081', team: 1, placement: 1, civId: 'rome-trajan' },
        { playerId: '100010000000000080', team: 1, placement: 1, civId: 'macedon-alexander' },
      ],
    })
    await seedCompletedMatch(db, {
      matchId: 'common-4',
      gameMode: '2v2',
      completedAt: NOW - 6_000,
      participants: [
        { playerId: HERO_ID, team: 0, placement: 1, civId: 'japan-hojo-tokimune' },
        { playerId: '100010000000000087', team: 0, placement: 1, civId: 'babylon-hammurabi' },
        { playerId: '100010000000000082', team: 1, placement: 2, civId: 'rome-trajan' },
        { playerId: '100010000000000079', team: 1, placement: 2, civId: 'macedon-alexander' },
      ],
    })
    await seedCompletedMatch(db, {
      matchId: 'common-5',
      gameMode: '2v2',
      completedAt: NOW - 5_000,
      participants: [
        { playerId: HERO_ID, team: 0, placement: 2, civId: 'japan-hojo-tokimune' },
        { playerId: '100010000000000087', team: 0, placement: 2, civId: 'babylon-hammurabi' },
        { playerId: '100010000000000079', team: 1, placement: 1, civId: 'rome-trajan' },
        { playerId: '100010000000000078', team: 1, placement: 1, civId: 'macedon-alexander' },
      ],
    })
    await seedCompletedMatch(db, {
      matchId: 'common-6',
      gameMode: '2v2',
      completedAt: NOW - 4_000,
      participants: [
        { playerId: HERO_ID, team: 0, placement: 1, civId: 'japan-hojo-tokimune' },
        { playerId: '100010000000000086', team: 0, placement: 1, civId: 'babylon-hammurabi' },
        { playerId: '100010000000000081', team: 1, placement: 2, civId: 'rome-trajan' },
        { playerId: '100010000000000077', team: 1, placement: 2, civId: 'macedon-alexander' },
      ],
    })
    await seedCompletedMatch(db, {
      matchId: 'common-7',
      gameMode: '2v2',
      completedAt: NOW - 3_000,
      participants: [
        { playerId: HERO_ID, team: 0, placement: 2, civId: 'japan-hojo-tokimune' },
        { playerId: '100010000000000085', team: 0, placement: 2, civId: 'babylon-hammurabi' },
        { playerId: '100010000000000082', team: 1, placement: 1, civId: 'rome-trajan' },
        { playerId: '100010000000000077', team: 1, placement: 1, civId: 'macedon-alexander' },
      ],
    })
    await seedCompletedMatch(db, {
      matchId: 'common-8',
      gameMode: '2v2',
      completedAt: NOW - 2_000,
      participants: [
        { playerId: HERO_ID, team: 0, placement: 1, civId: 'japan-hojo-tokimune' },
        { playerId: '100010000000000084', team: 0, placement: 1, civId: 'babylon-hammurabi' },
        { playerId: '100010000000000081', team: 1, placement: 2, civId: 'rome-trajan' },
        { playerId: '100010000000000078', team: 1, placement: 2, civId: 'macedon-alexander' },
      ],
    })
    await seedCompletedMatch(db, {
      matchId: 'common-9',
      gameMode: '2v2',
      completedAt: NOW - 1_000,
      participants: [
        { playerId: HERO_ID, team: 0, placement: 2, civId: 'japan-hojo-tokimune' },
        { playerId: '100010000000000083', team: 0, placement: 2, civId: 'babylon-hammurabi' },
        { playerId: '100010000000000080', team: 1, placement: 1, civId: 'rome-trajan' },
        { playerId: '100010000000000079', team: 1, placement: 1, civId: 'macedon-alexander' },
      ],
    })

    const embed = (await playerCardEmbed(db, HERO_ID)).toJSON()
    const teammatesField = embed.fields?.find(field => field.name === 'Common Teammates')
    const opponentsField = embed.fields?.find(field => field.name === 'Common Opponents')

    expect(teammatesField?.value).toContain('Teammate A')
    expect(teammatesField?.value).toContain('2/3')
    expect(teammatesField?.value).toContain('Teammate B')
    expect(teammatesField?.value).toContain('1/2')
    expect(teammatesField?.value).toContain('Teammate E')
    expect(teammatesField?.value).not.toContain('Teammate F')
    expect(teammatesField?.value).not.toContain('<@')

    expect(opponentsField?.value).toContain('Opponent A')
    expect(opponentsField?.value).toContain('3/4')
    expect(opponentsField?.value).toContain('Opponent B')
    expect(opponentsField?.value).toContain('Opponent E')
    expect(opponentsField?.value).not.toContain('Opponent F')
    expect(opponentsField?.value).not.toContain('<@')

    sqlite.close()
  })

  test('stats rank helper matches preview-based rank labels for current stats', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier5: '11111111111111111',
      tier4: '22222222222222222',
      tier3: '33333333333333333',
      tier2: '44444444444444444',
      tier1: '55555555555555555',
    })

    await seedPlayerIdentity(db, HERO_ID, 'Hero')
    await seedPlayerIdentity(db, '100010000000000088', 'Ally')
    await seedPlayerIdentity(db, '100010000000000087', 'Opp')
    await seedRating(db, { playerId: HERO_ID, mode: 'duel', mu: 40, sigma: 6, gamesPlayed: 12, lastPlayedAt: NOW })
    await seedRating(db, { playerId: HERO_ID, mode: 'ffa', mu: 24, sigma: 8.333, gamesPlayed: 12, lastPlayedAt: NOW })
    await seedSeason(db, { id: 'season-1', seasonNumber: 1, name: 'Season 1', startsAt: NOW - 50_000, endsAt: null, active: true })
    await seedCompletedMatch(db, {
      matchId: 'stats-rank-helper-1',
      gameMode: '1v1',
      completedAt: NOW - 1_000,
      participants: [
        { playerId: HERO_ID, team: 0, placement: 1, civId: 'babylon-hammurabi' },
        { playerId: '100010000000000087', team: 1, placement: 2, civId: 'rome-trajan' },
      ],
    })
    await seedCompletedMatch(db, {
      matchId: 'stats-rank-helper-2',
      gameMode: 'ffa',
      completedAt: NOW - 500,
      participants: [
        { playerId: HERO_ID, team: null, placement: 2, civId: 'japan-hojo-tokimune' },
        { playerId: '100010000000000088', team: null, placement: 1, civId: 'rome-trajan' },
      ],
    })

    const previewProfile = await getPlayerRankProfile(db, kv, 'guild-1', HERO_ID, NOW)
    const statsProfile = await getPlayerStatsRankProfile(db, kv, 'guild-1', HERO_ID)
    const previewStatsEmbed = (await playerCardEmbed(db, HERO_ID, 'all', { rankProfile: previewProfile })).toJSON()
    const statsEmbed = (await playerCardEmbed(db, HERO_ID, 'all', {
      rankProfile: statsProfile.rankProfile,
      ratingRows: statsProfile.ratingRows,
    })).toJSON()

    expect(statsProfile.rankProfile.overallRoleId).toBe(previewProfile.overallRoleId)
    expect(statsProfile.rankProfile.modes.duel.tierRoleId).toBe(previewProfile.modes.duel.tierRoleId)
    expect(statsProfile.rankProfile.modes.ffa.tierRoleId).toBe(previewProfile.modes.ffa.tierRoleId)
    expect(statsEmbed.description).toBe(previewStatsEmbed.description)
    expect(JSON.stringify(statsEmbed.fields)).toContain(JSON.stringify(previewStatsEmbed.fields?.find(field => field.name === 'Duel')))
    expect(JSON.stringify(statsEmbed.fields)).toContain(JSON.stringify(previewStatsEmbed.fields?.find(field => field.name === 'FFA')))

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

async function seedPlayerIdentity(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  playerId: string,
  displayName = playerId,
): Promise<void> {
  await db.insert(players).values({
    id: playerId,
    displayName,
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
