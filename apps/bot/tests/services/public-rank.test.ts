import { playerRatings, players, seasonPeakRanks, seasons } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { buildPlayerLeaderboardImageData, renderPlayerLeaderboardSvg } from '../../src/services/leaderboard/image.ts'
import { previewRankedRoles, syncRankedRoles } from '../../src/services/ranked/role-sync.ts'
import { formatPublicRatingSnapshotChange } from '../../src/embeds/rating-change.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

describe('public rank integration', () => {
  test('fixed RP ranks retain global qualification gates and independent mode ranks', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    try {
      await db.insert(seasons).values({ id: 's9', name: 'Season 9', seasonNumber: 9, startsAt: 1000, active: true, ratingSystem: 'rp', publicReadsEnabled: true, isolatedRatingsEnabled: true })
      const ids = [7, 8, 16, 18].map(games => `10000000000000000${games}`)
      for (const [index, games] of [7, 8, 16, 18].entries()) {
        await db.insert(players).values({ id: ids[index]!, displayName: String(games), createdAt: 0 })
        await db.insert(playerRatings).values([
          { playerId: ids[index]!, mode: 'global', mu: 10, sigma: 3, gamesPlayed: games, effectiveGames: games, publicRating: 1600, winsVsTier1: 1, winsVsTier2Plus: 4, lastPlayedAt: 1500 },
          { playerId: ids[index]!, mode: 'duel', mu: 10, sigma: 3, gamesPlayed: 20, effectiveGames: 20, publicRating: 1300, lastPlayedAt: 1500 },
        ])
      }
      const result = await previewRankedRoles({ db, kv, guildId: 'guild', now: 2000 })
      const rows = ids.map(id => result.playerPreviews.find(player => player.playerId === id)!)
      expect(rows[0]!.managed).toBe(false)
      expect(rows[1]!.assignment.tier).toBe('tier3')
      expect(rows[2]!.assignment.tier).toBe('tier2')
      expect(rows[3]!.assignment.tier).toBe('tier1')
      expect(rows.every(row => row.ladderTiers.duel === 'tier2')).toBe(true)
      expect(rows.every(row => row.globalScore === 1600)).toBe(true)
      await db.update(seasons).set({ publicReadsEnabled: false }).where(eq(seasons.id, 's9'))
      const shadow = await syncRankedRoles({ db, kv, guildId: 'guild', now: 2000, applyDiscord: true })
      expect(shadow.appliedDiscordChanges).toBe(0)
      expect(await db.select().from(seasonPeakRanks)).toHaveLength(0)
    }
    finally { sqlite.close() }
  })

  test('leaderboard ordering uses public RP, while pending or missing public values never substitute hidden rating', async () => {
    const { db, sqlite } = await createTestDatabase()
    try {
      await db.insert(seasons).values({ id: 's9', name: 'Season 9', seasonNumber: 9, startsAt: 1000, active: true, ratingSystem: 'rp', publicReadsEnabled: true })
      const rows = [
        { playerId: 'high-hidden', mode: 'duel' as const, mu: 70, sigma: 3, gamesPlayed: 20, wins: 10, lastPlayedAt: 1500, publicRating: 750 },
        { playerId: 'high-public', mode: 'duel' as const, mu: 10, sigma: 3, gamesPlayed: 20, wins: 10, lastPlayedAt: 1500, publicRating: 1200 },
      ]
      const data = await buildPlayerLeaderboardImageData(db, 'duel', rows)
      expect(data.rows.map(row => row.playerId)).toEqual(['high-public', 'high-hidden'])
      expect(data.rows.map(row => row.displayRating)).toEqual([1200, 750])
      expect(await renderPlayerLeaderboardSvg(data)).toContain('>RP</text>')
      await expect(buildPlayerLeaderboardImageData(db, 'duel', [{ ...rows[0]!, publicRating: undefined }])).rejects.toThrow('incomplete')
      await db.update(seasons).set({ publicReadsEnabled: false })
      await expect(buildPlayerLeaderboardImageData(db, 'duel', rows)).rejects.toThrow('not ready')
      expect(formatPublicRatingSnapshotChange({ ratingSystem: 'rp', publicRatingBefore: 750.49, publicRatingAfter: 750.51, publicRatingReady: true })).toBe('`+1 RP → 751 RP`')
      expect(formatPublicRatingSnapshotChange({ ratingSystem: 'rp', publicRatingBefore: 750.49, publicRatingAfter: 750.48, publicRatingReady: true })).toBe('`750 RP`')
      expect(formatPublicRatingSnapshotChange({ ratingSystem: 'rp', publicRatingReady: false })).toBe('`Rating pending`')
    }
    finally { sqlite.close() }
  })
})
