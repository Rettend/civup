import type { Database as SqliteDatabase } from 'bun:sqlite'
import type { Env } from '../../src/env.ts'
import { matches, matchParticipants, players, sessionDirectory } from '@civup/db'
import { CIVUP_ACTIVITY_USER_ID_HEADER, CIVUP_INTERNAL_SECRET_HEADER } from '@civup/utils'
import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { registerMatchRoutes } from '../../src/routes/match.ts'
import { generateCivBlitzModResponse } from '../../src/maintenance/civblitz-maintenance.ts'
import { createSqliteD1Database } from '../helpers/d1.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const SECRET = 'civblitz-mod-download-secret'
const MATCH_ID = 'civblitz-match-1'
const openDatabases: SqliteDatabase[] = []

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close()
})

describe('CivBlitz match mod download', () => {
  test('requires authentication and match participation', async () => {
    const harness = await createHarness()

    expect((await harness.request()).status).toBe(401)
    const forbidden = await harness.request('outsider')
    expect(forbidden.status).toBe(403)
    expect(await forbidden.json()).toEqual({ error: 'Only match participants can download this mod.' })
  })

  test('returns one deterministic combined mod ZIP for a participant', async () => {
    const harness = await createHarness()
    const first = await harness.request('player-1')
    const second = await harness.request('player-1')

    expect(first.status).toBe(200)
    expect(first.headers.get('Content-Type')).toBe('application/zip')
    expect(first.headers.get('Content-Disposition')).toMatch(/^attachment; filename="civblitz-match-[a-f0-9]{12}\.zip"$/)
    expect(first.headers.get('Cache-Control')).toBe('private, no-store')
    expect(first.headers.get('ETag')).toMatch(/^"[a-f0-9-]+"$/)

    const firstBytes = new Uint8Array(await first.arrayBuffer())
    const secondBytes = new Uint8Array(await second.arrayBuffer())
    expect(firstBytes).toEqual(secondBytes)
    expect(firstBytes.slice(0, 4)).toEqual(new Uint8Array([0x50, 0x4B, 0x03, 0x04]))
    expect(Number(first.headers.get('Content-Length'))).toBe(firstBytes.byteLength)
    expect(new TextDecoder().decode(firstBytes)).toContain('CivBlitz-')
  })

  test('allows downloads while the teammate swap window is open', async () => {
    const harness = await createHarness({ phase: 'swap' })
    const response = await harness.request('player-1')

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/zip')
  })

  test('rejects BBG Expanded drafts with a safe generator error', async () => {
    const harness = await createHarness({ excludeBbgExpanded: false })
    const response = await harness.request('player-1')

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      code: 'BBG_EXPANDED_UNSUPPORTED',
      error: 'BBG Expanded CivBlitz kits are not supported because their dependency and art metadata is not bundled.',
    })
  })

  test('rejects malformed persisted draft state without throwing', async () => {
    const harness = await createHarness({ malformedDraft: true })
    const response = await harness.request('player-1')

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'The CivBlitz draft is not complete.' })
  })

  test('hides matches owned by a removed server', async () => {
    const harness = await createHarness({ guildId: '222222222222222222' })
    const response = await harness.request('player-1')

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Match not found' })
  })
})

async function createHarness(options: { phase?: 'active' | 'swap', excludeBbgExpanded?: boolean, malformedDraft?: boolean, guildId?: string } = {}) {
  const { db, sqlite } = await createTestDatabase()
  openDatabases.push(sqlite)
  await db.insert(players).values([
    { id: 'player-1', displayName: 'Player One', avatarUrl: null, createdAt: 1 },
    { id: 'outsider', displayName: 'Outsider', avatarUrl: null, createdAt: 1 },
  ])
  await db.insert(matches).values({
    id: MATCH_ID,
    guildId: options.guildId ?? '111111111111111111',
    gameMode: 'ffa',
    status: 'active',
    draftData: options.malformedDraft
      ? JSON.stringify({ civBlitz: true, state: { status: 'complete', civBlitz: { lockedKits: null } } })
      : createDraftData(options.excludeBbgExpanded ?? true),
    createdAt: 1,
  })
  await db.insert(matchParticipants).values({ matchId: MATCH_ID, playerId: 'player-1', team: null, civId: null })

  if (options.phase) {
    await db.insert(sessionDirectory).values({
      sessionId: 'session-1',
      phase: options.phase,
      mode: 'ffa',
      guildId: '111111111111111111',
      channelId: 'channel-1',
      hostId: 'player-1',
      messageId: 'message-1',
      matchId: MATCH_ID,
      version: 1,
      rosterJson: '{}',
      configJson: '{}',
      createdAt: 1,
      updatedAt: 1,
      lastActivityAt: 1,
    })
  }

  const app = new Hono<Env>()
  registerMatchRoutes(app)
  const env: Env['Bindings'] = {
    DB: createSqliteD1Database(sqlite),
    KV: createTestKv(),
    DISCORD_APPLICATION_ID: '111111111111111111',
    DISCORD_PUBLIC_KEY: 'a'.repeat(64),
    DISCORD_TOKEN: 'token',
    CIVUP_SECRET: SECRET,
    ALLOWED_DISCORD_GUILD_ID: '111111111111111111',
    MaintenanceDO: {
      idFromName(name: string) {
        return { name }
      },
      get() {
        return {
          async fetch(request: Request) {
            return generateCivBlitzModResponse(await request.json())
          },
        }
      },
    } as unknown as DurableObjectNamespace,
  }

  return {
    request(userId?: string) {
      const headers = new Headers()
      if (userId) {
        headers.set(CIVUP_INTERNAL_SECRET_HEADER, SECRET)
        headers.set(CIVUP_ACTIVITY_USER_ID_HEADER, userId)
        headers.set('X-CivUp-Activity-Guild-Id', '111111111111111111')
      }
      return app.fetch(new Request(`https://bot.test/api/match/${MATCH_ID}/civblitz/download`, { headers }), env)
    },
  }
}

function createDraftData(excludeBbgExpanded: boolean): string {
  return JSON.stringify({
    civBlitz: true,
    leaderDataVersion: 'live',
    state: {
      matchId: MATCH_ID,
      formatId: 'civblitz-ffa',
      status: 'complete',
      seats: [{ playerId: 'player-1', displayName: 'Player One', avatarUrl: null }],
      civBlitz: {
        excludeBbgExpanded,
        lockedKits: {
          0: {
            civilizationAbility: 'civblitz:civilizationAbility:gran-colombia',
            leaderAbility: 'civblitz:leaderAbility:america-teddy-roosevelt-bull-moose',
            infrastructure: 'civblitz:infrastructure:hansa',
            unit: 'civblitz:unit:mamluk',
          },
        },
      },
    },
  })
}
