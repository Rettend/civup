import { matches, matchParticipants, players, seasonPeakModeRanks, seasonPeakRanks, seasons } from '@civup/db'
import { afterEach, describe, expect, test } from 'bun:test'
import { ensureSeasonSnapshotRoles, finalizeSeasonSnapshotRoles, getSeasonSnapshotRoleMappings, listPlayerSeasonSnapshotHistory } from '../../src/services/season/snapshot-roles.ts'
import { setRankedRoleCurrentRoles } from '../../src/services/ranked/roles.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const NOW = 1_700_000_000_000
const originalFetch = globalThis.fetch
const TIER_2 = 'tier2'
const TIER_4 = 'tier4'

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
      { seasonId: 'season-1', playerId: veteranId, tier: TIER_2, sourceMode: 'duel', achievedAt: NOW - 1000 },
      { seasonId: 'season-5', playerId: heroId, tier: TIER_4, sourceMode: 'ffa', achievedAt: NOW },
    ])
    await db.insert(seasonPeakModeRanks).values({
      seasonId: 'season-5',
      playerId: heroId,
      mode: 'ffa',
      tier: TIER_4,
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
            tier5: '71111111111111111',
            tier4: '72222222222222222',
            tier3: '73333333333333333',
            tier2: '74444444444444444',
            tier1: '75555555555555555',
          },
        },
      },
    }))
    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier5: '11111111111111111',
      tier4: '12222222222222222',
      tier3: '13333333333333333',
      tier2: '14444444444444444',
      tier1: '15555555555555555',
    })

    const guildRoles = new Map<string, { id: string, name: string, color: number }>([
      ['11111111111111111', { id: '11111111111111111', name: 'Stonefolk', color: 0x111111 }],
      ['12222222222222222', { id: '12222222222222222', name: 'Bronzeguard', color: 0x222222 }],
      ['13333333333333333', { id: '13333333333333333', name: 'Iron Vanguard', color: 0x333333 }],
      ['14444444444444444', { id: '14444444444444444', name: 'Legion Prime', color: 0x444444 }],
      ['15555555555555555', { id: '15555555555555555', name: 'Sun Champion', color: 0x555555 }],
      ['71111111111111111', { id: '71111111111111111', name: 'S1 Pleb', color: 0 }],
      ['72222222222222222', { id: '72222222222222222', name: 'S1 Squire', color: 0 }],
      ['73333333333333333', { id: '73333333333333333', name: 'S1 Gladiator', color: 0 }],
      ['74444444444444444', { id: '74444444444444444', name: 'S1 Legion', color: 0 }],
      ['75555555555555555', { id: '75555555555555555', name: 'S1 Champion', color: 0 }],
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

    expect(createdRoles.tier4).toMatch(/^8/)
    expect([...guildRoles.values()].some(role => role.name === 'S5 Bronzeguard' && role.color === 0x222222)).toBeTrue()

    await finalizeSeasonSnapshotRoles(db, kv, 'guild-1', 'token', {
      id: 'season-5',
      seasonNumber: 5,
      name: 'Season 5',
    })

    const mappings = await getSeasonSnapshotRoleMappings(kv, 'guild-1')
    expect(mappings.bySeasonId['season-5']?.roles.tier4).toMatch(/^8/)
    expect(mappings.bySeasonId['season-1']).toBeUndefined()

    expect(patchCalls.find(call => call.userId === heroId)?.roles).toContain(createdRoles.tier4)
    expect(patchCalls.find(call => call.userId === veteranId)?.roles).not.toContain('74444444444444444')
    expect(deletedRoleIds).toContain('74444444444444444')

    const history = await listPlayerSeasonSnapshotHistory(db, kv, 'guild-1', heroId)
    expect(history[0]?.modes.ffa?.tierRoleId).toBe(createdRoles.tier4)
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
