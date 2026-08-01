import type { Env } from '../../src/env.ts'
import type { PublicCivLeaderboardScope, PublicLeaderboardResponse, PublicPlayerLeaderboardMode } from '@civup/utils'
import { players } from '@civup/db'
import { CIVUP_INTERNAL_SECRET_HEADER, isPublicLeaderboardResponse, PUBLIC_CIV_LEADERBOARD_SCOPES, PUBLIC_PLAYER_LEADERBOARD_MODES } from '@civup/utils'
import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { registerPublicLeaderboardRoutes, publicLeaderboardResponseCacheKey } from '../../src/routes/public-leaderboards.ts'
import { civLeaderboardSnapshotKey } from '../../src/services/leaderboard/civ-snapshot.ts'
import {
  assertPublicLeaderboardPrivacy,
  PUBLIC_LEADERBOARD_PAYLOAD_MAX_BYTES,
  PublicLeaderboardPayloadTooLargeError,
  serializePublicLeaderboardResponse,
} from '../../src/services/leaderboard/public.ts'
import { leaderboardModeSnapshotKey } from '../../src/services/leaderboard/snapshot.ts'
import { createStatsContext } from '../../src/services/stats/context.ts'
import { getStoredPlayerProfiles } from '../../src/services/player/profile.ts'
import { createSqliteD1Database } from '../helpers/d1.ts'
import { createTestDatabase } from '../helpers/test-env.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'

const SECRET = 'public-leaderboard-secret'
const PRIMARY = '1234044388733095946'
const PARTNER = '2234044388733095946'
const REMOVED = '3234044388733095946'
const ACTIVE = '4234044388733095946'
const STALE = '5234044388733095946'
const MISSING_PROFILE = '6234044388733095946'
const SNOWFLAKE_NAME = '7234044388733095946'
const BELOW_MINIMUM = '8234044388733095946'

const openDatabases: Array<Awaited<ReturnType<typeof createTestDatabase>>['sqlite']> = []

afterEach(() => {
  for (const sqlite of openDatabases.splice(0)) sqlite.close()
})

