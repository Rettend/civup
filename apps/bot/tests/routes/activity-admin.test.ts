<<<<<<< New base: fix: mod resolve
import type { Database as SqliteDatabase } from 'bun:sqlite'
import type { Env } from '../../src/env.ts'
import { matchBans, matches, matchParticipants, playerRatings, players } from '@civup/db'
import {
  CIVUP_ACTIVITY_GUILD_ID_HEADER,
  CIVUP_ACTIVITY_GUILD_PERMISSIONS_HEADER,
  CIVUP_ACTIVITY_USER_ID_HEADER,
  CIVUP_INTERNAL_SECRET_HEADER,
} from '@civup/utils'
import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { registerActivityAdminRoutes } from '../../src/routes/activity-admin.ts'
import { createSqliteD1Database } from '../helpers/d1.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const SECRET = 'activity-admin-test-secret'
const GUILD_ID = '1234044388733095946'
const ADMIN_USER_ID = 'admin-user'
const openDatabases: SqliteDatabase[] = []

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close()
})

describe('Activity admin routes', () => {
  test('requires authentication and fails closed for non-admins', async () => {
    const harness = await createHarness()

    const unauthenticated = await harness.request('/api/activity/admin/player-data-export')
    expect(unauthenticated.status).toBe(401)
    expect(unauthenticated.headers.get('Cache-Control')).toBe('no-store')

    const unauthenticatedEstimate = await harness.request('/api/activity/admin/player-data-export-estimate')
    expect(unauthenticatedEstimate.status).toBe(401)
    expect(unauthenticatedEstimate.headers.get('Cache-Control')).toBe('no-store')

    const capabilities = await harness.request('/api/activity/admin/capabilities', 'ordinary-user', '0')
    expect(capabilities.status).toBe(200)
    expect(await capabilities.json()).toEqual({ autosaveCatalog: false, playerDataExport: false })

    const forbidden = await harness.request('/api/activity/admin/player-data-export', 'ordinary-user', '0')
    expect(forbidden.status).toBe(403)

    const forbiddenEstimate = await harness.request('/api/activity/admin/player-data-export-estimate', 'ordinary-user', '0')
    expect(forbiddenEstimate.status).toBe(403)

    const wrongGuild = await harness.request('/api/activity/admin/capabilities', 'other-guild-admin', '32', '999999999999999999')
    expect(await wrongGuild.json()).toEqual({ autosaveCatalog: false, playerDataExport: false })
  })

  test('recognizes Administrator and Manage Server permissions', async () => {
    const harness = await createHarness()

    for (const [userId, permissions] of [['administrator', '8'], ['manage-server', '32']] as const) {
      const capabilities = await harness.request('/api/activity/admin/capabilities', userId, permissions)
      expect(capabilities.status).toBe(200)
      expect(await capabilities.json()).toEqual({ autosaveCatalog: true, playerDataExport: true })

      const data = await harness.request('/api/activity/admin/player-data-export', userId, permissions)
      expect(data.status).toBe(200)
      expect((await data.json() as { phase: string }).phase).toBe('players')
    }
  })

  test('rejects malformed and unbounded cursors', async () => {
    const harness = await createHarness()
    const malformed = await harness.request('/api/activity/admin/player-data-export?cursor=not!base64', ADMIN_USER_ID)
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ error: 'Invalid player data export cursor' })

    const oversized = await harness.request(`/api/activity/admin/player-data-export?cursor=${'a'.repeat(1025)}`, ADMIN_USER_ID)
    expect(oversized.status).toBe(400)

    const futureCursor = encodeCursor({
      version: 1,
      generatedAt: Date.now() + 120_000,
      cutoffAt: Date.now() + 120_000,
      phase: 'matches',
      lastParentId: null,
    })
    const future = await harness.request(`/api/activity/admin/player-data-export?cursor=${futureCursor}`, ADMIN_USER_ID)
    expect(future.status).toBe(400)
  })

  test('estimates export capacity from row ID upper bounds without counting tables', async () => {
    const harness = await createHarness()
    await seedPagedExport(harness.db)

    const response = await harness.request('/api/activity/admin/player-data-export-estimate', ADMIN_USER_ID)
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({
      version: 1,
      estimatedAt: expect.any(Number),
      rows: {
        players: 54,
        ratings: 53,
        matches: 54,
        participants: 53,
        storedBans: 1,
      },
      dataPageRequests: 4,
      workerRequests: 8,
      d1RowsRead: {
        lowEstimate: 330,
        highEstimate: 1_100,
      },
      dailyFreeAllowance: {
        workerRequests: 100_000,
        d1RowsRead: 5_000_000,
      },
    })
  })

  test('paginates without gaps, transitions phases, bounds children, and projects safe fields', async () => {
    const harness = await createHarness()
    await seedPagedExport(harness.db)

    const playerIds: string[] = []
    const matchIds: string[] = []
    const ratingKeys: string[] = []
    const participantKeys: string[] = []
    const phases: string[] = []
    const recoveredBans: Array<{ matchId: string, civId: string, bannedBy: string, phase: number }> = []
    let generatedAt: number | null = null
    let cutoffAt: number | null = null
    let cursor: string | null = null

    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const path = cursor == null
        ? '/api/activity/admin/player-data-export'
        : `/api/activity/admin/player-data-export?cursor=${encodeURIComponent(cursor)}`
      const response = await harness.request(path, ADMIN_USER_ID)
      expect(response.status).toBe(200)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      const page = await response.json() as Record<string, any>
      phases.push(page.phase)

      generatedAt ??= page.generatedAt
      cutoffAt ??= page.cutoffAt
      expect(page.generatedAt).toBe(generatedAt)
      expect(page.cutoffAt).toBe(cutoffAt)
      expect(JSON.stringify(page)).not.toContain('privateRawDraftMarker')
      expect(JSON.stringify(page)).not.toContain('avatar.example/private')
      expect(JSON.stringify(page)).not.toContain('draftData')

      if (page.phase === 'players') {
        const parentIds = new Set<string>(page.players.map((row: { id: string }) => row.id))
        expect(page.players.length).toBeLessThanOrEqual(50)
        expect(page.players.every((row: Record<string, unknown>) => (
          Object.keys(row).sort().join(',') === 'createdAt,displayName,id'
        ))).toBe(true)
        expect(page.ratings.every((row: Record<string, unknown>) => (
          parentIds.has(row.playerId as string)
          && Object.keys(row).sort().join(',') === 'gamesPlayed,lastPlayedAt,mode,mu,playerId,sigma,wins'
        ))).toBe(true)
        for (const row of page.players) playerIds.push(row.id)
        for (const row of page.ratings) ratingKeys.push(`${row.playerId}:${row.mode}`)
      }
      else {
        const parentIds = new Set<string>(page.matches.map((row: { id: string }) => row.id))
        expect(page.matches.length).toBeLessThanOrEqual(50)
        expect(page.matches.every((row: Record<string, unknown>) => (
          Object.keys(row).sort().join(',') === 'completedAt,createdAt,gameMode,id,isOld,seasonId,status'
        ))).toBe(true)
        expect(page.participants.every((row: Record<string, unknown>) => (
          parentIds.has(row.matchId as string)
          && Object.keys(row).sort().join(',') === 'civId,matchId,placement,playerId,ratingAfterMu,ratingAfterSigma,ratingBeforeMu,ratingBeforeSigma,team'
        ))).toBe(true)
        expect(page.bans.every((row: Record<string, unknown>) => parentIds.has(row.matchId as string))).toBe(true)
        for (const row of page.matches) matchIds.push(row.id)
        for (const row of page.participants) participantKeys.push(`${row.matchId}:${row.playerId}`)
        for (const row of page.bans) recoveredBans.push(row)
      }

      cursor = page.nextCursor
      if (cursor == null) break
    }

    expect(phases).toEqual(['players', 'players', 'matches', 'matches'])
    expect(playerIds).toHaveLength(53)
    expect(new Set(playerIds).size).toBe(53)
    expect(playerIds).not.toContain('player-999')
    expect(ratingKeys).toHaveLength(53)
    expect(new Set(ratingKeys).size).toBe(53)
    expect(matchIds).toHaveLength(53)
    expect(new Set(matchIds).size).toBe(53)
    expect(matchIds).not.toContain('match-999')
    expect(participantKeys).toHaveLength(53)
    expect(new Set(participantKeys).size).toBe(53)
    expect(recoveredBans.filter(row => row.matchId === 'match-000')).toEqual([
      { matchId: 'match-000', civId: 'civ-table-and-draft', bannedBy: 'player-000', phase: 1 },
      { matchId: 'match-000', civId: 'civ-draft-only', bannedBy: 'player-001', phase: 2 },
    ])
  })
})

