import { playerRatings, players } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { rankedPreviewEmbeds } from '../../src/embeds/ranked-preview.ts'
import { markRankedRolesDirty, summarizeRankedPreview } from '../../src/services/ranked/role-sync.ts'
import { setRankedRoleCurrentRoles } from '../../src/services/ranked/roles.ts'
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
    expect(summary.bands[0]?.keepOverallPercent).toBeCloseTo(0.025, 6)
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
    expect(summaryFields).toContain('2.5% (Top 2.5%)')
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
  mode: 'ffa' | 'duel' | 'teamers',
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