describe('public leaderboard bot route', () => {
  test('requires internal auth and validates current approval before cache lookup', async () => {
    const harness = await createHarness({ approved: [PRIMARY, PARTNER] })

    const unauthorized = await harness.request(PRIMARY, false)
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.headers.get('Cache-Control')).toBe('no-store')

    const rejected = await harness.request(REMOVED)
    expect(rejected.status).toBe(403)
    expect(rejected.headers.get('Cache-Control')).toBe('no-store')

    const staleKey = publicLeaderboardResponseCacheKey([PRIMARY, REMOVED], REMOVED)
    await harness.trackedKv.kv.put(staleKey, JSON.stringify(emptyPayload(REMOVED)))
    harness.env.ALLOWED_DISCORD_GUILD_IDS = PRIMARY
    harness.trackedKv.resetOperations()

    const removed = await harness.request(REMOVED)
    expect(removed.status).toBe(403)
    expect(harness.trackedKv.operations).toEqual([])
  })

  test('projects canonical private snapshots into a bounded display-only response and caches it', async () => {
    const harness = await createHarness({ approved: [PRIMARY, PARTNER] })
    const statsContext = createStatsContext(PRIMARY, PRIMARY)
    const now = Date.now()
    await harness.trackedKv.kv.put(`discord:guild-metadata:${PARTNER}`, JSON.stringify({ id: PARTNER, name: 'Partner League' }))
    await harness.db.insert(players).values([
      { id: ACTIVE, displayName: 'Active Challenger', avatarUrl: 'https://cdn.discordapp.com/avatars/secret/active.png', createdAt: 1 },
      { id: STALE, displayName: 'Stale Leader', avatarUrl: null, createdAt: 1 },
      { id: SNOWFLAKE_NAME, displayName: SNOWFLAKE_NAME, avatarUrl: null, createdAt: 1 },
      { id: BELOW_MINIMUM, displayName: 'Needs One More', avatarUrl: null, createdAt: 1 },
    ])
    await seedPlayerSnapshot(harness.trackedKv.kv, statsContext, 'duel', 10_001, [
      playerSource(STALE, 1325, 10, 7, now - (120 * 24 * 60 * 60 * 1_000)),
      playerSource(ACTIVE, 1300, 10, 6, now),
      playerSource(MISSING_PROFILE, 1200, 8, 4, now),
      playerSource(SNOWFLAKE_NAME, 1100, 7, 3, now),
      playerSource(BELOW_MINIMUM, 5000, 4, 4, now),
    ])
    await seedCivSnapshot(harness.trackedKv.kv, statsContext, 'all', 20_002)

    const first = await harness.request(PRIMARY)
    expect(first.status).toBe(200)
    expect(first.headers.get('Cache-Control')).toContain('max-age=300')
    const serialized = await first.text()
    const payload = JSON.parse(serialized) as PublicLeaderboardResponse
    expect(payload.version).toBe(1)
    expect(payload.server).toEqual({ id: PRIMARY, displayName: 'PPL' })
    expect(payload.servers).toEqual([{ id: PRIMARY, displayName: 'PPL' }, { id: PARTNER, displayName: 'Partner League' }])
    expect(payload.seasonPolicy).toBe('ppl-seasons')
    expect(payload.sourceSnapshots.players.duel).toBe(10_001)
    expect(payload.sourceSnapshots.civilizations.all).toBe(20_002)
    expect(payload.players.duel.rows.map(row => row.displayName)).toEqual([
      'Active Challenger',
      'Stale Leader',
      'Unknown player',
      'Unknown player',
    ])
    expect(payload.players.duel.rows[0]).toMatchObject({ rank: 1, rating: 1300, games: 10, wins: 6, winRatePct: 60 })
    expect(payload.players.duel.rows[1]?.placementAdjustment?.places).toBeGreaterThan(0)
    expect(serialized).not.toContain(ACTIVE)
    expect(serialized).not.toContain(STALE)
    expect(serialized).not.toContain('discordapp.com/avatars')
    expect(serialized).not.toContain('"mu"')
    expect(serialized).not.toContain('"sigma"')
    expect(serialized).not.toContain('lastPlayedAt')
    expect(payload.civilizations.all.rows[0]).toMatchObject({ civId: 'rome', name: 'Trajan', picks: 8, wins: 5, bans: 3 })

    const cacheKey = publicLeaderboardResponseCacheKey([PRIMARY, PARTNER], PRIMARY)
    expect(harness.trackedKv.operations).toContainEqual({ type: 'put', key: cacheKey })
    await Promise.all([
      ...PUBLIC_PLAYER_LEADERBOARD_MODES.map(mode => harness.trackedKv.kv.delete(leaderboardModeSnapshotKey(statsContext, mode))),
      ...PUBLIC_CIV_LEADERBOARD_SCOPES.map(scope => harness.trackedKv.kv.delete(civLeaderboardSnapshotKey(statsContext, scope))),
    ])
    harness.trackedKv.resetOperations()
    harness.sqlite.close()
    openDatabases.splice(openDatabases.indexOf(harness.sqlite), 1)

    const second = await harness.request(PRIMARY)
    expect(second.status).toBe(200)
    expect(await second.text()).toBe(serialized)
    expect(harness.trackedKv.operations).toEqual([{ type: 'get', key: cacheKey }])
  })

  test('returns successful unavailable boards without rebuilding missing source snapshots', async () => {
    const harness = await createHarness()
    const response = await harness.request(PRIMARY)
    const payload = await response.json<PublicLeaderboardResponse>()

    expect(response.status).toBe(200)
    expect(Object.values(payload.players).every(board => !board.available && board.rows.length === 0)).toBe(true)
    expect(Object.values(payload.civilizations).every(board => !board.available && board.rows.length === 0)).toBe(true)
    expect(Object.values(payload.sourceSnapshots.players).every(timestamp => timestamp === null)).toBe(true)
  })

  test('rejects malformed method and query surfaces with no-store errors', async () => {
    const harness = await createHarness()
    const extra = await harness.rawRequest(`/api/public/leaderboards?server=${PRIMARY}&extra=1`)
    const duplicate = await harness.rawRequest(`/api/public/leaderboards?server=${PRIMARY}&server=${PRIMARY}`)
    const method = await harness.rawRequest(`/api/public/leaderboards?server=${PRIMARY}`, 'POST')

    expect(extra.status).toBe(400)
    expect(duplicate.status).toBe(400)
    expect(method.status).toBe(405)
    expect(method.headers.get('Cache-Control')).toBe('no-store')
  })
})

describe('public leaderboard safeguards', () => {
  test('rejects forbidden fields recursively and payloads above the serialized ceiling', () => {
    const safe = emptyPayload(PRIMARY)
    expect(isPublicLeaderboardResponse(safe)).toBe(true)
    expect(isPublicLeaderboardResponse({ ...safe, players: {} })).toBe(false)
    expect(isPublicLeaderboardResponse({ ...safe, privateField: 'not public' })).toBe(false)
    expect(isPublicLeaderboardResponse({ ...safe, sourceSnapshots: { players: {}, civilizations: {} } })).toBe(false)
    expect(() => assertPublicLeaderboardPrivacy(safe)).not.toThrow()
    expect(() => assertPublicLeaderboardPrivacy({ safe: [{ nested: { avatarUrl: 'private' } }] })).toThrow(/forbidden key/)
    expect(() => assertPublicLeaderboardPrivacy({ safe: 'https://cdn.discordapp.com/avatars/123/hash.png' })).toThrow(/avatar URL/)

    safe.players.duel.rows.push({
      rank: 1,
      displayName: 'x'.repeat(PUBLIC_LEADERBOARD_PAYLOAD_MAX_BYTES),
      rating: 1000,
      games: 5,
      wins: 3,
      winRatePct: 60,
    })
    expect(() => serializePublicLeaderboardResponse(safe)).toThrow(PublicLeaderboardPayloadTooLargeError)
  })

  test('chunks large profile lookups under D1 parameter limits', async () => {
    const harness = await createHarness()
    const rows = Array.from({ length: 205 }, (_, index) => ({
      id: `${90000000000000000n + BigInt(index)}`,
      displayName: `Player ${index}`,
      avatarUrl: null,
      createdAt: 1,
    }))
    await harness.db.insert(players).values(rows)
    const profiles = await getStoredPlayerProfiles(harness.db, rows.map(row => row.id))
    expect(profiles.size).toBe(205)
    expect(profiles.get(rows[204]!.id)?.displayName).toBe('Player 204')
  })
})

