import { playerRatings, playerRatingSeeds, players } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { rankedPreviewEmbeds } from '../../src/embeds/ranked-preview.ts'
import { markLeaderboardsDirty } from '../../src/services/leaderboard/message.ts'
import { markRankedRolesDirty, previewRankedRoles, summarizeRankedPreview } from '../../src/services/ranked/role-sync.ts'
import { setRankedRoleCurrentRoles, updateRankedRoleConfig } from '../../src/services/ranked/roles.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const NOW = 1_700_000_000_000

describe('ranked preview summary', () => {
  test('builds configured bands, unranked counts, and live cutoffs', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedConfiguredRoles(kv)
    await seedPlayers(db, 'ffa', 100, { prefix: 'ffa', gamesPlayed: 6 })
    await seedPlayers(db, 'ffa', 2, { prefix: 'unranked', gamesPlayed: 2 })

    const summary = await summarizeRankedPreview({
      db,
      kv,
      guildId: 'guild-1',
      now: NOW,
    })

    expect(summary.bands).toHaveLength(5)
    expect(summary.bands[0]).toMatchObject({
      tier: 'tier1',
      roleId: '55555555555555555',
      isFallback: false,
    })
    expect(summary.bands[0]?.earnPercent).toBeCloseTo(0.015, 6)
    expect(summary.bands[0]?.cumulativeEarnPercent).toBeCloseTo(0.015, 6)
    expect(summary.bands[0]?.keepPercent).toBeCloseTo(0.02, 6)
    expect(summary.bands[0]?.cumulativeKeepPercent).toBeCloseTo(0.02, 6)
    expect(summary.bands[1]?.keepPercent).toBeCloseTo(0.045, 6)
    expect(summary.bands[1]?.cumulativeKeepPercent).toBeCloseTo(0.065, 6)
    expect(summary.bands[2]?.keepPercent).toBeCloseTo(0.105, 6)
    expect(summary.bands[2]?.cumulativeKeepPercent).toBeCloseTo(0.17, 6)
    expect(summary.bands[3]?.keepPercent).toBeCloseTo(0.205, 6)
    expect(summary.bands[3]?.cumulativeKeepPercent).toBeCloseTo(0.375, 6)
    expect(summary.bands[4]).toMatchObject({
      tier: 'tier5',
      roleId: '11111111111111111',
      isFallback: true,
      cumulativeEarnPercent: 1,
    })
    expect(summary.unrankedCount).toBe(2)

    const ffa = summary.modes.find(mode => mode.mode === 'ffa')
    expect(ffa?.rankedCount).toBe(100)
    expect(ffa?.tiers.map(tier => tier.cutoffRank)).toEqual([1, 5, 15, 35, null])

    sqlite.close()
  })

  test('supports mode filters and reports locked tiers for smaller ladders', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedConfiguredRoles(kv)
    await seedPlayers(db, 'duel', 10, { prefix: 'duel', gamesPlayed: 6 })

    const summary = await summarizeRankedPreview({
      db,
      kv,
      guildId: 'guild-1',
      now: NOW,
      mode: 'duel',
    })

    expect(summary.modes).toHaveLength(1)
    expect(summary.modes[0]?.mode).toBe('duel')
    expect(summary.modes[0]?.tiers[0]).toMatchObject({
      tier: 'tier1',
      locked: true,
      unlockMinPlayers: 80,
      playersNeededToUnlock: 70,
    })
    expect(summary.modes[0]?.tiers[3]).toMatchObject({
      tier: 'tier4',
      locked: false,
      cutoffRank: 2,
    })

    sqlite.close()
  })

  test('only grants seeded ranked eligibility after a player has real games in that mode', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedConfiguredRoles(kv)
    await seedPlayers(db, 'duel', 8, { prefix: 'duel', gamesPlayed: 6 })

    const playerId = playerIdFor('seeded', 1)
    await db.insert(players).values({
      id: playerId,
      displayName: playerId,
      avatarUrl: null,
      createdAt: NOW,
    }).onConflictDoNothing()
    await db.insert(playerRatings).values({
      playerId,
      mode: 'duel',
      mu: 50,
      sigma: 6,
      gamesPlayed: 0,
      wins: 0,
      lastPlayedAt: NOW,
    }).onConflictDoUpdate({
      target: [playerRatings.playerId, playerRatings.mode],
      set: {
        mu: 50,
        sigma: 6,
        gamesPlayed: 0,
        wins: 0,
        lastPlayedAt: NOW,
      },
    })
    await db.insert(playerRatingSeeds).values({
      playerId,
      mode: 'duel',
      mu: 50,
      sigma: 6,
      eligibleForRanked: true,
      source: 'test',
      note: 'seeded duel player',
      createdAt: NOW,
      updatedAt: NOW,
    }).onConflictDoUpdate({
      target: [playerRatingSeeds.playerId, playerRatingSeeds.mode],
      set: {
        mu: 50,
        sigma: 6,
        eligibleForRanked: true,
        source: 'test',
        note: 'seeded duel player',
        updatedAt: NOW,
      },
    })

    const before = await summarizeRankedPreview({
      db,
      kv,
      guildId: 'guild-1',
      now: NOW,
      mode: 'duel',
    })

    expect(before.modes[0]?.rankedCount).toBe(8)

    await db.insert(playerRatings).values({
      playerId,
      mode: 'duel',
      mu: 50,
      sigma: 6,
      gamesPlayed: 1,
      wins: 1,
      lastPlayedAt: NOW,
    }).onConflictDoUpdate({
      target: [playerRatings.playerId, playerRatings.mode],
      set: {
        mu: 50,
        sigma: 6,
        gamesPlayed: 1,
        wins: 1,
        lastPlayedAt: NOW,
      },
    })
    await markLeaderboardsDirty(db, 'seed eligibility test update')

    const after = await previewRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      now: NOW,
      playerIds: [playerId],
      includePlayerIdentities: false,
    })
    const afterSummary = await summarizeRankedPreview({
      db,
      kv,
      guildId: 'guild-1',
      now: NOW,
      mode: 'duel',
    })

    expect(afterSummary.modes[0]?.rankedCount).toBe(9)
    expect(after.playerPreviews[0]?.ladderTiers.duel).toBe('tier4')

    sqlite.close()
  })

  test('omits empty mode embeds when only some ladders have ranked players', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedConfiguredRoles(kv)
    await seedPlayers(db, 'ffa', 100, { prefix: 'ffa', gamesPlayed: 6 })

    const summary = await summarizeRankedPreview({
      db,
      kv,
      guildId: 'guild-1',
      now: NOW,
    })

    const embeds = rankedPreviewEmbeds(summary).map(embed => embed.toJSON())

    expect(embeds).toHaveLength(2)
    expect(embeds[0]?.title).toBe('Ranked Roles')
    expect(embeds[1]?.title).toBe('FFA - 100 ranked')
    expect(JSON.stringify(embeds)).not.toContain('No ranked players yet.')

    sqlite.close()
  })

  test('renders ranked preview as separate summary and mode embeds', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedConfiguredRoles(kv)
    await seedPlayers(db, 'duel', 10, { prefix: 'duel', gamesPlayed: 6 })
    await markRankedRolesDirty(kv, 'test')

    const summary = await summarizeRankedPreview({
      db,
      kv,
      guildId: 'guild-1',
      now: NOW,
      mode: 'duel',
    })

    const embeds = rankedPreviewEmbeds(summary).map(embed => embed.toJSON())
    expect(embeds).toHaveLength(2)

    const [summaryEmbed, modeEmbed] = embeds
    const summaryFields = JSON.stringify(summaryEmbed?.fields)
    const modeFields = JSON.stringify(modeEmbed?.fields)

    expect(summaryEmbed?.title).toBe('Ranked Roles')
    expect(summaryFields).toContain('Role')
    expect(summaryFields).toContain('Earn')
    expect(summaryFields).toContain('Keep')
    expect(summaryFields).toContain('<@&55555555555555555>')
    expect(summaryFields).toContain('1.5% (Top 1.5%)')
    expect(summaryFields).toContain('2.0% (Top 2.0%)')
    expect(summaryFields).toContain('4.5% (Top 6.5%)')
    expect(summaryFields).toContain('10.5% (Top 17.0%)')
    expect(summaryFields).toContain('20.5% (Top 37.5%)')
    expect(summaryFields).toContain('Unranked')

    expect(modeEmbed?.title).toBe('Duel - 10 ranked')
    expect(modeEmbed?.footer?.text).toBe('Pending ranked sync')
    expect(modeFields).toContain('Cutoff')
    expect(modeFields).toContain('Score')
    expect(modeFields).toContain('Locked')
    expect(modeFields).toContain('needs 80 players (70 more)')
    expect(modeFields).toContain('The rest')

    sqlite.close()
  })

  test('uses the last configured role as fallback after unsetting the lowest tier', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedConfiguredRoles(kv)
    await updateRankedRoleConfig(kv, 'guild-1', {
      tierRoleIdsByRank: [undefined, undefined, undefined, undefined, null],
    })
    await seedPlayers(db, 'duel', 10, { prefix: 'duel', gamesPlayed: 6 })

    const summary = await summarizeRankedPreview({
      db,
      kv,
      guildId: 'guild-1',
      now: NOW,
      mode: 'duel',
    })

    expect(summary.bands.map(band => band.tier)).toEqual(['tier1', 'tier2', 'tier3', 'tier4'])
    expect(summary.bands[3]).toMatchObject({
      tier: 'tier4',
      roleId: '22222222222222222',
      isFallback: true,
    })
    expect(summary.modes[0]?.tiers.map(tier => tier.tier)).toEqual(['tier1', 'tier2', 'tier3', 'tier4'])

    const embeds = rankedPreviewEmbeds(summary).map(embed => embed.toJSON())
    expect(JSON.stringify(embeds)).not.toContain('Role 5')
    expect(JSON.stringify(embeds)).toContain('<@&22222222222222222>')

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

async function seedPlayers(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  mode: 'duel' | 'duo' | 'squad' | 'ffa' | 'red-death',
  count: number,
  options: { prefix: string, gamesPlayed: number },
): Promise<void> {
  for (let index = 1; index <= count; index++) {
    const playerId = playerIdFor(options.prefix, index)
    await db.insert(players).values({
      id: playerId,
      displayName: playerId,
      avatarUrl: null,
      createdAt: NOW,
    }).onConflictDoNothing()
    await db.insert(playerRatings).values({
      playerId,
      mode,
      mu: 40 - index,
      sigma: 6,
      gamesPlayed: options.gamesPlayed,
      lastPlayedAt: NOW,
    }).onConflictDoUpdate({
      target: [playerRatings.playerId, playerRatings.mode],
      set: {
        mu: 40 - index,
        sigma: 6,
        gamesPlayed: options.gamesPlayed,
        lastPlayedAt: NOW,
      },
    })
  }
}

function playerIdFor(prefix: string, index: number): string {
  const prefixValue = [...prefix].reduce((total, char) => total + char.charCodeAt(0), 0)
  return `1${String(prefixValue).padStart(4, '0')}${String(index).padStart(12, '0')}`
}