async function createHarness() {
  const { db, sqlite } = await createTestDatabase()
  openDatabases.push(sqlite)
  const app = new Hono<Env>()
  registerActivityAdminRoutes(app)
  const env: Env['Bindings'] = {
    DB: createSqliteD1Database(sqlite),
    KV: createTestKv(),
    DISCORD_APPLICATION_ID: '111111111111111111',
    DISCORD_PUBLIC_KEY: 'a'.repeat(64),
    DISCORD_TOKEN: 'token',
    CIVUP_SECRET: SECRET,
    ALLOWED_DISCORD_GUILD_ID: GUILD_ID,
  }

  return {
    db,
    request(path: string, userId?: string, permissions = '8', guildId = GUILD_ID) {
      const headers = new Headers()
      if (userId) {
        headers.set(CIVUP_INTERNAL_SECRET_HEADER, SECRET)
        headers.set(CIVUP_ACTIVITY_USER_ID_HEADER, userId)
        headers.set(CIVUP_ACTIVITY_GUILD_ID_HEADER, guildId)
        headers.set(CIVUP_ACTIVITY_GUILD_PERMISSIONS_HEADER, permissions)
      }
      return app.fetch(new Request(`https://bot.test${path}`, { headers }), env)
    },
  }
}

async function seedPagedExport(db: Awaited<ReturnType<typeof createTestDatabase>>['db']) {
  const now = Date.now()
  const playerRows = Array.from({ length: 53 }, (_value, index) => ({
    id: `player-${String(index).padStart(3, '0')}`,
    displayName: `Player ${index}`,
    avatarUrl: index === 0 ? 'https://avatar.example/private' : null,
    createdAt: 1_700_000_000_000 + index,
  }))
  playerRows.push({ id: 'player-999', displayName: 'Future Player', avatarUrl: null, createdAt: now + 120_000 })
  await db.insert(players).values(playerRows)

  await db.insert(playerRatings).values(Array.from({ length: 53 }, (_value, index) => ({
    playerId: `player-${String(index).padStart(3, '0')}`,
    mode: 'ffa',
    mu: 25 + index / 10,
    sigma: 8,
    gamesPlayed: index,
    wins: index % 4,
    importedGames: 1000 + index,
    effectiveGames: index,
    winsVsTier1: 1,
    winsVsTier2Plus: 2,
    effectiveWinsVsTier1: 1,
    effectiveWinsVsTier2Plus: 2,
    lastPlayedAt: 1_700_100_000_000 + index,
  })))

  const matchRows = Array.from({ length: 53 }, (_value, index) => ({
    id: `match-${String(index).padStart(3, '0')}`,
    gameMode: 'ffa',
    status: 'completed',
    isOld: index % 2 === 0,
    seasonId: null,
    draftData: index === 0
      ? JSON.stringify({
          privateRawDraftMarker: true,
          state: {
            seats: [{ playerId: 'player-000' }, { playerId: 'player-001' }],
            bans: [
              { civId: 'civ-table-and-draft', seatIndex: 0, stepIndex: 1 },
              { civId: 'civ-draft-only', seatIndex: 1, stepIndex: 2 },
              'stringified primitive',
              null,
              { civId: 'civ-negative-index', seatIndex: -1, stepIndex: 3 },
              { civId: 'civ-string-index', seatIndex: '0', stepIndex: 4 },
            ],
          },
        })
      : index === 1
        ? '{malformed legacy draft'
      : null,
    createdAt: 1_700_200_000_000 + index,
    completedAt: 1_700_300_000_000 + index,
  }))
  matchRows.push({
    id: 'match-999',
    gameMode: 'ffa',
    status: 'completed',
    isOld: false,
    seasonId: null,
    draftData: null,
    createdAt: now + 120_000,
    completedAt: null,
  })
  await db.insert(matches).values(matchRows)

  await db.insert(matchParticipants).values(Array.from({ length: 53 }, (_value, index) => ({
    matchId: `match-${String(index).padStart(3, '0')}`,
    playerId: `player-${String(index).padStart(3, '0')}`,
    team: null,
    civId: `civ-${index}`,
    placement: index % 6 + 1,
    ratingBeforeMu: 24,
    ratingBeforeSigma: 8,
    ratingAfterMu: 25,
    ratingAfterSigma: 7.9,
  })))
  await db.insert(matchBans).values({
    matchId: 'match-000',
    civId: 'civ-table-and-draft',
    bannedBy: 'player-000',
    phase: 1,
  })
}

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}
|||||||
=======
import type { Database as SqliteDatabase } from 'bun:sqlite'
import type { Env } from '../../src/env.ts'
import { matchBans, matches, matchParticipants, playerRatings, players } from '@civup/db'
import { CIVUP_ACTIVITY_USER_ID_HEADER, CIVUP_INTERNAL_SECRET_HEADER } from '@civup/utils'
import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { registerActivityAdminRoutes } from '../../src/routes/activity-admin.ts'
import { createSqliteD1Database } from '../helpers/d1.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const SECRET = 'activity-admin-test-secret'
const DEFAULT_ADMIN_ID = '361534796830081024'
const openDatabases: SqliteDatabase[] = []

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close()
})

