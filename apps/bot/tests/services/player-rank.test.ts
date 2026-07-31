import type { GameMode } from '@civup/game'
import { matches, matchParticipants, players, scopedPlayerRatingEvents as playerRatingEvents, scopedPlayerRatings as playerRatings, scopedSeasonPeakModeRanks as seasonPeakModeRanks, scopedSeasonPeakRanks as seasonPeakRanks, seasons, tournamentMatches, tournaments } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { leaderStatsEmbed } from '../../src/embeds/leader-card.ts'
import { playerCardEmbed } from '../../src/embeds/player-card.ts'
import { playerLeadersEmbed } from '../../src/embeds/player-leaders.ts'
import { rankEmbed } from '../../src/embeds/rank.ts'
import { backfillPlayerCivStatsFromHistory, listPlayerCivStats, loadPlayerCivRankingSummaries, reconcilePlayerCivStatMatchContribution, removePlayerCivStatMatchContribution } from '../../src/services/leaderboard/player-civ-stats.ts'
import { getPlayerRankProfile, getPlayerStatsRankProfile } from '../../src/services/player/rank.ts'
import { setRankedRoleCurrentRoles } from '../../src/services/ranked/roles.ts'
import { listPlayerSeasonSnapshotHistory } from '../../src/services/season/snapshot-roles.ts'
import { createStatsContext } from '../../src/services/stats/context.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const NOW = 1_700_000_000_000
const HERO_ID = '100010000000000099'
const GUILD_ID = '111111111111111111'
const STATS_CONTEXT = createStatsContext(GUILD_ID, GUILD_ID)
const TIER_1 = 'tier1'
const TIER_2 = 'tier2'
const TIER_4 = 'tier4'
const TIER_5 = 'tier5'

