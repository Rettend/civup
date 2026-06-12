import { matches, playerRatingEvents, playerRatings, players } from '@civup/db'
import { displayRating } from '@civup/rating'
import { describe, expect, test } from 'bun:test'
import { buildRankCommandImage } from '../../src/commands/rank.ts'
import { buildRankGraphImageData, renderRankGraphSvg } from '../../src/services/player/rank-graph.ts'
import { setRankedRoleCurrentRoles } from '../../src/services/ranked/roles.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const NOW = 1_700_000_000_000
const HERO_ID = '100010000000000099'

describe('rank graph image', () => {
  test('builds recent rating points and rank bands', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedConfiguredRoles(kv)
      await seedModeRatings(db, 'ffa', 20)
      await seedPlayer(db, HERO_ID, 'Graph Hero')
      await seedRatingEvents(db, HERO_ID, 'ffa', 5)

      const data = await buildRankGraphImageData(db, kv, 'guild-1', [HERO_ID], {
        scope: 'ffa',
        gameLimit: 3,
      })

      const series = data.series[0]
      expect(series?.displayName).toBe('Graph Hero')
      expect(series?.games).toBe(3)
      expect(series?.points.map(point => point.x)).toEqual([0, 1, 2, 3])
      expect(series?.points.map(point => point.rating)).toEqual([
        Math.round(displayRating(27, 6)),
        Math.round(displayRating(28, 6)),
        Math.round(displayRating(29, 6)),
        Math.round(displayRating(30, 6)),
      ])
      expect(data.bands.map(band => band.tier)).toContain('tier1')

      const svg = await renderRankGraphSvg(data)
      expect(svg).toContain('FFA History')
      expect(svg).toContain('LAST 3 GAMES')
      expect(svg).not.toContain('Red Death')
    }
    finally {
      sqlite.close()
    }
  })

  test('builds a png command image', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedConfiguredRoles(kv)
      await seedModeRatings(db, 'ffa', 20)
      await seedPlayer(db, HERO_ID, 'Graph Hero')
      await seedRatingEvents(db, HERO_ID, 'ffa', 5)

      const result = await buildRankCommandImage(db, kv, 'guild-1', [HERO_ID], {
        scope: 'ffa',
        gameLimit: 3,
      })

      expect('content' in result ? result.content : undefined).toBeUndefined()
      expect('image' in result ? isPng(result.image.data) : false).toBe(true)
      expect('image' in result ? result.image.filename : '').toBe('rank-ffa-3.png')
    }
    finally {
      sqlite.close()
    }
  })

  test('returns a message when no ranked history exists', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    try {
      await seedConfiguredRoles(kv)
      await seedPlayer(db, HERO_ID, 'Graph Hero')

      const result = await buildRankCommandImage(db, kv, 'guild-1', [HERO_ID], {
        scope: 'overall',
        gameLimit: 20,
      })

      expect('content' in result ? result.content : undefined).toBe('No ranked games found for this view.')
    }
    finally {
      sqlite.close()
    }
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

async function seedModeRatings(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  mode: 'ffa',
  count: number,
): Promise<void> {
  for (let index = 1; index <= count; index++) {
    const playerId = `10001000000000${String(index).padStart(4, '0')}`
    await seedPlayer(db, playerId, `FFA ${index}`)
    await db.insert(playerRatings).values({
      playerId,
      mode,
      mu: 45 - index,
      sigma: 6,
      gamesPlayed: 12,
      wins: Math.max(0, 12 - index),
      lastPlayedAt: NOW,
    })
  }
}

async function seedPlayer(
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

async function seedRatingEvents(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  playerId: string,
  mode: 'ffa',
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index++) {
    const matchId = `rank-graph-${index}`
    await db.insert(matches).values({
      id: matchId,
      gameMode: 'ffa',
      status: 'completed',
      createdAt: NOW + index,
      completedAt: NOW + index,
    })
    await db.insert(playerRatingEvents).values({
      matchId,
      playerId,
      mode,
      gameMode: 'ffa',
      ratingBeforeMu: 25 + index,
      ratingBeforeSigma: 6,
      ratingAfterMu: 26 + index,
      ratingAfterSigma: 6,
      gamesDelta: 1,
      winsDelta: index % 2 === 0 ? 1 : 0,
      importedGamesDelta: 0,
      effectiveGamesDelta: 1,
      winsVsTier1Delta: 0,
      winsVsTier2PlusDelta: 0,
      effectiveWinsVsTier1Delta: 0,
      effectiveWinsVsTier2PlusDelta: 0,
      matchCreatedAt: NOW + index,
      matchCompletedAt: NOW + index,
      updatedAt: NOW + index,
    })
  }
}

function isPng(bytes: Uint8Array): boolean {
  return Array.from(bytes.slice(0, 8)).join(',') === '137,80,78,71,13,10,26,10'
}