describe('Activity admin routes', () => {
  test('requires authentication and fails closed for non-admins', async () => {
    const harness = await createHarness()

    const unauthenticated = await harness.request('/api/activity/admin/player-data-export')
    expect(unauthenticated.status).toBe(401)
    expect(unauthenticated.headers.get('Cache-Control')).toBe('no-store')

    const capabilities = await harness.request('/api/activity/admin/capabilities', 'ordinary-user')
    expect(capabilities.status).toBe(200)
    expect(await capabilities.json()).toEqual({ autosaveCatalog: false, playerDataExport: false })

    const forbidden = await harness.request('/api/activity/admin/player-data-export', 'ordinary-user')
    expect(forbidden.status).toBe(403)
  })

  test('recognizes both the default and configured Activity data admins', async () => {
    const harness = await createHarness(' configured-admin, another-admin ')

    for (const userId of [DEFAULT_ADMIN_ID, 'configured-admin']) {
      const capabilities = await harness.request('/api/activity/admin/capabilities', userId)
      expect(capabilities.status).toBe(200)
      expect(await capabilities.json()).toEqual({ autosaveCatalog: true, playerDataExport: true })

      const data = await harness.request('/api/activity/admin/player-data-export', userId)
      expect(data.status).toBe(200)
      expect((await data.json() as { phase: string }).phase).toBe('players')
    }
  })

  test('rejects malformed and unbounded cursors', async () => {
    const harness = await createHarness()
    const malformed = await harness.request('/api/activity/admin/player-data-export?cursor=not!base64', DEFAULT_ADMIN_ID)
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ error: 'Invalid player data export cursor' })

    const oversized = await harness.request(`/api/activity/admin/player-data-export?cursor=${'a'.repeat(1025)}`, DEFAULT_ADMIN_ID)
    expect(oversized.status).toBe(400)

    const futureCursor = encodeCursor({
      version: 1,
      generatedAt: Date.now() + 120_000,
      cutoffAt: Date.now() + 120_000,
      phase: 'matches',
      lastParentId: null,
    })
    const future = await harness.request(`/api/activity/admin/player-data-export?cursor=${futureCursor}`, DEFAULT_ADMIN_ID)
    expect(future.status).toBe(400)
  })

  test('paginates without gaps, transitions phases, bounds children, and projects safe fields', async () => {
    const harness = await createHarness()
    await seedPagedExport(harness.db)

    const playerIds: string[] = []
    const matchIds: string[] = []
    const ratingKeys: string[] = []
    const participantKeys: string[] = []
    const phases: string[] = []
    const recoveredBans: Array<{ matchId: string, civId: string, bannedBy: string, phase: number }> = []
    let generatedAt: number | null = null
    let cutoffAt: number | null = null
    let cursor: string | null = null

    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      const path = cursor == null
        ? '/api/activity/admin/player-data-export'
        : `/api/activity/admin/player-data-export?cursor=${encodeURIComponent(cursor)}`
      const response = await harness.request(path, DEFAULT_ADMIN_ID)
      expect(response.status).toBe(200)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      const page = await response.json() as Record<string, any>
      phases.push(page.phase)

      generatedAt ??= page.generatedAt
      cutoffAt ??= page.cutoffAt
      expect(page.generatedAt).toBe(generatedAt)
      expect(page.cutoffAt).toBe(cutoffAt)
      expect(JSON.stringify(page)).not.toContain('privateRawDraftMarker')
      expect(JSON.stringify(page)).not.toContain('avatar.example/private')
      expect(JSON.stringify(page)).not.toContain('draftData')

      if (page.phase === 'players') {
        const parentIds = new Set<string>(page.players.map((row: { id: string }) => row.id))
        expect(page.players.length).toBeLessThanOrEqual(50)
        expect(page.players.every((row: Record<string, unknown>) => (
          Object.keys(row).sort().join(',') === 'createdAt,displayName,id'
        ))).toBe(true)
        expect(page.ratings.every((row: Record<string, unknown>) => (
          parentIds.has(row.playerId as string)
          && Object.keys(row).sort().join(',') === 'gamesPlayed,lastPlayedAt,mode,mu,playerId,sigma,wins'
        ))).toBe(true)
        for (const row of page.players) playerIds.push(row.id)
        for (const row of page.ratings) ratingKeys.push(`${row.playerId}:${row.mode}`)
      }
      else {
        const parentIds = new Set<string>(page.matches.map((row: { id: string }) => row.id))
        expect(page.matches.length).toBeLessThanOrEqual(50)
        expect(page.matches.every((row: Record<string, unknown>) => (
          Object.keys(row).sort().join(',') === 'completedAt,createdAt,gameMode,id,isOld,seasonId,status'
        ))).toBe(true)
        expect(page.participants.every((row: Record<string, unknown>) => (
          parentIds.has(row.matchId as string)
          && Object.keys(row).sort().join(',') === 'civId,matchId,placement,playerId,ratingAfterMu,ratingAfterSigma,ratingBeforeMu,ratingBeforeSigma,team'
        ))).toBe(true)
        expect(page.bans.every((row: Record<string, unknown>) => parentIds.has(row.matchId as string))).toBe(true)
        for (const row of page.matches) matchIds.push(row.id)
        for (const row of page.participants) participantKeys.push(`${row.matchId}:${row.playerId}`)
        for (const row of page.bans) recoveredBans.push(row)
      }

      cursor = page.nextCursor
      if (cursor == null) break
    }

    expect(phases).toEqual(['players', 'players', 'matches', 'matches'])
    expect(playerIds).toHaveLength(53)
    expect(new Set(playerIds).size).toBe(53)
    expect(playerIds).not.toContain('player-999')
    expect(ratingKeys).toHaveLength(53)
    expect(new Set(ratingKeys).size).toBe(53)
    expect(matchIds).toHaveLength(53)
    expect(new Set(matchIds).size).toBe(53)
    expect(matchIds).not.toContain('match-999')
    expect(participantKeys).toHaveLength(53)
    expect(new Set(participantKeys).size).toBe(53)
    expect(recoveredBans.filter(row => row.matchId === 'match-000')).toEqual([
      { matchId: 'match-000', civId: 'civ-table-and-draft', bannedBy: 'player-000', phase: 1 },
      { matchId: 'match-000', civId: 'civ-draft-only', bannedBy: 'player-001', phase: 2 },
    ])
  })
})

