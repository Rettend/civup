import { playerRatings, players } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { playerCardEmbed } from '../../src/embeds/player-card.ts'
import { rankEmbed } from '../../src/embeds/rank.ts'
import { getPlayerRankProfile } from '../../src/services/player-rank.ts'
import { setRankedRoleCurrentRoles } from '../../src/services/ranked-roles.ts'
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
    expect(profile.modes.ffa.tierLabel).toBe('Pleb')
    expect(profile.modes.duel.tier).toBe('squire')
    expect(profile.modes.duel.tierLabel).toBe('Squire')
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

    const profile = await getPlayerRankProfile(db, kv, 'guild-1', HERO_ID, NOW)
    const stats = (await playerCardEmbed(db, HERO_ID, 'all', { rankProfile: profile })).toJSON()
    const rank = (await rankEmbed(db, HERO_ID, profile)).toJSON()

    expect(stats.description).toContain('<@100010000000000099> - <@&22222222222222222>')
    expect(JSON.stringify(stats.fields)).toContain('Rating: **637** • **Pleb**')
    expect(JSON.stringify(stats.fields)).toContain('Rating: **740** • **Squire**')

    expect(rank.description).toContain('<@100010000000000099> - <@&22222222222222222>')
    expect(JSON.stringify(rank.fields)).toContain('Tier: **Pleb**')
    expect(JSON.stringify(rank.fields)).toContain('Tier: **Squire**')
    expect(JSON.stringify(rank.fields)).toContain('No games played yet.')

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
