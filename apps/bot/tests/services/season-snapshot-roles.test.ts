import { matches, matchParticipants, players, seasonPeakModeRanks, seasonPeakRanks, seasons } from '@civup/db'
import { afterEach, describe, expect, test } from 'bun:test'
import { ensureSeasonSnapshotRoles, finalizeSeasonSnapshotRoles, getSeasonSnapshotRoleMappings, listPlayerSeasonSnapshotHistory } from '../../src/services/season/snapshot-roles.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const NOW = 1_700_000_000_000
const originalFetch = globalThis.fetch

describe('season snapshot roles', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('creates season snapshot roles, assigns ended-season peaks, and trims expired seasons', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()

    const veteranId = '100010000000000001'
    const heroId = '100010000000000099'
    await seedPlayer(db, veteranId)
    await seedPlayer(db, heroId)

    for (let seasonNumber = 1; seasonNumber <= 5; seasonNumber++) {
      await db.insert(seasons).values({
        id: `season-${seasonNumber}`,
        seasonNumber,
        name: `Season ${seasonNumber}`,
        startsAt: NOW + seasonNumber,
        endsAt: seasonNumber === 5 ? null : NOW + seasonNumber + 1,
        active: seasonNumber === 5,
      })
    }

    await db.insert(seasonPeakRanks).values([
      { seasonId: 'season-1', playerId: veteranId, tier: 'legion', sourceMode: 'duel', achievedAt: NOW - 1000 },
      { seasonId: 'season-5', playerId: heroId, tier: 'squire', sourceMode: 'ffa', achievedAt: NOW },
    ])
    await db.insert(seasonPeakModeRanks).values({
      seasonId: 'season-5',
      playerId: heroId,
      mode: 'ffa',
      tier: 'squire',
      rating: 642,
      achievedAt: NOW,
    })
    await db.insert(matches).values({
      id: 'season-5-match-1',
      gameMode: 'ffa',
      status: 'completed',
      seasonId: 'season-5',
      draftData: null,
      createdAt: NOW - 10_000,
      completedAt: NOW,
    })
    await db.insert(matchParticipants).values({
      matchId: 'season-5-match-1',
      playerId: heroId,
      team: null,
      civId: null,
      placement: 1,
      ratingBeforeMu: null,
      ratingBeforeSigma: null,
      ratingAfterMu: null,
      ratingAfterSigma: null,
    })

    await kv.put('ranked-roles:season-snapshots:guild-1', JSON.stringify({
      bySeasonId: {
        'season-1': {
          seasonNumber: 1,
          seasonName: 'Season 1',
          roles: {
            pleb: '71111111111111111',
            squire: '72222222222222222',
            gladiator: '73333333333333333',
            legion: '74444444444444444',
            champion: '75555555555555555',
          },
        },
      },
    }))

    const guildRoles = new Map<string, { id: string, name: string, color: number }>([
      ['71111111111111111', { id: '71111111111111111', name: 'Season 1 Pleb', color: 0 }],
      ['72222222222222222', { id: '72222222222222222', name: 'Season 1 Squire', color: 0 }],
      ['73333333333333333', { id: '73333333333333333', name: 'Season 1 Gladiator', color: 0 }],
      ['74444444444444444', { id: '74444444444444444', name: 'Season 1 Legion', color: 0 }],
      ['75555555555555555', { id: '75555555555555555', name: 'Season 1 Champion', color: 0 }],
    ])
    const memberRoles = new Map<string, string[]>([
      [veteranId, ['74444444444444444']],
      [heroId, []],
    ])
    let createIndex = 0
    const patchCalls: Array<{ userId: string, roles: string[] }> = []
    const deletedRoleIds: string[] = []

    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'

      if (method === 'GET' && url.endsWith('/roles')) {
        return new Response(JSON.stringify([...guildRoles.values()]), { status: 200 })
      }

      if (method === 'POST' && url.endsWith('/roles')) {
        createIndex += 1
        const payload = JSON.parse(String(init?.body)) as { name: string, color?: number }
        const roleId = `8${String(createIndex).padStart(16, '0')}`
        guildRoles.set(roleId, { id: roleId, name: payload.name, color: payload.color ?? 0 })
        return new Response(JSON.stringify({ id: roleId }), { status: 200 })
      }

      if (method === 'GET' && url.includes('/members/')) {
        const userId = url.split('/').pop() ?? ''
        return new Response(JSON.stringify({ roles: memberRoles.get(userId) ?? [] }), { status: 200 })
      }

      if (method === 'PATCH' && url.includes('/members/')) {
        const userId = url.split('/').pop() ?? ''
        const payload = JSON.parse(String(init?.body)) as { roles: string[] }
        memberRoles.set(userId, payload.roles)
        patchCalls.push({ userId, roles: payload.roles })
        return new Response('{}', { status: 200 })
      }

      if (method === 'DELETE' && url.includes('/roles/')) {
        const roleId = url.split('/').pop() ?? ''
        deletedRoleIds.push(roleId)
        guildRoles.delete(roleId)
        return new Response('', { status: 204 })
      }

      return new Response('not found', { status: 404 })
    }) as typeof fetch

    const createdRoles = await ensureSeasonSnapshotRoles(kv, 'guild-1', 'token', {
      id: 'season-5',
      seasonNumber: 5,
      name: 'Season 5',
    })

    expect(createdRoles.squire).toMatch(/^8/)

    await finalizeSeasonSnapshotRoles(db, kv, 'guild-1', 'token', {
      id: 'season-5',
      seasonNumber: 5,
      name: 'Season 5',
    })

    const mappings = await getSeasonSnapshotRoleMappings(kv, 'guild-1')
    expect(mappings.bySeasonId['season-5']?.roles.squire).toMatch(/^8/)
    expect(mappings.bySeasonId['season-1']).toBeUndefined()

    expect(patchCalls.find(call => call.userId === heroId)?.roles).toContain(createdRoles.squire)
    expect(patchCalls.find(call => call.userId === veteranId)?.roles).not.toContain('74444444444444444')
    expect(deletedRoleIds).toContain('74444444444444444')

    const history = await listPlayerSeasonSnapshotHistory(db, kv, 'guild-1', heroId)
    expect(history[0]?.modes.ffa?.tierRoleId).toBe(createdRoles.squire)
    expect(history[0]?.modes.ffa?.rating).toBe(642)

    sqlite.close()
  })
})

async function seedPlayer(db: Awaited<ReturnType<typeof createTestDatabase>>['db'], playerId: string): Promise<void> {
  await db.insert(players).values({
    id: playerId,
    displayName: playerId,
    avatarUrl: null,
    createdAt: NOW,
  })
}