async function createHarness(configuredAdminIds?: string) {
  const { db, sqlite } = await createTestDatabase()
  openDatabases.push(sqlite)
  const app = new Hono<Env>()
  registerActivityAdminRoutes(app)
  const env: Env['Bindings'] = {
    DB: createSqliteD1Database(sqlite),
    KV: createTestKv(),
    DISCORD_APPLICATION_ID: '111111111111111111',
    DISCORD_PUBLIC_KEY: 'a'.repeat(64),
    DISCORD_TOKEN: 'token',
    CIVUP_SECRET: SECRET,
    AUTOSAVE_ADMIN_USER_IDS: configuredAdminIds,
  }

  return {
    db,
    request(path: string, userId?: string) {
      const headers = new Headers()
      if (userId) {
        headers.set(CIVUP_INTERNAL_SECRET_HEADER, SECRET)
        headers.set(CIVUP_ACTIVITY_USER_ID_HEADER, userId)
      }
      return app.fetch(new Request(`https://bot.test${path}`, { headers }), env)
    },
  }
}

async function seedPagedExport(db: Awaited<ReturnType<typeof createTestDatabase>>['db']) {
  const now = Date.now()
  const playerRows = Array.from({ length: 53 }, (_value, index) => ({
    id: `player-${String(index).padStart(3, '0')}`,
    displayName: `Player ${index}`,
    avatarUrl: index === 0 ? 'https://avatar.example/private' : null,
    createdAt: 1_700_000_000_000 + index,
  }))
  playerRows.push({ id: 'player-999', displayName: 'Future Player', avatarUrl: null, createdAt: now + 120_000 })
  await db.insert(players).values(playerRows)

  await db.insert(playerRatings).values(Array.from({ length: 53 }, (_value, index) => ({
    playerId: `player-${String(index).padStart(3, '0')}`,
    mode: 'ffa',
    mu: 25 + index / 10,
    sigma: 8,
    gamesPlayed: index,
    wins: index % 4,
    importedGames: 1000 + index,
    effectiveGames: index,
    winsVsTier1: 1,
    winsVsTier2Plus: 2,
    effectiveWinsVsTier1: 1,
    effectiveWinsVsTier2Plus: 2,
    lastPlayedAt: 1_700_100_000_000 + index,
  })))

  const matchRows = Array.from({ length: 53 }, (_value, index) => ({
    id: `match-${String(index).padStart(3, '0')}`,
    gameMode: 'ffa',
    status: 'completed',
    isOld: index % 2 === 0,
    seasonId: null,
    draftData: index === 0
      ? JSON.stringify({
          privateRawDraftMarker: true,
          state: {
            seats: [{ playerId: 'player-000' }, { playerId: 'player-001' }],
            bans: [
              { civId: 'civ-table-and-draft', seatIndex: 0, stepIndex: 1 },
              { civId: 'civ-draft-only', seatIndex: 1, stepIndex: 2 },
              'stringified primitive',
              null,
              { civId: 'civ-negative-index', seatIndex: -1, stepIndex: 3 },
              { civId: 'civ-string-index', seatIndex: '0', stepIndex: 4 },
            ],
          },
        })
      : index === 1
        ? '{malformed legacy draft'
      : null,
    createdAt: 1_700_200_000_000 + index,
    completedAt: 1_700_300_000_000 + index,
  }))
  matchRows.push({
    id: 'match-999',
    gameMode: 'ffa',
    status: 'completed',
    isOld: false,
    seasonId: null,
    draftData: null,
    createdAt: now + 120_000,
    completedAt: null,
  })
  await db.insert(matches).values(matchRows)

  await db.insert(matchParticipants).values(Array.from({ length: 53 }, (_value, index) => ({
    matchId: `match-${String(index).padStart(3, '0')}`,
    playerId: `player-${String(index).padStart(3, '0')}`,
    team: null,
    civId: `civ-${index}`,
    placement: index % 6 + 1,
    ratingBeforeMu: 24,
    ratingBeforeSigma: 8,
    ratingAfterMu: 25,
    ratingAfterSigma: 7.9,
  })))
  await db.insert(matchBans).values({
    matchId: 'match-000',
    civId: 'civ-table-and-draft',
    bannedBy: 'player-000',
    phase: 1,
  })
}

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}
>>>>>>> Current commit: chore: cleanup and simplify setup
