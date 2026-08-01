import { players, scopedPlayerRatings as playerRatings } from '@civup/db'
import { afterEach, describe, expect, test } from 'bun:test'
import { runRankedRoleMaintenance } from '../../src/maintenance/ranked-role-maintenance.ts'
import { getCurrentRankAssignments, getRankedRolesDirtyState, markRankedRolesDirty } from '../../src/services/ranked/role-sync.ts'
import { setRankedRoleCurrentRoles } from '../../src/services/ranked/roles.ts'
import { createSqliteD1Database } from '../helpers/d1.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const GUILD_ID = '1234044388733095946'
const SECOND_GUILD_ID = '1372172102362337362'
const REMOVED_GUILD_ID = '1372172102362337363'
const NOW = 1_700_000_000_000
const ROLE_IDS = {
  tier5: '11111111111111111',
  tier4: '22222222222222222',
  tier3: '33333333333333333',
  tier2: '44444444444444444',
  tier1: '55555555555555555',
} as const
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('ranked role maintenance', () => {
  test('bounds Discord work across guilds and only clears dirty state after a full sync', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const playerIds = Array.from({ length: 17 }, (_value, index) => `103010000000000${String(index + 1).padStart(2, '0')}`)
    await setRankedRoleCurrentRoles(kv, GUILD_ID, ROLE_IDS)
    await setRankedRoleCurrentRoles(kv, SECOND_GUILD_ID, ROLE_IDS)
    await setRankedRoleCurrentRoles(kv, REMOVED_GUILD_ID, ROLE_IDS)
    await db.insert(players).values(playerIds.map((playerId, index) => ({
      id: playerId,
      displayName: `Player ${index + 1}`,
      avatarUrl: null,
      createdAt: NOW + index,
    })))
    await db.insert(playerRatings).values(playerIds.flatMap((playerId, index) => [
      {
        statsKey: `server:${GUILD_ID}` as const,
        playerId,
        mode: 'ffa',
        mu: 40 - index / 10,
        sigma: 6,
        gamesPlayed: 10,
        wins: 5,
        effectiveGames: 10,
        lastPlayedAt: NOW,
      },
      {
        statsKey: `server:${GUILD_ID}` as const,
        playerId,
        mode: 'global',
        mu: 40 - index / 10,
        sigma: 6,
        gamesPlayed: 10,
        wins: 5,
        effectiveGames: 10,
        lastPlayedAt: NOW,
      },
      {
        statsKey: `server:${SECOND_GUILD_ID}` as const,
        playerId,
        mode: 'ffa',
        mu: 40 - index / 10,
        sigma: 6,
        gamesPlayed: 10,
        wins: 5,
        effectiveGames: 10,
        lastPlayedAt: NOW,
      },
      {
        statsKey: `server:${SECOND_GUILD_ID}` as const,
        playerId,
        mode: 'global',
        mu: 40 - index / 10,
        sigma: 6,
        gamesPlayed: 10,
        wins: 5,
        effectiveGames: 10,
        lastPlayedAt: NOW,
      },
    ]))
    await markRankedRolesDirty(kv, GUILD_ID, 'primary-test')
    await markRankedRolesDirty(kv, SECOND_GUILD_ID, 'partner-test')

    const fetchedMemberIdsByGuild = new Map<string, Set<string>>()
    globalThis.fetch = async (input) => {
      const request = input instanceof Request ? input : new Request(input)
      const pathname = new URL(request.url).pathname
      if (request.method === 'GET' && pathname.endsWith('/roles')) {
        return Response.json(Object.entries(ROLE_IDS).map(([tier, id]) => ({ id, name: tier, color: 0 })))
      }
      if (request.method === 'GET') {
        const segments = pathname.split('/')
        const guildId = segments[4]
        const playerId = segments[6]
        if (guildId && playerId) {
          const playerIds = fetchedMemberIdsByGuild.get(guildId) ?? new Set<string>()
          playerIds.add(playerId)
          fetchedMemberIdsByGuild.set(guildId, playerIds)
        }
        return Response.json({ roles: [] })
      }
      return new Response(null, { status: 204 })
    }

    const env = {
      DB: createSqliteD1Database(sqlite),
      KV: kv,
      DISCORD_TOKEN: 'token',
      ALLOWED_DISCORD_GUILD_ID: GUILD_ID,
      ALLOWED_DISCORD_GUILD_IDS: SECOND_GUILD_ID,
    } as any

    const sync = await runRankedRoleMaintenance(env, 'sync', NOW)
    expect(sync.guilds).toBe(2)
    expect(sync.qualifiedPlayers).toBe(34)
    expect(sync.attemptedDiscordChanges).toBe(16)
    expect(sync.appliedDiscordChanges).toBe(16)
    expect(sync.pendingDiscordChanges).toBe(18)
    expect(fetchedMemberIdsByGuild.get(GUILD_ID)?.size).toBe(8)
    expect(fetchedMemberIdsByGuild.get(SECOND_GUILD_ID)?.size).toBe(8)
    expect(fetchedMemberIdsByGuild.has(REMOVED_GUILD_ID)).toBe(false)
    expect(await getRankedRolesDirtyState(kv, GUILD_ID)).not.toBeNull()
    expect(await getRankedRolesDirtyState(kv, SECOND_GUILD_ID)).not.toBeNull()
    expect(Object.keys((await getCurrentRankAssignments(kv, GUILD_ID)).byPlayerId)).toHaveLength(17)
    expect(Object.keys((await getCurrentRankAssignments(kv, SECOND_GUILD_ID)).byPlayerId)).toHaveLength(17)

    const firstRetry = await runRankedRoleMaintenance(env, 'apply-pending', NOW)
    expect(firstRetry.attemptedDiscordChanges).toBe(16)
    expect(firstRetry.appliedDiscordChanges).toBe(16)
    expect(firstRetry.pendingDiscordChanges).toBe(2)

    const secondRetry = await runRankedRoleMaintenance(env, 'apply-pending', NOW)
    expect(secondRetry.attemptedDiscordChanges).toBe(2)
    expect(secondRetry.appliedDiscordChanges).toBe(2)
    expect(secondRetry.pendingDiscordChanges).toBe(0)
    expect(await getRankedRolesDirtyState(kv, GUILD_ID)).not.toBeNull()
    expect(await getRankedRolesDirtyState(kv, SECOND_GUILD_ID)).not.toBeNull()

    const settledSync = await runRankedRoleMaintenance(env, 'sync', NOW)
    expect(settledSync.attemptedDiscordChanges).toBe(0)
    expect(settledSync.pendingDiscordChanges).toBe(0)
    expect(await getRankedRolesDirtyState(kv, GUILD_ID)).toBeNull()
    expect(await getRankedRolesDirtyState(kv, SECOND_GUILD_ID)).toBeNull()

    sqlite.close()
  })

  test('continues with later guilds when one guild sync fails', async () => {
    const { sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await setRankedRoleCurrentRoles(kv, GUILD_ID, ROLE_IDS)
    await setRankedRoleCurrentRoles(kv, SECOND_GUILD_ID, ROLE_IDS)
    await markRankedRolesDirty(kv, GUILD_ID, 'primary-test')
    await markRankedRolesDirty(kv, SECOND_GUILD_ID, 'partner-test')

    const failingKv = {
      get(key: string, ...args: unknown[]) {
        if (key.includes(GUILD_ID)) throw new Error('injected primary KV failure')
        return (kv.get as (...input: unknown[]) => unknown)(key, ...args)
      },
      put: kv.put.bind(kv),
      delete: kv.delete.bind(kv),
      list: kv.list.bind(kv),
    } as unknown as KVNamespace
    const env = {
      DB: createSqliteD1Database(sqlite),
      KV: failingKv,
      DISCORD_TOKEN: 'token',
      ALLOWED_DISCORD_GUILD_ID: GUILD_ID,
      ALLOWED_DISCORD_GUILD_IDS: SECOND_GUILD_ID,
    } as any
    const originalConsoleError = console.error
    console.error = () => {}
    try {
      const result = await runRankedRoleMaintenance(env, 'sync', 0)
      expect(result.guilds).toBe(2)
    }
    finally {
      console.error = originalConsoleError
    }

    expect(await getRankedRolesDirtyState(kv, GUILD_ID)).not.toBeNull()
    expect(await getRankedRolesDirtyState(kv, SECOND_GUILD_ID)).toBeNull()
    sqlite.close()
  })
})