describe('player rank views', () => {
  test('builds overall and per-mode ranked data for a player', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    await setRankedRoleCurrentRoles(kv, GUILD_ID, {
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
    await seedRating(db, { playerId: HERO_ID, mode: 'global', mu: 40, sigma: 6, gamesPlayed: 25, winsVsTier1: 1, winsVsTier2Plus: 4, lastPlayedAt: NOW })

    const profile = await getPlayerRankProfile(db, kv, STATS_CONTEXT, HERO_ID, NOW)

    expect(profile.overallTier).toBe(TIER_1)
    expect(profile.overallRoleId).toBe('55555555555555555')
    expect(profile.modes.ffa.tier).toBe(TIER_4)
    expect(profile.modes.ffa.tierLabel).toBe('Role 4')
    expect(profile.modes.ffa.tierRoleId).toBe('22222222222222222')
    expect(profile.modes.duel.tier).toBe(TIER_1)
    expect(profile.modes.duel.tierLabel).toBe('Role 1')
    expect(profile.modes.duel.tierRoleId).toBe('55555555555555555')
    expect(profile.modes.duo.rating).toBeNull()
    expect(profile.modes.squad.rating).toBeNull()

    sqlite.close()
  })

  test('stats repair metadata uses the persisted assignment rather than the live preview', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    await setRankedRoleCurrentRoles(kv, GUILD_ID, {
      tier5: '11111111111111111',
      tier4: '22222222222222222',
      tier3: '33333333333333333',
      tier2: '44444444444444444',
      tier1: '55555555555555555',
    })
    await kv.put(`ranked-roles:current-assignments:${GUILD_ID}`, JSON.stringify({
      byPlayerId: {
        [HERO_ID]: { tier: TIER_2, sourceMode: null, appliedRoleId: '66666666666666666' },
      },
    }))

    await seedPlayers(db, 'duel', 8, { prefix: 'duel' })
    await seedPlayerIdentity(db, HERO_ID)
    await seedRating(db, { playerId: HERO_ID, mode: 'duel', mu: 40, sigma: 6, gamesPlayed: 10, lastPlayedAt: NOW })
    await seedRating(db, { playerId: HERO_ID, mode: 'global', mu: 40, sigma: 6, gamesPlayed: 25, winsVsTier1: 1, winsVsTier2Plus: 4, lastPlayedAt: NOW })

    const result = await getPlayerStatsRankProfile(db, kv, STATS_CONTEXT, HERO_ID, NOW)

    expect(result.rankProfile.overallTier).toBe(TIER_1)
    expect(result.rankedRoleRepair?.desiredRoleId).toBe('44444444444444444')
    expect(result.rankedRoleRepair?.managedRoleIds).toEqual([
      '55555555555555555',
      '44444444444444444',
      '33333333333333333',
      '22222222222222222',
      '11111111111111111',
      '66666666666666666',
    ])

    sqlite.close()
  })

  test('renders ranked role data in stats and rank embeds', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    await setRankedRoleCurrentRoles(kv, GUILD_ID, {
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
    await seedRating(db, { playerId: HERO_ID, mode: 'global', mu: 40, sigma: 6, gamesPlayed: 25, winsVsTier1: 1, winsVsTier2Plus: 4, lastPlayedAt: NOW })
    await seedSeason(db, { id: 'season-2', seasonNumber: 2, name: 'Season 2', startsAt: NOW - 2 * 86_400_000, endsAt: null, active: true })
    await seedSeason(db, { id: 'season-1', seasonNumber: 1, name: 'Season 1', startsAt: NOW - 20 * 86_400_000, endsAt: NOW - 10 * 86_400_000, active: false })
    await db.insert(seasonPeakRanks).values({ statsKey: STATS_CONTEXT.statsKey, seasonId: 'season-1', playerId: HERO_ID, tier: TIER_2, sourceMode: 'duel', achievedAt: NOW - 15_000 })
    await db.insert(seasonPeakModeRanks).values([
      { statsKey: STATS_CONTEXT.statsKey, seasonId: 'season-1', playerId: HERO_ID, mode: 'ffa', tier: TIER_5, rating: 631, achievedAt: NOW - 20_000 },
      { statsKey: STATS_CONTEXT.statsKey, seasonId: 'season-1', playerId: HERO_ID, mode: 'duel', tier: TIER_2, rating: 711, achievedAt: NOW - 15_000 },
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
    await kv.put(`ranked-roles:season-snapshots:${GUILD_ID}`, JSON.stringify({
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

    const profile = await getPlayerRankProfile(db, kv, STATS_CONTEXT, HERO_ID, NOW)
    const history = await listPlayerSeasonSnapshotHistory(db, kv, GUILD_ID, HERO_ID)
    const stats = (await playerCardEmbed(db, STATS_CONTEXT, HERO_ID, 'all', { rankProfile: profile })).toJSON()
    const rank = (await rankEmbed(db, HERO_ID, profile, {
      activeSeason: { id: 'season-2', seasonNumber: 2, name: 'Season 2' },
      seasonHistory: history,
    })).toJSON()

    expect(stats.description).toContain('<@100010000000000099> - <@&55555555555555555>')
    expect(JSON.stringify(stats.fields)).toContain('Rating: <@&22222222222222222> (964)')
    expect(JSON.stringify(stats.fields)).toContain('Rating: <@&55555555555555555> (1540)')
    expect(JSON.stringify(stats.fields)).toContain('Rank: #1')

    expect(rank.description).toContain('<@100010000000000099> - <@&55555555555555555>')
    expect(rank.fields?.[0]?.name).toBe('S2')
    expect(JSON.stringify(rank.fields)).toContain('S2')
    expect(JSON.stringify(rank.fields)).toContain('FFA')
    expect(JSON.stringify(rank.fields)).toContain('Duel')
    expect(JSON.stringify(rank.fields)).toContain('Rating: <@&22222222222222222> (964)')
    expect(JSON.stringify(rank.fields)).toContain('Rating: <@&55555555555555555> (1540)')
    expect(JSON.stringify(rank.fields)).toContain('S1')
    expect(JSON.stringify(rank.fields)).toContain('Rating: <@&11111111111111111> (631)')
    expect(JSON.stringify(rank.fields)).toContain('Rating: <@&44444444444444444> (711)')
    expect(JSON.stringify(rank.fields)).not.toContain('Duo')
    expect(JSON.stringify(rank.fields)).not.toContain('Squad')

    sqlite.close()
  })

  test('renders FFA first-place and rating-gain wins separately', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    await setRankedRoleCurrentRoles(kv, GUILD_ID, {
      tier5: '11111111111111111',
      tier4: '22222222222222222',
      tier3: '33333333333333333',
      tier2: '44444444444444444',
      tier1: '55555555555555555',
    })

    await seedPlayerIdentity(db, HERO_ID, 'Hero')
    await seedPlayerIdentity(db, '100010000000000088', 'Higher FFA')
    await seedPlayerIdentity(db, '100010000000000087', 'Lower FFA')
    await seedRating(db, { playerId: '100010000000000088', mode: 'ffa', mu: 32, sigma: 6, gamesPlayed: 5, wins: 3, lastPlayedAt: NOW })
    await seedRating(db, { playerId: HERO_ID, mode: 'ffa', mu: 30, sigma: 6, gamesPlayed: 5, wins: 2, lastPlayedAt: NOW })
    await seedRating(db, { playerId: '100010000000000087', mode: 'ffa', mu: 28, sigma: 6, gamesPlayed: 5, wins: 1, lastPlayedAt: NOW })

    const ffaMatches = [
      { id: 'ffa-rating-win-1', placement: 1, before: 1000, after: 1010 },
      { id: 'ffa-rating-win-2', placement: 2, before: 1010, after: 1002 },
      { id: 'ffa-rating-win-3', placement: 4, before: 1002, after: 1003 },
      { id: 'ffa-rating-win-4', placement: 1, before: 1003, after: 990 },
      { id: 'ffa-rating-win-5', placement: 3, before: 990, after: 1000 },
    ] as const

    for (let index = 0; index < ffaMatches.length; index += 1) {
      const match = ffaMatches[index]!
      await seedCompletedMatch(db, {
        matchId: match.id,
        gameMode: 'ffa',
        completedAt: NOW - ((ffaMatches.length - index) * 1_000),
        participants: [
          { playerId: HERO_ID, team: null, placement: match.placement, civId: 'japan-hojo-tokimune' },
        ],
      })
    }
    await db.insert(playerRatingEvents).values(ffaMatches.map((match, index) => ratingEvent({
      matchId: match.id,
      mode: 'ffa',
      gameMode: 'ffa',
      before: match.before,
      after: match.after,
      createdAt: NOW - ((ffaMatches.length - index) * 1_000) - 10_000,
      completedAt: NOW - ((ffaMatches.length - index) * 1_000),
    })))

    const statsProfile = await getPlayerStatsRankProfile(db, kv, STATS_CONTEXT, HERO_ID)
    const stats = (await playerCardEmbed(db, STATS_CONTEXT, HERO_ID, 'all', {
      rankProfile: statsProfile.rankProfile,
      ratingRows: statsProfile.ratingRows,
    })).toJSON()
    const ffaField = stats.fields?.find(field => field.name === 'FFA')

    expect(ffaField?.value).toContain('Rank: #2')
    expect(ffaField?.value).toContain('1st Place: 2 (40%)')
    expect(ffaField?.value).toContain('Win: 3 (60%)')
    expect(ffaField?.value).not.toContain('Wins:')

    sqlite.close()
  })

  test('omits rank row for modes below the leaderboard minimum', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    await seedPlayerIdentity(db, HERO_ID, 'Hero')
    await seedRating(db, { playerId: HERO_ID, mode: 'duel', mu: 40, sigma: 6, gamesPlayed: 1, wins: 0, lastPlayedAt: NOW })

    const statsProfile = await getPlayerStatsRankProfile(db, kv, STATS_CONTEXT, HERO_ID)
    const stats = (await playerCardEmbed(db, STATS_CONTEXT, HERO_ID, 'all', {
      rankProfile: statsProfile.rankProfile,
      ratingRows: statsProfile.ratingRows,
    })).toJSON()
    const duelField = stats.fields?.find(field => field.name === 'Duel')

    expect(duelField?.value).toContain('Rating: Unranked (1540)')
    expect(duelField?.value).not.toContain('Rank:')

    sqlite.close()
  })

  test('shows an empty new current season without leaking previous season stats', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    await setRankedRoleCurrentRoles(kv, GUILD_ID, {
      tier5: '11111111111111111',
      tier4: '22222222222222222',
      tier3: '33333333333333333',
      tier2: '44444444444444444',
      tier1: '55555555555555555',
    })

    await seedPlayerIdentity(db, HERO_ID)
    await seedSeason(db, { id: 'season-2', seasonNumber: 2, name: 'Season 2', startsAt: NOW - 1_000, endsAt: null, active: true })
    await seedSeason(db, { id: 'season-1', seasonNumber: 1, name: 'Season 1', startsAt: NOW - 20_000, endsAt: NOW - 10_000, active: false })
    await db.insert(seasonPeakRanks).values({ statsKey: STATS_CONTEXT.statsKey, seasonId: 'season-1', playerId: HERO_ID, tier: TIER_5, sourceMode: 'duel', achievedAt: NOW - 15_000 })
    await db.insert(seasonPeakModeRanks).values({
      statsKey: STATS_CONTEXT.statsKey,
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
    await kv.put(`ranked-roles:season-snapshots:${GUILD_ID}`, JSON.stringify({
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

    const profile = await getPlayerRankProfile(db, kv, STATS_CONTEXT, HERO_ID, NOW)
    const history = await listPlayerSeasonSnapshotHistory(db, kv, GUILD_ID, HERO_ID)
    const stats = (await playerCardEmbed(db, STATS_CONTEXT, HERO_ID, 'all', { rankProfile: profile })).toJSON()
    const rank = (await rankEmbed(db, HERO_ID, profile, {
      activeSeason: { id: 'season-2', seasonNumber: 2, name: 'Season 2' },
      seasonHistory: history,
    })).toJSON()

    expect(stats.description).toContain('<@100010000000000099> - Unranked')
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

    await setRankedRoleCurrentRoles(kv, GUILD_ID, {
      tier5: '11111111111111111',
      tier4: '22222222222222222',
      tier3: '33333333333333333',
      tier2: '44444444444444444',
      tier1: '55555555555555555',
    })

    await seedPlayerIdentity(db, HERO_ID)
    await seedSeason(db, { id: 'season-2', seasonNumber: 2, name: 'Season 2', startsAt: NOW - 1_000, endsAt: null, active: true })
    await seedRating(db, { playerId: HERO_ID, mode: 'duel', mu: 40, sigma: 6, gamesPlayed: 0, lastPlayedAt: NOW - 10_000 })

    const profile = await getPlayerRankProfile(db, kv, STATS_CONTEXT, HERO_ID, NOW)
    const history = await listPlayerSeasonSnapshotHistory(db, kv, GUILD_ID, HERO_ID)
    const stats = (await playerCardEmbed(db, STATS_CONTEXT, HERO_ID, 'all', { rankProfile: profile })).toJSON()
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

    const stats = (await playerCardEmbed(db, STATS_CONTEXT, HERO_ID)).toJSON()
    const recentMatchesField = stats.fields?.find(field => field.name === 'Recent Matches')

    expect(recentMatchesField?.value).toContain('Hammurabi')
    expect(recentMatchesField?.value).not.toContain('[empty]')
    expect(recentMatchesField?.value).toContain('2v2')
    expect(recentMatchesField?.value).toContain('2v2 [old]')

    sqlite.close()
  })

  test('renders recent rating changes from rating events', async () => {
    const { db, sqlite } = await createTestDatabase()

    await seedPlayerIdentity(db, HERO_ID)
    await seedPlayerIdentity(db, '100010000000000098')
    await seedCompletedMatch(db, {
      matchId: 'event-duel-1',
      gameMode: '1v1',
      completedAt: NOW - 1_000,
      participants: [
        { playerId: HERO_ID, team: 0, placement: 1, civId: 'babylon-hammurabi' },
        { playerId: '100010000000000098', team: 1, placement: 2, civId: 'rome-trajan' },
      ],
    })
    await db.insert(playerRatingEvents).values({
      statsKey: STATS_CONTEXT.statsKey,
      matchId: 'event-duel-1',
      playerId: HERO_ID,
      mode: 'duel',
      gameMode: '1v1',
      ratingBeforeMu: 25,
      ratingBeforeSigma: 8.333,
      ratingAfterMu: 26,
      ratingAfterSigma: 8,
      gamesDelta: 1,
      winsDelta: 1,
      importedGamesDelta: 0,
      effectiveGamesDelta: 1,
      winsVsTier1Delta: 0,
      winsVsTier2PlusDelta: 0,
      matchCreatedAt: NOW - 11_000,
      matchCompletedAt: NOW - 1_000,
      updatedAt: NOW,
    })

    const stats = (await playerCardEmbed(db, STATS_CONTEXT, HERO_ID)).toJSON()
    const recentMatchesField = stats.fields?.find(field => field.name === 'Recent Matches')

    expect(recentMatchesField?.value).toContain('📈')
    expect(recentMatchesField?.value).not.toContain('❔')

    sqlite.close()
  })

  test('renders CivBlitz recent matches with unranked result markers', async () => {
    const { db, sqlite } = await createTestDatabase()

    await seedPlayerIdentity(db, HERO_ID)
    await seedPlayerIdentity(db, '100010000000000098')
    await seedCompletedMatch(db, {
      matchId: 'civblitz-win',
      gameMode: '1v1',
      completedAt: NOW - 2_000,
      draftData: JSON.stringify({ civBlitz: true }),
      participants: [
        { playerId: HERO_ID, team: 0, placement: 1, civId: 'babylon-hammurabi' },
        { playerId: '100010000000000098', team: 1, placement: 2, civId: 'rome-trajan' },
      ],
    })
    await seedCompletedMatch(db, {
      matchId: 'civblitz-loss',
      gameMode: '1v1',
      completedAt: NOW - 1_000,
      draftData: JSON.stringify({ civBlitz: true }),
      participants: [
        { playerId: HERO_ID, team: 0, placement: 2, civId: 'rome-trajan' },
        { playerId: '100010000000000098', team: 1, placement: 1, civId: 'babylon-hammurabi' },
      ],
    })

    const stats = (await playerCardEmbed(db, STATS_CONTEXT, HERO_ID)).toJSON()
    const recentMatchesField = stats.fields?.find(field => field.name === 'Recent Matches')
    const value = recentMatchesField?.value ?? ''

    expect(value).toContain('`  +` 📈')
    expect(value).toContain('`  -` 📉')
    expect(value).not.toContain('❔ `(   ?)`')

    sqlite.close()
  })

  test('renders tournament recent matches with result direction emoji', async () => {
    const { db, sqlite } = await createTestDatabase()

    await seedPlayerIdentity(db, HERO_ID, 'Hero')
    await seedPlayerIdentity(db, '100010000000000098', 'Opponent')
    await db.insert(tournaments).values({
      id: 'recent-tournament',
      name: 'Recent Cup',
      mode: '1v1',
      status: 'active',
      scoring: 'open_win_rate',
      rematchPolicy: 'warn',
      minGames: 1,
      topCut: 8,
      roleId: null,
      createdById: 'admin',
      createdAt: NOW - 20_000,
      updatedAt: NOW - 20_000,
    })
    await seedCompletedMatch(db, {
      matchId: 'recent-tournament-win',
      gameMode: '1v1',
      completedAt: NOW - 2_000,
      participants: [
        { playerId: HERO_ID, team: 0, placement: 1, civId: 'babylon-hammurabi' },
        { playerId: '100010000000000098', team: 1, placement: 2, civId: 'rome-trajan' },
      ],
    })
    await seedCompletedMatch(db, {
      matchId: 'recent-tournament-loss',
      gameMode: '1v1',
      completedAt: NOW - 1_000,
      participants: [
        { playerId: HERO_ID, team: 0, placement: 2, civId: 'rome-trajan' },
        { playerId: '100010000000000098', team: 1, placement: 1, civId: 'babylon-hammurabi' },
      ],
    })
    await db.insert(tournamentMatches).values([
      {
        sessionId: 'recent-tournament-win-session',
        tournamentId: 'recent-tournament',
        matchId: 'recent-tournament-win',
        stage: 'qualifier',
        status: 'completed',
        playerOneId: HERO_ID,
        playerTwoId: '100010000000000098',
        winnerId: HERO_ID,
        createdAt: NOW - 2_000,
        updatedAt: NOW - 2_000,
      },
      {
        sessionId: 'recent-tournament-loss-session',
        tournamentId: 'recent-tournament',
        matchId: 'recent-tournament-loss',
        stage: 'qualifier',
        status: 'completed',
        playerOneId: HERO_ID,
        playerTwoId: '100010000000000098',
        winnerId: '100010000000000098',
        createdAt: NOW - 1_000,
        updatedAt: NOW - 1_000,
      },
    ])

    const stats = (await playerCardEmbed(db, STATS_CONTEXT, HERO_ID)).toJSON()
    const recentMatchesField = stats.fields?.find(field => field.name === 'Recent Matches')
    const value = recentMatchesField?.value ?? ''

    expect(value).toContain('`#1 ` 📈 `Tournament` - 1v1')
    expect(value).toContain('`#2 ` 📉 `Tournament` - 1v1')

    sqlite.close()
  })

  test('orders recent rating changes by rating replay order', async () => {
    const { db, sqlite } = await createTestDatabase()

    await seedPlayerIdentity(db, HERO_ID)
    await seedPlayerIdentity(db, '100010000000000098')

    await seedCompletedMatch(db, {
      matchId: 'rating-order-oldest',
      gameMode: '3v3',
      createdAt: NOW - 30_000,
      completedAt: NOW - 1_000,
      participants: [
        { playerId: HERO_ID, team: 0, placement: 1, civId: 'babylon-hammurabi' },
        { playerId: '100010000000000098', team: 1, placement: 2, civId: 'rome-trajan' },
      ],
    })
    await seedCompletedMatch(db, {
      matchId: 'rating-order-middle',
      gameMode: '3v3',
      createdAt: NOW - 20_000,
      completedAt: NOW - 3_000,
      participants: [
        { playerId: HERO_ID, team: 0, placement: 1, civId: 'rome-trajan' },
        { playerId: '100010000000000098', team: 1, placement: 2, civId: 'babylon-hammurabi' },
      ],
    })
    await seedCompletedMatch(db, {
      matchId: 'rating-order-newest',
      gameMode: '3v3',
      createdAt: NOW - 10_000,
      completedAt: NOW - 2_000,
      participants: [
        { playerId: HERO_ID, team: 0, placement: 1, civId: 'japan-hojo-tokimune' },
        { playerId: '100010000000000098', team: 1, placement: 2, civId: 'rome-trajan' },
      ],
    })
    await db.insert(playerRatingEvents).values([
      ratingEvent({ matchId: 'rating-order-oldest', before: 1000, after: 1015, createdAt: NOW - 30_000, completedAt: NOW - 1_000 }),
      ratingEvent({ matchId: 'rating-order-middle', before: 1015, after: 1057, createdAt: NOW - 20_000, completedAt: NOW - 3_000 }),
      ratingEvent({ matchId: 'rating-order-newest', before: 1057, after: 1064, createdAt: NOW - 10_000, completedAt: NOW - 2_000 }),
    ])

    const stats = (await playerCardEmbed(db, STATS_CONTEXT, HERO_ID)).toJSON()
    const recentMatchesField = stats.fields?.find(field => field.name === 'Recent Matches')
    const value = recentMatchesField?.value ?? ''

    expect(value.indexOf('Hojo Tokimune')).toBeLessThan(value.indexOf('Trajan'))
    expect(value.indexOf('Trajan')).toBeLessThan(value.indexOf('Hammurabi'))
    expect(value).toContain('` +7` 📈 `(1064)`')
    expect(value).toContain('`+42` 📈 `(1057)`')
    expect(value).toContain('`+15` 📈 `(1015)`')

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

    const embed = (await playerCardEmbed(db, STATS_CONTEXT, HERO_ID)).toJSON()
    const teammatesField = embed.fields?.find(field => field.name === 'Common Teammates')
    const opponentsField = embed.fields?.find(field => field.name === 'Common Opponents')
    const teammateIndex = embed.fields?.findIndex(field => field.name === 'Common Teammates') ?? -1

    expect(teammatesField?.value).toContain('Teammate A')
    expect(teammatesField?.value).toContain('2/3')
    expect(teammatesField?.value).toContain('Teammate B')
    expect(teammatesField?.value).toContain('1/2')
    expect(teammatesField?.value).toContain('Teammate E')
    expect(teammatesField?.value).toContain('Teammate F')
    expect(teammatesField?.value).not.toContain('<@')

    expect(opponentsField?.value).toContain('Opponent A')
    expect(opponentsField?.value).toContain('3/4')
    expect(opponentsField?.value).toContain('Opponent B')
    expect(opponentsField?.value).toContain('Opponent E')
    expect(opponentsField?.value).toContain('Opponent F')
    expect(opponentsField?.value).not.toContain('<@')
    expect(teammatesField?.inline).toBe(false)
    expect(opponentsField?.inline).toBe(false)
    expect(teammateIndex).toBeGreaterThanOrEqual(0)
    expect(embed.fields?.[teammateIndex + 1]?.name).toBe('Common Opponents')

    sqlite.close()
  })

  test('renders most played leaders with ranking note in leaders embed', async () => {
    const { db, sqlite } = await createTestDatabase()

    await seedPlayerIdentity(db, HERO_ID, 'Hero')
    await seedPlayerIdentity(db, '100010000000000098', 'Opponent')

    const leaderRuns = [
      { civId: 'japan-hojo-tokimune', results: [true, true, false, false, false] },
      { civId: 'babylon-hammurabi', results: [true, true, true, true] },
      { civId: 'france-catherine-de-medici-magnificence', results: [true, true, true, true, true] },
      { civId: 'rome-trajan', results: [true, true, false] },
    ] as const

    let matchIndex = 0
    for (const run of leaderRuns) {
      for (const didWin of run.results) {
        await seedCompletedMatch(db, {
          matchId: `leader-layout-${matchIndex}`,
          gameMode: '1v1',
          completedAt: NOW - ((20 - matchIndex) * 1_000),
          participants: [
            { playerId: HERO_ID, team: 0, placement: didWin ? 1 : 2, civId: run.civId },
            { playerId: '100010000000000098', team: 1, placement: didWin ? 2 : 1, civId: 'rome-trajan' },
          ],
        })
        matchIndex += 1
      }
    }

    await backfillPlayerCivStatsFromHistory(db, STATS_CONTEXT)

    const embed = (await playerLeadersEmbed(db, STATS_CONTEXT, HERO_ID)).toJSON()
    const fields = embed.fields ?? []
    const topIndex = fields.findIndex(field => field.name === 'Most Played Leaders')
    const topField = fields[topIndex]

    expect(topIndex).toBeGreaterThanOrEqual(0)
    expect(topField?.inline).toBe(false)
    expect(topField?.value).toContain('-# Ranked by number of games played')
    expect(topField?.value).toContain('Hojo Tokimune')

    sqlite.close()
  })

  test('shares top played leader ranks for equal game counts', async () => {
    const { db, sqlite } = await createTestDatabase()

    const aheadId = '100010000000000096'
    const tiedId = '100010000000000097'
    const opponentId = '100010000000000098'
    await seedPlayerIdentity(db, HERO_ID, 'Hero')
    await seedPlayerIdentity(db, aheadId, 'Ahead')
    await seedPlayerIdentity(db, tiedId, 'Tied')
    await seedPlayerIdentity(db, opponentId, 'Opponent')

    let matchIndex = 0
    const seedLeaderSeries = async (input: { playerId: string, games: number, wins: number }) => {
      for (let index = 0; index < input.games; index += 1) {
        const didWin = index < input.wins
        await seedCompletedMatch(db, {
          matchId: `leader-games-rank-${matchIndex}`,
          gameMode: '1v1',
          completedAt: NOW - ((20 - matchIndex) * 1_000),
          participants: [
            { playerId: input.playerId, team: 0, placement: didWin ? 1 : 2, civId: 'china-yongle' },
            { playerId: opponentId, team: 1, placement: didWin ? 2 : 1, civId: 'rome-trajan' },
          ],
        })
        matchIndex += 1
      }
    }

    await seedLeaderSeries({ playerId: aheadId, games: 3, wins: 0 })
    await seedLeaderSeries({ playerId: HERO_ID, games: 2, wins: 0 })
    await seedLeaderSeries({ playerId: tiedId, games: 2, wins: 2 })
    await backfillPlayerCivStatsFromHistory(db, STATS_CONTEXT)

    const rankings = await loadPlayerCivRankingSummaries(db, STATS_CONTEXT, {}, HERO_ID, ['china-yongle'])

    expect(rankings.get('china-yongle')?.playerGamesRank).toBe(2)

    sqlite.close()
  })

  test('renders leaders mode stats like stats with concise low-data fallback', async () => {
    const { db, sqlite } = await createTestDatabase()

    await seedPlayerIdentity(db, HERO_ID, 'Hero')
    await seedRating(db, { playerId: HERO_ID, mode: 'duel', mu: 25, sigma: 8.333, gamesPlayed: 5, wins: 3, lastPlayedAt: NOW })

    const embed = (await playerLeadersEmbed(db, STATS_CONTEXT, HERO_ID)).toJSON()
    const duelField = embed.fields?.find(field => field.name === 'Duel')
    const fieldsJson = JSON.stringify(embed.fields)

    expect(embed.fields?.some(field => field.name === 'Mode Summary')).toBe(false)
    expect(duelField?.inline).toBe(true)
    expect(duelField?.value).toContain('Rating:')
    expect(duelField?.value).toContain('Games: 5')
    expect(duelField?.value).toContain('Wins: 3 (60%)')
    expect(fieldsJson).toContain('Not enough leader data')
    expect(fieldsJson).not.toContain('No leaders with')

    sqlite.close()
  })

  test('does not treat raw five-game win rate as best without leader baseline', async () => {
    const { db, sqlite } = await createTestDatabase()

    await seedPlayerIdentity(db, HERO_ID, 'Hero')
    await seedPlayerIdentity(db, '100010000000000098', 'Opponent')

    const leaderRuns = [
      { civId: 'japan-hojo-tokimune', games: 20, wins: 10 },
      { civId: 'babylon-hammurabi', games: 18, wins: 9 },
      { civId: 'mali-sundiata-keita', games: 10, wins: 5 },
      { civId: 'rome-trajan', games: 10, wins: 5 },
      { civId: 'america-teddy-roosevelt-bull-moose', games: 5, wins: 5 },
    ] as const

    let matchIndex = 0
    for (const run of leaderRuns) {
      for (let index = 0; index < run.games; index += 1) {
        const didWin = index < run.wins
        await seedCompletedMatch(db, {
          matchId: `leader-sample-${matchIndex}`,
          gameMode: '1v1',
          completedAt: NOW - ((70 - matchIndex) * 1_000),
          participants: [
            { playerId: HERO_ID, team: 0, placement: didWin ? 1 : 2, civId: run.civId },
            { playerId: '100010000000000098', team: 1, placement: didWin ? 2 : 1, civId: 'rome-trajan' },
          ],
        })
        matchIndex += 1
      }
    }

    await backfillPlayerCivStatsFromHistory(db, STATS_CONTEXT)

    const embed = (await playerLeadersEmbed(db, STATS_CONTEXT, HERO_ID)).toJSON()
    const bestField = embed.fields?.find(field => field.name === 'Best Leaders')

    expect(bestField?.value).toContain('-# Ranked by leader performance')
    expect(bestField?.value).not.toContain('Teddy Roosevelt (Bull Moose)')

    sqlite.close()
  })

  test('renders adjusted best leaders in leaders embed', async () => {
    const { db, sqlite } = await createTestDatabase()

    await seedPlayerIdentity(db, HERO_ID, 'Hero')
    await seedPlayerIdentity(db, '100010000000000098', 'Opponent')
    await seedPlayerIdentity(db, '100010000000000097', 'Other')
    await seedPlayerIdentity(db, '100010000000000096', 'Baseline')

    let matchIndex = 0
    const seedLeaderSeries = async (input: { playerId: string, civId: string, games: number, wins: number }) => {
      for (let index = 0; index < input.games; index += 1) {
        const didWin = index < input.wins
        await seedCompletedMatch(db, {
          matchId: `leader-compare-${matchIndex}`,
          gameMode: '1v1',
          completedAt: NOW - ((60 - matchIndex) * 1_000),
          participants: [
            { playerId: input.playerId, team: 0, placement: didWin ? 1 : 2, civId: input.civId },
            { playerId: '100010000000000098', team: 1, placement: didWin ? 2 : 1, civId: 'rome-trajan' },
          ],
        })
        matchIndex += 1
      }
    }

    await seedLeaderSeries({ playerId: HERO_ID, civId: 'china-yongle', games: 5, wins: 5 })
    await seedLeaderSeries({ playerId: '100010000000000097', civId: 'china-yongle', games: 25, wins: 20 })
    await seedLeaderSeries({ playerId: '100010000000000096', civId: 'china-yongle', games: 30, wins: 0 })
    await seedLeaderSeries({ playerId: HERO_ID, civId: 'babylon-hammurabi', games: 5, wins: 5 })
    await seedLeaderSeries({ playerId: '100010000000000097', civId: 'babylon-hammurabi', games: 10, wins: 4 })
    await backfillPlayerCivStatsFromHistory(db, STATS_CONTEXT)

    const embed = (await playerLeadersEmbed(db, STATS_CONTEXT, HERO_ID)).toJSON()
    const bestField = embed.fields?.find(field => field.name === 'Best Leaders')
    const worseField = embed.fields?.find(field => field.name === 'Worse Than Server Avg')
    const betterField = embed.fields?.find(field => field.name === 'Better Than Server Avg')
    const statsEmbed = (await playerCardEmbed(db, STATS_CONTEXT, HERO_ID)).toJSON()

    expect(bestField?.value).toContain('-# Ranked by leader performance')
    expect(bestField?.value).toContain('`#1 `')
    expect(bestField?.value).toContain('Hammurabi')
    expect(bestField?.value).toContain('`#2 `')
    expect(bestField?.value).toContain('Yongle')
    expect(betterField).toBeUndefined()
    expect(worseField).toBeUndefined()
    expect(statsEmbed.fields?.some(field => field.name === 'Top Played Leaders')).toBe(false)
    expect(statsEmbed.fields?.some(field => field.name === 'Most Played Leaders')).toBe(false)

    sqlite.close()
  })

  test('renders leader stats matchup and ally fields', async () => {
    const { db, sqlite } = await createTestDatabase()

    await seedPlayerIdentity(db, HERO_ID, 'Hero')
    await seedPlayerIdentity(db, '100010000000000098', 'Opponent')
    await seedPlayerIdentity(db, '100010000000000097', 'Ally')
    await seedPlayerIdentity(db, '100010000000000096', 'Other')

    let matchIndex = 0
    const seedLeaderMatch = async (input: { gameMode: GameMode, participants: Array<{ playerId: string, team: number | null, placement: number, civId: string }> }) => {
      await seedCompletedMatch(db, {
        matchId: `leader-card-${matchIndex}`,
        gameMode: input.gameMode,
        completedAt: NOW - ((20 - matchIndex) * 1_000),
        participants: input.participants,
      })
      matchIndex += 1
    }

    for (let index = 0; index < 3; index += 1) {
      await seedLeaderMatch({
        gameMode: '1v1',
        participants: [
          { playerId: HERO_ID, team: 0, placement: 1, civId: 'china-yongle' },
          { playerId: '100010000000000098', team: 1, placement: 2, civId: 'rome-trajan' },
        ],
      })
    }
    for (let index = 0; index < 2; index += 1) {
      await seedLeaderMatch({
        gameMode: '1v1',
        participants: [
          { playerId: HERO_ID, team: 0, placement: 2, civId: 'china-yongle' },
          { playerId: '100010000000000098', team: 1, placement: 1, civId: 'babylon-hammurabi' },
        ],
      })
      await seedLeaderMatch({
        gameMode: '2v2',
        participants: [
          { playerId: HERO_ID, team: 0, placement: 1, civId: 'china-yongle' },
          { playerId: '100010000000000097', team: 0, placement: 1, civId: 'inca-pachacuti' },
          { playerId: '100010000000000098', team: 1, placement: 2, civId: 'rome-trajan' },
          { playerId: '100010000000000096', team: 1, placement: 2, civId: 'korea-seondeok' },
        ],
      })
      await seedLeaderMatch({
        gameMode: '2v2',
        participants: [
          { playerId: HERO_ID, team: 0, placement: 2, civId: 'china-yongle' },
          { playerId: '100010000000000097', team: 0, placement: 2, civId: 'japan-hojo-tokimune' },
          { playerId: '100010000000000098', team: 1, placement: 1, civId: 'babylon-hammurabi' },
          { playerId: '100010000000000096', team: 1, placement: 1, civId: 'rome-trajan' },
        ],
      })
    }

    const embed = (await leaderStatsEmbed(db, STATS_CONTEXT, 'china-yongle')).toJSON()
    const overview = embed.fields?.find(field => field.name === 'Overview')
    const bestAgainst = embed.fields?.find(field => field.name === 'Best Against')
    const worstAgainst = embed.fields?.find(field => field.name === 'Worst Against')
    const bestWith = embed.fields?.find(field => field.name === 'Best With')
    const worstWith = embed.fields?.find(field => field.name === 'Worst With')

    expect(embed.title).toBe('Leader Stats')
    expect(embed.description).toContain('Yongle')
    expect(overview?.value).toContain('Picks: 9')
    expect(bestAgainst?.value).toContain('Trajan')
    expect(bestAgainst?.value).toContain('5/7  71%')
    expect(worstAgainst?.value).toContain('Hammurabi')
    expect(worstAgainst?.value).toContain('0/4   0%')
    expect(bestWith?.value).toContain('Pachacuti')
    expect(bestWith?.value).toContain('2/2 100%')
    expect(worstWith?.value).toContain('Hojo Tokimune')
    expect(worstWith?.value).toContain('0/2   0%')

    sqlite.close()
  })

  test('reconciles player leader stats across all scopes', async () => {
    const { db, sqlite } = await createTestDatabase()

    await seedPlayerIdentity(db, HERO_ID, 'Hero')
    await seedPlayerIdentity(db, '100010000000000098', 'Opponent')
    await seedSeason(db, { id: 'season-1', seasonNumber: 1, name: 'Season 1', startsAt: NOW - 50_000, endsAt: null, active: true })
    await seedCompletedMatch(db, {
      matchId: 'leader-scope-1',
      gameMode: '1v1',
      seasonId: 'season-1',
      completedAt: NOW - 1_000,
      participants: [
        { playerId: HERO_ID, team: 0, placement: 1, civId: 'china-yongle' },
        { playerId: '100010000000000098', team: 1, placement: 2, civId: 'rome-trajan' },
      ],
    })

    await reconcilePlayerCivStatMatchContribution(db, STATS_CONTEXT, 'leader-scope-1', NOW)

    for (const filter of [
      {},
      { mode: '1v1' },
      { seasonId: 'season-1' },
      { seasonId: 'season-1', mode: '1v1' },
    ]) {
      expect(await listPlayerCivStats(db, STATS_CONTEXT, filter, HERO_ID)).toEqual([{ playerId: HERO_ID, civId: 'china-yongle', picks: 1, wins: 1 }])
    }

    await removePlayerCivStatMatchContribution(db, STATS_CONTEXT, 'leader-scope-1', NOW + 1)
    expect(await listPlayerCivStats(db, STATS_CONTEXT, {}, HERO_ID)).toEqual([])

    sqlite.close()
  })

  test('excludes CivBlitz matches from player leader stats', async () => {
    const { db, sqlite } = await createTestDatabase()

    await seedPlayerIdentity(db, HERO_ID, 'Hero')
    await seedPlayerIdentity(db, '100010000000000098', 'Opponent')
    await db.insert(matches).values({
      id: 'leader-civblitz-1',
      guildId: GUILD_ID,
      gameMode: '1v1',
      status: 'completed',
      isOld: false,
      seasonId: null,
      draftData: JSON.stringify({ civBlitz: true }),
      createdAt: NOW - 10_000,
      completedAt: NOW,
    })
    await db.insert(matchParticipants).values([
      {
        matchId: 'leader-civblitz-1',
        playerId: HERO_ID,
        team: 0,
        civId: 'china-yongle',
        placement: 1,
        ratingBeforeMu: null,
        ratingBeforeSigma: null,
        ratingAfterMu: null,
        ratingAfterSigma: null,
      },
      {
        matchId: 'leader-civblitz-1',
        playerId: '100010000000000098',
        team: 1,
        civId: 'rome-trajan',
        placement: 2,
        ratingBeforeMu: null,
        ratingBeforeSigma: null,
        ratingAfterMu: null,
        ratingAfterSigma: null,
      },
    ])

    await reconcilePlayerCivStatMatchContribution(db, STATS_CONTEXT, 'leader-civblitz-1', NOW)
    await backfillPlayerCivStatsFromHistory(db, STATS_CONTEXT, NOW + 1)

    expect(await listPlayerCivStats(db, STATS_CONTEXT, {}, HERO_ID)).toEqual([])

    sqlite.close()
  })

  test('keeps recent match leader names untruncated in stats', async () => {
    const { db, sqlite } = await createTestDatabase()

    await seedPlayerIdentity(db, HERO_ID, 'Hero')
    await seedPlayerIdentity(db, '100010000000000098', 'Opponent')

    for (let index = 0; index < 4; index += 1) {
      await seedCompletedMatch(db, {
        matchId: `leader-no-best-${index}`,
        gameMode: '1v1',
        completedAt: NOW - ((4 - index) * 1_000),
        participants: [
          { playerId: HERO_ID, team: 0, placement: 1, civId: 'france-catherine-de-medici-magnificence' },
          { playerId: '100010000000000098', team: 1, placement: 2, civId: 'rome-trajan' },
        ],
      })
    }

    const embed = (await playerCardEmbed(db, STATS_CONTEXT, HERO_ID)).toJSON()
    const recentMatchesField = embed.fields?.find(field => field.name === 'Recent Matches')

    expect(embed.fields?.some(field => field.name === 'Best Leaders')).toBe(false)
    expect(embed.fields?.some(field => field.name === 'Top Played Leaders')).toBe(false)
    expect(embed.fields?.some(field => field.name === 'Most Played Leaders')).toBe(false)
    expect(recentMatchesField?.inline).toBe(false)
    expect(recentMatchesField?.value).toContain('Catherine de Medici (Magnificence)')
    expect(recentMatchesField?.value).not.toContain('Catherine de Medici...')

    sqlite.close()
  })

  test('stats rank helper matches preview-based rank labels for current stats', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    await setRankedRoleCurrentRoles(kv, GUILD_ID, {
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

    const previewProfile = await getPlayerRankProfile(db, kv, STATS_CONTEXT, HERO_ID, NOW)
    const statsProfile = await getPlayerStatsRankProfile(db, kv, STATS_CONTEXT, HERO_ID)
    const previewStatsEmbed = (await playerCardEmbed(db, STATS_CONTEXT, HERO_ID, 'all', { rankProfile: previewProfile })).toJSON()
    const statsEmbed = (await playerCardEmbed(db, STATS_CONTEXT, HERO_ID, 'all', {
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
    mode: 'duel' | 'duo' | 'squad' | 'ffa' | 'red-death' | 'global'
    mu: number
    sigma: number
    gamesPlayed: number
    wins?: number
    lastPlayedAt: number
    effectiveGames?: number
    winsVsTier1?: number
    winsVsTier2Plus?: number
  },
): Promise<void> {
  const wins = row.wins ?? Math.max(0, row.gamesPlayed - 2)
  await db.insert(playerRatings).values({
    statsKey: STATS_CONTEXT.statsKey,
    ...row,
    wins,
    effectiveGames: row.effectiveGames ?? row.gamesPlayed,
    winsVsTier1: row.winsVsTier1 ?? 0,
    winsVsTier2Plus: row.winsVsTier2Plus ?? 0,
  }).onConflictDoUpdate({
    target: [playerRatings.statsKey, playerRatings.playerId, playerRatings.mode],
    set: {
      ...row,
      wins,
      effectiveGames: row.effectiveGames ?? row.gamesPlayed,
      winsVsTier1: row.winsVsTier1 ?? 0,
      winsVsTier2Plus: row.winsVsTier2Plus ?? 0,
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
    guildId: GUILD_ID,
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
    seasonId?: string | null
    createdAt?: number
    completedAt: number
    isOld?: boolean
    draftData?: string | null
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
    guildId: GUILD_ID,
    gameMode: row.gameMode,
    status: 'completed',
    isOld: row.isOld ?? false,
    seasonId: row.seasonId ?? null,
    draftData: row.draftData ?? null,
    createdAt: row.createdAt ?? row.completedAt - 10_000,
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

function ratingEvent(input: {
  matchId: string
  mode?: string
  gameMode?: string
  before: number
  after: number
  createdAt: number
  completedAt: number
}) {
  return {
    statsKey: STATS_CONTEXT.statsKey,
    matchId: input.matchId,
    playerId: HERO_ID,
    mode: input.mode ?? 'squad',
    gameMode: input.gameMode ?? '3v3',
    ratingBeforeMu: displayRatingToMu(input.before),
    ratingBeforeSigma: 8,
    ratingAfterMu: displayRatingToMu(input.after),
    ratingAfterSigma: 8,
    gamesDelta: 1,
    winsDelta: 1,
    importedGamesDelta: 0,
    effectiveGamesDelta: 1,
    winsVsTier1Delta: 0,
    winsVsTier2PlusDelta: 0,
    effectiveWinsVsTier1Delta: 0,
    effectiveWinsVsTier2PlusDelta: 0,
    matchCreatedAt: input.createdAt,
    matchCompletedAt: input.completedAt,
    updatedAt: NOW,
  }
}

function displayRatingToMu(rating: number): number {
  return 25 + ((rating - 1000) / 36)
}
