import { playerRatings, players, seasonPeakRanks, seasons } from '@civup/db'
import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { buildPlayerLeaderboardImageData, renderPlayerLeaderboardSvg } from '../../src/services/leaderboard/image.ts'
import { previewRankedRoles, summarizeRankedPreview, syncRankedRoles } from '../../src/services/ranked/role-sync.ts'
import { rankedPreviewEmbeds } from '../../src/embeds/ranked-preview.ts'
import { formatPublicRatingSnapshotChange } from '../../src/embeds/rating-change.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

describe('public rank integration', () => {
  test('fixed RP ranks retain global qualification gates and independent mode ranks', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    try {
      await db.insert(seasons).values({ id: 's9', name: 'Season 9', seasonNumber: 9, startsAt: 1000, active: true, ratingSystem: 'rp', publicReadsEnabled: true, isolatedRatingsEnabled: true })
      const cases = [
        { games: 3.99, tier: 'tier5', qualified: false },
        { games: 4, tier: 'tier4', qualified: true },
        { games: 5.99, tier: 'tier4', qualified: true },
        { games: 6, tier: 'tier3', qualified: true },
        { games: 15.99, tier: 'tier3', qualified: true },
        { games: 16, tier: 'tier2', qualified: true },
        { games: 17.99, tier: 'tier2', qualified: true },
        { games: 18, tier: 'tier1', qualified: true },
        { games: 18, tier: 'tier2', qualified: true, quality: false },
      ]
      const ids = cases.map((_, index) => `10000000000000000${index}`)
      for (const [index, { games, quality }] of cases.entries()) {
        await db.insert(players).values({ id: ids[index]!, displayName: String(games), createdAt: 0 })
        await db.insert(playerRatings).values([
          { playerId: ids[index]!, mode: 'global', mu: 10, sigma: 3, gamesPlayed: 40, effectiveGames: games, publicRating: 1600, winsVsTier1: quality === false ? 0 : 1, winsVsTier2Plus: 4, lastPlayedAt: 1500 },
          { playerId: ids[index]!, mode: 'duel', mu: 10, sigma: 3, gamesPlayed: 20, effectiveGames: 20, publicRating: 1300, lastPlayedAt: 1500 },
        ])
      }
      const result = await previewRankedRoles({ db, kv, guildId: 'guild', now: 2000 })
      const rows = ids.map(id => result.playerPreviews.find(player => player.playerId === id)!)
      for (const [index, row] of rows.entries()) {
        expect(row.managed).toBe(cases[index]!.qualified)
        expect(row.assignment.tier).toBe(cases[index]!.tier)
      }
      expect(rows.every(row => row.ladderTiers.duel === 'tier2')).toBe(true)
      expect(rows.every(row => row.globalScore === 1600)).toBe(true)
      const summary = await summarizeRankedPreview({ db, kv, guildId: 'guild', now: 2000 })
      const ladder = JSON.stringify(rankedPreviewEmbeds(summary))
      expect(summary.ratingSystem).toBe('rp')
      expect(ladder).toContain('Role 4 III')
      expect(ladder).toContain('700–799 RP')
      expect(ladder).toContain('1500+ RP')
      expect(ladder).not.toContain('Top ')
      await db.update(seasons).set({ publicReadsEnabled: false }).where(eq(seasons.id, 's9'))
      const shadow = await syncRankedRoles({ db, kv, guildId: 'guild', now: 2000, applyDiscord: true })
      expect(shadow.appliedDiscordChanges).toBe(0)
      expect(shadow.playerPreviews.filter(row => ids.slice(0, 4).includes(row.playerId)).every(row => !row.qualified)).toBe(true)
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
      expect(formatPublicRatingSnapshotChange({ ratingSystem: 'rp', publicRatingBefore: 750.49, publicRatingAfter: 750.51, publicRatingReady: true })).toBe('` +1` 📈 `( 751)`')
      expect(formatPublicRatingSnapshotChange({ ratingSystem: 'rp', publicRatingBefore: 750.49, publicRatingAfter: 750.48, publicRatingReady: true })).toBe('` +0` 📈 `( 750)`')
      expect(formatPublicRatingSnapshotChange({ ratingSystem: 'rp', publicRatingReady: false })).toBe('`Rating pending`')
    }
    finally { sqlite.close() }
  })
})