async function createHarness(options: { approved?: string[] } = {}) {
  const database = await createTestDatabase()
  openDatabases.push(database.sqlite)
  const trackedKv = createTrackedKv({ trackReads: true })
  const app = new Hono<Env>()
  registerPublicLeaderboardRoutes(app)
  const approved = options.approved ?? [PRIMARY]
  const env: Env['Bindings'] = {
    DB: createSqliteD1Database(database.sqlite),
    KV: trackedKv.kv,
    CIVUP_SECRET: SECRET,
    ALLOWED_DISCORD_GUILD_ID: PRIMARY,
    ALLOWED_DISCORD_GUILD_IDS: approved.join(','),
  }
  const rawRequest = (path: string, method = 'GET', authorized = true) => {
    const headers = new Headers()
    if (authorized) headers.set(CIVUP_INTERNAL_SECRET_HEADER, SECRET)
    return app.fetch(new Request(`https://bot.test${path}`, { method, headers }), env)
  }
  return {
    ...database,
    trackedKv,
    env,
    request(serverId: string, authorized = true) {
      return rawRequest(`/api/public/leaderboards?server=${serverId}`, 'GET', authorized)
    },
    rawRequest,
  }
}

async function seedPlayerSnapshot(
  kv: KVNamespace,
  statsContext: ReturnType<typeof createStatsContext>,
  mode: PublicPlayerLeaderboardMode,
  updatedAt: number,
  rows: unknown[],
): Promise<void> {
  await kv.put(leaderboardModeSnapshotKey(statsContext, mode), JSON.stringify({ version: 4, updatedAt, rows }))
}

async function seedCivSnapshot(
  kv: KVNamespace,
  statsContext: ReturnType<typeof createStatsContext>,
  scope: PublicCivLeaderboardScope,
  updatedAt: number,
): Promise<void> {
  await kv.put(civLeaderboardSnapshotKey(statsContext, scope), JSON.stringify({
    updatedAt,
    historyInitialized: true,
    label: 'BBG Test',
    modeScope: scope,
    completedMatchCount: 12,
    rows: [
      { civId: 'rome', leaderName: 'Trajan', picks: 8, bans: 3, wins: 5, poolGames: 12, pickRatePct: 66.7, winRatePct: 62.5, banRatePct: 25 },
      { civId: 'greece', leaderName: 'Pericles', picks: 3, bans: 6, wins: 1, poolGames: 12, pickRatePct: 25, winRatePct: 33.3, banRatePct: 50 },
    ],
  }))
}

function playerSource(playerId: string, publicRating: number, gamesPlayed: number, wins: number, lastPlayedAt: number) {
  return { playerId, mu: 25, sigma: 5, publicRating, gamesPlayed, wins, lastPlayedAt }
}

function emptyPayload(serverId: string): PublicLeaderboardResponse {
  return {
    version: 1,
    generatedAt: 1,
    server: { id: serverId },
    servers: [{ id: serverId }],
    seasonPolicy: 'all-time',
    sourceSnapshots: {
      players: Object.fromEntries(PUBLIC_PLAYER_LEADERBOARD_MODES.map(mode => [mode, null])) as PublicLeaderboardResponse['sourceSnapshots']['players'],
      civilizations: Object.fromEntries(PUBLIC_CIV_LEADERBOARD_SCOPES.map(scope => [scope, null])) as PublicLeaderboardResponse['sourceSnapshots']['civilizations'],
    },
    players: Object.fromEntries(PUBLIC_PLAYER_LEADERBOARD_MODES.map(mode => [mode, { available: false, rows: [] }])) as PublicLeaderboardResponse['players'],
    civilizations: Object.fromEntries(PUBLIC_CIV_LEADERBOARD_SCOPES.map(scope => [scope, { available: false, historyInitialized: false, label: null, completedGames: 0, rows: [] }])) as PublicLeaderboardResponse['civilizations'],
  }
}
