import { matchParticipants, matches, playerRatings, players } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { teamCardEmbed } from '../../src/embeds/team-card.ts'
import { setRankedRoleCurrentRoles } from '../../src/services/ranked/roles.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const NOW = 1_700_000_000_000
const HERO_ID = '100010000000000099'
const MATE_ID = '100010000000000098'
const EXTRA_ID = '100010000000000097'
const ALLY4_ID = '100010000000000092'
const ALLY5_ID = '100010000000000091'
const OPP1_ID = '100010000000000096'
const OPP2_ID = '100010000000000095'
const OPP3_ID = '100010000000000094'
const OPP4_ID = '100010000000000093'
const OPP5_ID = '100010000000000090'

describe('team stats embed', () => {
  test('uses all compatible team modes for default lineup stats', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedConfiguredRoles(kv)

    for (const [playerId, displayName] of [
      [HERO_ID, 'Hero'],
      [MATE_ID, 'Mate'],
      [EXTRA_ID, 'Extra'],
      [OPP1_ID, 'Opp 1'],
      [OPP2_ID, 'Opp 2'],
      [OPP3_ID, 'Opp 3'],
      [OPP4_ID, 'Opp 4'],
    ] as const) {
      await seedPlayerIdentity(db, playerId, displayName)
    }

    await seedRating(db, { playerId: HERO_ID, mode: 'duo', mu: 30, sigma: 6, gamesPlayed: 6, wins: 4 })
    await seedRating(db, { playerId: MATE_ID, mode: 'duo', mu: 29, sigma: 6, gamesPlayed: 6, wins: 4 })

    await seedCompletedMatch(db, {
      matchId: 'duo-1',
      gameMode: '2v2',
      completedAt: NOW - 2_000,
      participants: [
        {
          playerId: HERO_ID,
          team: 0,
          placement: 1,
          civId: 'japan-hojo-tokimune',
          ratingBeforeMu: 25,
          ratingBeforeSigma: 6,
          ratingAfterMu: 26.25,
          ratingAfterSigma: 5.8,
        },
        {
          playerId: MATE_ID,
          team: 0,
          placement: 1,
          civId: 'babylon-hammurabi',
          ratingBeforeMu: 25,
          ratingBeforeSigma: 6,
          ratingAfterMu: 26.6111111111,
          ratingAfterSigma: 5.7,
        },
        { playerId: OPP1_ID, team: 1, placement: 2, civId: 'rome-trajan', ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { playerId: OPP2_ID, team: 1, placement: 2, civId: 'macedon-alexander', ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ],
    })

    await seedCompletedMatch(db, {
      matchId: 'duo-2',
      gameMode: '2v2',
      completedAt: NOW - 1_000,
      participants: [
        {
          playerId: HERO_ID,
          team: 0,
          placement: 2,
          civId: 'japan-hojo-tokimune',
          ratingBeforeMu: 26.25,
          ratingBeforeSigma: 5.8,
          ratingAfterMu: 25.5,
          ratingAfterSigma: 5.7,
        },
        {
          playerId: MATE_ID,
          team: 0,
          placement: 2,
          civId: 'babylon-hammurabi',
          ratingBeforeMu: 26.6111111111,
          ratingBeforeSigma: 5.7,
          ratingAfterMu: 25.8888888889,
          ratingAfterSigma: 5.6,
        },
        { playerId: OPP3_ID, team: 1, placement: 1, civId: 'rome-trajan', ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { playerId: OPP4_ID, team: 1, placement: 1, civId: 'macedon-alexander', ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ],
    })

    await seedCompletedMatch(db, {
      matchId: 'squad-ignore',
      gameMode: '3v3',
      completedAt: NOW - 500,
      participants: [
        { playerId: HERO_ID, team: 0, placement: 1, civId: 'japan-hojo-tokimune', ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { playerId: MATE_ID, team: 0, placement: 1, civId: 'babylon-hammurabi', ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { playerId: EXTRA_ID, team: 0, placement: 1, civId: 'rome-trajan', ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { playerId: OPP1_ID, team: 1, placement: 2, civId: 'macedon-alexander', ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { playerId: OPP2_ID, team: 1, placement: 2, civId: 'rome-trajan', ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { playerId: OPP3_ID, team: 1, placement: 2, civId: 'macedon-alexander', ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ],
    })

    const embed = (await teamCardEmbed(db, kv, 'guild-1', [HERO_ID, MATE_ID])).toJSON()
    const lineupField = embed.fields?.find(field => field.name === 'Lineup')
    const topLeadersField = embed.fields?.find(field => field.name === 'Top Leaders')
    const recentMatchesField = embed.fields?.find(field => field.name === 'Recent Matches')

    expect(embed.description).toBe(`<@${HERO_ID}> + <@${MATE_ID}>`)
    expect(lineupField?.value).not.toContain('Rating:')
    expect(lineupField?.value).toContain('Games: 3')
    expect(lineupField?.value).toContain('Wins: 2 (67%)')

    expect(topLeadersField?.value).toContain('Hojo Tokimune')
    expect(topLeadersField?.value).toContain('Hammurabi')
    expect(topLeadersField?.value).not.toContain('Trajan')

    expect(recentMatchesField?.value).toContain('#2')
    expect(recentMatchesField?.value).toContain('#1')
    expect(recentMatchesField?.value).toContain('3v3')
    expect(recentMatchesField?.value).toContain('Hojo Tokimune')
    expect(recentMatchesField?.value).toContain('Hammurabi')
    expect(recentMatchesField?.value).toContain('`   `')

    sqlite.close()
  })

  test('uses the explicit mode filter to keep the old exact-mode lineup behavior', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedConfiguredRoles(kv)

    for (const [playerId, displayName] of [
      [HERO_ID, 'Hero'],
      [MATE_ID, 'Mate'],
      [EXTRA_ID, 'Extra'],
      [OPP1_ID, 'Opp 1'],
      [OPP2_ID, 'Opp 2'],
      [OPP3_ID, 'Opp 3'],
      [OPP4_ID, 'Opp 4'],
    ] as const) {
      await seedPlayerIdentity(db, playerId, displayName)
    }

    await seedRating(db, { playerId: HERO_ID, mode: 'duo', mu: 30, sigma: 6, gamesPlayed: 6, wins: 4 })
    await seedRating(db, { playerId: MATE_ID, mode: 'duo', mu: 29, sigma: 6, gamesPlayed: 6, wins: 4 })

    await seedCompletedMatch(db, {
      matchId: 'duo-only-1',
      gameMode: '2v2',
      completedAt: NOW - 2_000,
      participants: [
        { playerId: HERO_ID, team: 0, placement: 1, civId: 'japan-hojo-tokimune', ratingBeforeMu: 25, ratingBeforeSigma: 6, ratingAfterMu: 26, ratingAfterSigma: 5.8 },
        { playerId: MATE_ID, team: 0, placement: 1, civId: 'babylon-hammurabi', ratingBeforeMu: 25, ratingBeforeSigma: 6, ratingAfterMu: 26, ratingAfterSigma: 5.8 },
        { playerId: OPP1_ID, team: 1, placement: 2, civId: 'rome-trajan', ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { playerId: OPP2_ID, team: 1, placement: 2, civId: 'macedon-alexander', ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ],
    })

    await seedCompletedMatch(db, {
      matchId: 'duo-only-2',
      gameMode: '3v3',
      completedAt: NOW - 1_000,
      participants: [
        { playerId: HERO_ID, team: 0, placement: 1, civId: 'japan-hojo-tokimune', ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { playerId: MATE_ID, team: 0, placement: 1, civId: 'babylon-hammurabi', ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { playerId: EXTRA_ID, team: 0, placement: 1, civId: 'rome-trajan', ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { playerId: OPP1_ID, team: 1, placement: 2, civId: 'macedon-alexander', ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { playerId: OPP2_ID, team: 1, placement: 2, civId: 'rome-trajan', ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { playerId: OPP3_ID, team: 1, placement: 2, civId: 'macedon-alexander', ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ],
    })

    const embed = (await teamCardEmbed(db, kv, 'guild-1', [HERO_ID, MATE_ID], '2v2')).toJSON()
    const duoField = embed.fields?.find(field => field.name === 'Duo')
    const recentMatchesField = embed.fields?.find(field => field.name === 'Recent Matches')

    expect(embed.description).toBe(`<@${HERO_ID}> + <@${MATE_ID}> - <@&44444444444444444>`)
    expect(duoField?.value).toContain('Rating: <@&44444444444444444> (')
    expect(duoField?.value).toContain('Games: 1')
    expect(duoField?.value).toContain('Wins: 1 (100%)')
    expect(recentMatchesField?.value).toContain('2v2')
    expect(recentMatchesField?.value).not.toContain('3v3')

    sqlite.close()
  })

  test('shows no games played yet for lineups without shared matches', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedConfiguredRoles(kv)

    await seedPlayerIdentity(db, HERO_ID, 'Hero')
    await seedPlayerIdentity(db, MATE_ID, 'Mate')
    await seedRating(db, { playerId: HERO_ID, mode: 'duo', mu: 26, sigma: 6, gamesPlayed: 4, wins: 2 })
    await seedRating(db, { playerId: MATE_ID, mode: 'duo', mu: 27, sigma: 6, gamesPlayed: 5, wins: 3 })

    const embed = (await teamCardEmbed(db, kv, 'guild-1', [HERO_ID, MATE_ID], '2v2')).toJSON()

    expect(embed.description).toBe(`<@${HERO_ID}> + <@${MATE_ID}> - <@&11111111111111111>`)
    expect(embed.fields?.[0]?.name).toBe('Overview')
    expect(embed.fields?.[0]?.value).toBe('No games played yet.')
    expect(JSON.stringify(embed.fields)).not.toContain('Games: 0')
    expect(JSON.stringify(embed.fields)).not.toContain('Wins: 0 (0%)')

    sqlite.close()
  })

  test('marks old shared team matches in recent history without empty leader placeholders', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    for (const [playerId, displayName] of [
      [HERO_ID, 'Hero'],
      [MATE_ID, 'Mate'],
      [OPP1_ID, 'Opp 1'],
      [OPP2_ID, 'Opp 2'],
    ] as const) {
      await seedPlayerIdentity(db, playerId, displayName)
    }

    await seedRating(db, { playerId: HERO_ID, mode: 'duo', mu: 30, sigma: 6, gamesPlayed: 1, wins: 1 })
    await seedRating(db, { playerId: MATE_ID, mode: 'duo', mu: 29, sigma: 6, gamesPlayed: 1, wins: 1 })

    await seedCompletedMatch(db, {
      matchId: 'duo-old-1',
      gameMode: '2v2',
      completedAt: NOW - 1_000,
      isOld: true,
      participants: [
        { playerId: HERO_ID, team: 0, placement: 1, civId: null, ratingBeforeMu: 25, ratingBeforeSigma: 6, ratingAfterMu: 26, ratingAfterSigma: 5.9 },
        { playerId: MATE_ID, team: 0, placement: 1, civId: null, ratingBeforeMu: 25, ratingBeforeSigma: 6, ratingAfterMu: 26, ratingAfterSigma: 5.9 },
        { playerId: OPP1_ID, team: 1, placement: 2, civId: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { playerId: OPP2_ID, team: 1, placement: 2, civId: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ],
    })

    const embed = (await teamCardEmbed(db, kv, null, [HERO_ID, MATE_ID], '2v2')).toJSON()
    const recentMatchesField = embed.fields?.find(field => field.name === 'Recent Matches')

    expect(recentMatchesField?.value).toContain('2v2 [old]')
    expect(recentMatchesField?.value).not.toContain('[empty]')

    sqlite.close()
  })

  test('renders shared 5v5 squad stats for larger ranked lineups', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    for (const [playerId, displayName] of [
      [HERO_ID, 'Hero'],
      [MATE_ID, 'Mate'],
      [EXTRA_ID, 'Extra'],
      [ALLY4_ID, 'Ally 4'],
      [ALLY5_ID, 'Ally 5'],
      [OPP1_ID, 'Opp 1'],
      [OPP2_ID, 'Opp 2'],
      [OPP3_ID, 'Opp 3'],
      [OPP4_ID, 'Opp 4'],
      [OPP5_ID, 'Opp 5'],
    ] as const) {
      await seedPlayerIdentity(db, playerId, displayName)
    }

    for (const playerId of [HERO_ID, MATE_ID, EXTRA_ID, ALLY4_ID, ALLY5_ID]) {
      await seedRating(db, { playerId, mode: 'squad', mu: 30, sigma: 6, gamesPlayed: 6, wins: 4 })
    }

    await seedCompletedMatch(db, {
      matchId: 'squad-5v5-1',
      gameMode: '5v5',
      completedAt: NOW - 750,
      participants: [
        { playerId: HERO_ID, team: 0, placement: 1, civId: null, ratingBeforeMu: 29, ratingBeforeSigma: 6, ratingAfterMu: 30, ratingAfterSigma: 5.9 },
        { playerId: MATE_ID, team: 0, placement: 1, civId: null, ratingBeforeMu: 29, ratingBeforeSigma: 6, ratingAfterMu: 30, ratingAfterSigma: 5.9 },
        { playerId: EXTRA_ID, team: 0, placement: 1, civId: null, ratingBeforeMu: 29, ratingBeforeSigma: 6, ratingAfterMu: 30, ratingAfterSigma: 5.9 },
        { playerId: ALLY4_ID, team: 0, placement: 1, civId: null, ratingBeforeMu: 29, ratingBeforeSigma: 6, ratingAfterMu: 30, ratingAfterSigma: 5.9 },
        { playerId: ALLY5_ID, team: 0, placement: 1, civId: null, ratingBeforeMu: 29, ratingBeforeSigma: 6, ratingAfterMu: 30, ratingAfterSigma: 5.9 },
        { playerId: OPP1_ID, team: 1, placement: 2, civId: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { playerId: OPP2_ID, team: 1, placement: 2, civId: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { playerId: OPP3_ID, team: 1, placement: 2, civId: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { playerId: OPP4_ID, team: 1, placement: 2, civId: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { playerId: OPP5_ID, team: 1, placement: 2, civId: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ],
    })

    const embed = (await teamCardEmbed(db, kv, null, [HERO_ID, MATE_ID, EXTRA_ID, ALLY4_ID, ALLY5_ID], '5v5')).toJSON()
    const squadField = embed.fields?.find(field => field.name === 'Squad')
    const recentMatchesField = embed.fields?.find(field => field.name === 'Recent Matches')

    expect(embed.description).toBe(`<@${HERO_ID}> + <@${MATE_ID}> + <@${EXTRA_ID}> + <@${ALLY4_ID}> + <@${ALLY5_ID}>`)
    expect(squadField?.value).toContain('Games: 1')
    expect(squadField?.value).toContain('Wins: 1 (100%)')
    expect(recentMatchesField?.value).toContain('5v5')

    sqlite.close()
  })

  test('projects team role from the visible duo ladder, not only 10-game qualifiers', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedConfiguredRoles(kv)

    for (const [playerId, displayName] of [
      [HERO_ID, 'Hero'],
      [MATE_ID, 'Mate'],
      [EXTRA_ID, 'Extra'],
      ['100010000000000092', 'Alt 1'],
      ['100010000000000091', 'Alt 2'],
      ['100010000000000090', 'Alt 3'],
      ['100010000000000089', 'Alt 4'],
      [OPP1_ID, 'Opp 1'],
      [OPP2_ID, 'Opp 2'],
    ] as const) {
      await seedPlayerIdentity(db, playerId, displayName)
    }

    await seedRating(db, { playerId: HERO_ID, mode: 'duo', mu: 40, sigma: 6, gamesPlayed: 5, wins: 5 })
    await seedRating(db, { playerId: MATE_ID, mode: 'duo', mu: 39, sigma: 6, gamesPlayed: 5, wins: 5 })
    await seedRating(db, { playerId: EXTRA_ID, mode: 'duo', mu: 35, sigma: 6, gamesPlayed: 5, wins: 3 })
    await seedRating(db, { playerId: '100010000000000092', mode: 'duo', mu: 34, sigma: 6, gamesPlayed: 5, wins: 3 })
    await seedRating(db, { playerId: '100010000000000091', mode: 'duo', mu: 33, sigma: 6, gamesPlayed: 5, wins: 3 })
    await seedRating(db, { playerId: '100010000000000090', mode: 'duo', mu: 32, sigma: 6, gamesPlayed: 5, wins: 3 })
    await seedRating(db, { playerId: '100010000000000089', mode: 'duo', mu: 31, sigma: 6, gamesPlayed: 10, wins: 5 })
    await seedRating(db, { playerId: OPP1_ID, mode: 'duo', mu: 30, sigma: 6, gamesPlayed: 10, wins: 5 })

    await seedCompletedMatch(db, {
      matchId: 'duo-projection',
      gameMode: '2v2',
      completedAt: NOW - 100,
      participants: [
        {
          playerId: HERO_ID,
          team: 0,
          placement: 1,
          civId: 'japan-hojo-tokimune',
          ratingBeforeMu: 39,
          ratingBeforeSigma: 6,
          ratingAfterMu: 40,
          ratingAfterSigma: 6,
        },
        {
          playerId: MATE_ID,
          team: 0,
          placement: 1,
          civId: 'babylon-hammurabi',
          ratingBeforeMu: 38,
          ratingBeforeSigma: 6,
          ratingAfterMu: 39,
          ratingAfterSigma: 6,
        },
        {
          playerId: OPP1_ID,
          team: 1,
          placement: 2,
          civId: 'rome-trajan',
          ratingBeforeMu: 30,
          ratingBeforeSigma: 6,
          ratingAfterMu: 30,
          ratingAfterSigma: 6,
        },
        {
          playerId: OPP2_ID,
          team: 1,
          placement: 2,
          civId: 'macedon-alexander',
          ratingBeforeMu: 29,
          ratingBeforeSigma: 6,
          ratingAfterMu: 29,
          ratingAfterSigma: 6,
        },
      ],
    })

    const embed = (await teamCardEmbed(db, kv, 'guild-1', [HERO_ID, MATE_ID], '2v2')).toJSON()
    const duoField = embed.fields?.find(field => field.name === 'Duo')

    expect(embed.description).toBe(`<@${HERO_ID}> + <@${MATE_ID}> - <@&44444444444444444>`)
    expect(duoField?.value).toContain('Rating: <@&44444444444444444> (')

    sqlite.close()
  })

  test('renders old duo matches without placeholder leaders', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedConfiguredRoles(kv)

    for (const [playerId, displayName] of [
      [HERO_ID, 'Hero'],
      [MATE_ID, 'Mate'],
      [OPP1_ID, 'Opp 1'],
      [OPP2_ID, 'Opp 2'],
    ] as const) {
      await seedPlayerIdentity(db, playerId, displayName)
    }

    await seedRating(db, { playerId: HERO_ID, mode: 'duo', mu: 30, sigma: 6, gamesPlayed: 1, wins: 1 })
    await seedRating(db, { playerId: MATE_ID, mode: 'duo', mu: 29, sigma: 6, gamesPlayed: 1, wins: 1 })

    await seedCompletedMatch(db, {
      matchId: 'old-duo-1',
      gameMode: '2v2',
      completedAt: NOW - 500,
      isOld: true,
      participants: [
        { playerId: HERO_ID, team: 0, placement: 1, civId: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { playerId: MATE_ID, team: 0, placement: 1, civId: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { playerId: OPP1_ID, team: 1, placement: 2, civId: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
        { playerId: OPP2_ID, team: 1, placement: 2, civId: null, ratingBeforeMu: null, ratingBeforeSigma: null, ratingAfterMu: null, ratingAfterSigma: null },
      ],
    })

    const embed = (await teamCardEmbed(db, kv, 'guild-1', [HERO_ID, MATE_ID], '2v2')).toJSON()
    const duoField = embed.fields?.find(field => field.name === 'Duo')
    const recentMatchesField = embed.fields?.find(field => field.name === 'Recent Matches')

    expect(duoField?.value).toContain('Games: 1')
    expect(recentMatchesField?.value).toContain('#1')
    expect(recentMatchesField?.value).not.toContain('[empty]')
    expect(recentMatchesField?.value).toContain('2v2')

    sqlite.close()
  })
})

async function seedConfiguredRoles(kv: KVNamespace): Promise<void> {
  await setRankedRoleCurrentRoles(kv, 'guild-1', {
    tier5: '11111111111111111',
    tier4: '22222222222222222',
    tier3: '33333333333333333',
    tier2: '44444444444444444',
    tier1: '55555555555555555',
  })
}

async function seedPlayerIdentity(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  playerId: string,
  displayName: string,
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
    wins: number
  },
): Promise<void> {
  await db.insert(playerRatings).values({
    ...row,
    lastPlayedAt: NOW,
  }).onConflictDoUpdate({
    target: [playerRatings.playerId, playerRatings.mode],
    set: {
      ...row,
      lastPlayedAt: NOW,
    },
  })
}

async function seedCompletedMatch(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  input: {
    matchId: string
    gameMode: '2v2' | '3v3' | '4v4' | '5v5' | '6v6'
    completedAt: number
    isOld?: boolean
    participants: Array<{
      playerId: string
      team: number
      placement: number
      civId: string | null
      ratingBeforeMu: number | null
      ratingBeforeSigma: number | null
      ratingAfterMu: number | null
      ratingAfterSigma: number | null
    }>
  },
): Promise<void> {
  await db.insert(matches).values({
    id: input.matchId,
    gameMode: input.gameMode,
    status: 'completed',
    isOld: input.isOld ?? false,
    seasonId: null,
    draftData: null,
    createdAt: input.completedAt - 10_000,
    completedAt: input.completedAt,
  })

  await db.insert(matchParticipants).values(input.participants.map(participant => ({
    matchId: input.matchId,
    playerId: participant.playerId,
    team: participant.team,
    civId: participant.civId,
    placement: participant.placement,
    ratingBeforeMu: participant.ratingBeforeMu,
    ratingBeforeSigma: participant.ratingBeforeSigma,
    ratingAfterMu: participant.ratingAfterMu,
    ratingAfterSigma: participant.ratingAfterSigma,
  })))
}
