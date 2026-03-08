import { playerRatings, players } from '@civup/db'
import { afterEach, describe, expect, test } from 'bun:test'
import { getCurrentRankAssignments, getRankedRoleDemotionCandidates, listRankedRoleConfigGuildIds, markRankedRolesDirty, previewRankedRoles, syncRankedRoles } from '../../src/services/ranked/role-sync.ts'
import { setRankedRoleCurrentRoles } from '../../src/services/ranked/roles.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const DAY_MS = 86_400_000
const NOW = 1_700_000_000_000
const originalFetch = globalThis.fetch

describe('ranked role sync service', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('preview merges the best ladder-local tier across modes', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedPlayers(db, 'ffa', 8, { prefix: 'ffa' })
    await seedPlayers(db, 'duel', 8, { prefix: 'duel' })
    const heroId = playerIdFor('hero', 1)
    await seedPlayerIdentity(db, heroId)
    await seedRating(db, { playerId: heroId, mode: 'ffa', mu: 25, sigma: 8.333, gamesPlayed: 3, lastPlayedAt: NOW })
    await seedRating(db, { playerId: heroId, mode: 'duel', mu: 40, sigma: 6, gamesPlayed: 8, lastPlayedAt: NOW })

    const preview = await previewRankedRoles({ db, kv, guildId: 'guild-1', now: NOW })
    const hero = preview.playerPreviews.find(player => player.playerId === heroId)

    expect(hero).not.toBeUndefined()
    expect(hero?.ladderTiers.ffa).toBe('pleb')
    expect(hero?.ladderTiers.duel).toBe('squire')
    expect(hero?.assignment.tier).toBe('squire')
    expect(hero?.assignment.sourceMode).toBe('duel')

    sqlite.close()
  })

  test('daily sync keeps demotion candidates until the delay is reached', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedPlayers(db, 'ffa', 8, { prefix: 'ffa' })
    const oldSquireId = playerIdFor('old-squire', 1)
    await seedPlayerIdentity(db, oldSquireId)
    await seedRating(db, { playerId: oldSquireId, mode: 'ffa', mu: 26, sigma: 8.333, gamesPlayed: 6, lastPlayedAt: NOW - 120 * DAY_MS })

    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      pleb: '11111111111111111',
      squire: '22222222222222222',
      gladiator: '33333333333333333',
      legion: '44444444444444444',
      champion: '55555555555555555',
    })
    await seedPreviousAssignment(kv, 'guild-1', oldSquireId, { tier: 'squire', sourceMode: 'ffa' })

    for (let index = 0; index < 6; index++) {
      const result = await syncRankedRoles({
        db,
        kv,
        guildId: 'guild-1',
        now: NOW + index * DAY_MS,
        advanceDemotionWindow: true,
      })
      const preview = result.playerPreviews.find(player => player.playerId === oldSquireId)
      expect(preview?.assignment.tier).toBe('squire')
      expect(preview?.pendingDemotion?.belowKeepSyncs).toBe(index + 1)
    }

    const finalResult = await syncRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      now: NOW + 6 * DAY_MS,
      advanceDemotionWindow: true,
    })
    const demoted = finalResult.playerPreviews.find(player => player.playerId === oldSquireId)

    expect(demoted?.assignment.tier).toBe('pleb')
    expect(demoted?.pendingDemotion).toBeNull()

    const storedCandidates = await getRankedRoleDemotionCandidates(kv, 'guild-1')
    expect(storedCandidates.byPlayerId[oldSquireId]).toBeUndefined()

    sqlite.close()
  })

  test('sync stores assignments and applies Discord member role changes', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedPlayers(db, 'ffa', 8, { prefix: 'ffa' })

    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      pleb: '11111111111111111',
      squire: '22222222222222222',
      gladiator: '33333333333333333',
      legion: '44444444444444444',
      champion: '55555555555555555',
    })

    const patchCalls: Array<{ userId: string, roles: string[] }> = []
    const topPlayerId = playerIdFor('ffa', 1)
    const bottomPlayerId = playerIdFor('ffa', 8)
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      if (init?.method === 'GET') {
        const userId = url.split('/').pop() ?? ''
        return new Response(JSON.stringify({ roles: userId === topPlayerId ? ['legacy-role'] : [] }), { status: 200 })
      }
      if (init?.method === 'PATCH') {
        const userId = url.split('/').pop() ?? ''
        const payload = JSON.parse(String(init.body)) as { roles: string[] }
        patchCalls.push({ userId, roles: payload.roles })
        return new Response('{}', { status: 200 })
      }

      return new Response('not found', { status: 404 })
    }) as typeof fetch

    const result = await syncRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      token: 'token',
      now: NOW,
      applyDiscord: true,
    })

    expect(result.appliedDiscordChanges).toBe(8)
    const topPlayerCall = patchCalls.find(call => call.userId === topPlayerId)
    expect(topPlayerCall?.roles).toContain('22222222222222222')
    expect(topPlayerCall?.roles).not.toContain('legacy-role')

    const assignments = await getCurrentRankAssignments(kv, 'guild-1')
    expect(assignments.byPlayerId[topPlayerId]?.tier).toBe('squire')
    expect(assignments.byPlayerId[bottomPlayerId]?.tier).toBe('pleb')

    sqlite.close()
  })

  test('sync posts rank announcements for new qualifiers', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedPlayers(db, 'ffa', 8, { prefix: 'ffa' })

    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      pleb: '11111111111111111',
      squire: '22222222222222222',
      gladiator: '33333333333333333',
      legion: '44444444444444444',
      champion: '55555555555555555',
    })
    await kv.put('system:channel:rank-announcements', 'channel-1')

    const messagePosts: string[] = []
    globalThis.fetch = (async (input, init) => {
      const url = String(input)
      if (init?.method === 'GET' && url.includes('/members/')) {
        return new Response(JSON.stringify({ roles: [] }), { status: 200 })
      }
      if (init?.method === 'PATCH' && url.includes('/members/')) {
        return new Response('{}', { status: 200 })
      }
      if (init?.method === 'POST' && url.includes('/channels/channel-1/messages')) {
        const payload = JSON.parse(String(init.body)) as { content?: string }
        messagePosts.push(payload.content ?? '')
        return new Response(JSON.stringify({ id: 'message-1' }), { status: 200 })
      }

      return new Response('not found', { status: 404 })
    }) as typeof fetch

    await syncRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      token: 'token',
      now: NOW,
      applyDiscord: true,
    })

    expect(messagePosts).toHaveLength(1)
    expect(messagePosts[0]).toContain('Rank updates')
    expect(messagePosts[0]).toContain('qualified for ranked at <@&22222222222222222>')

    sqlite.close()
  })

  test('lists configured guilds and stores ranked dirty state', async () => {
    const kv = createTestKv()
    await setRankedRoleCurrentRoles(kv, 'guild-b', { pleb: '11111111111111111' })
    await setRankedRoleCurrentRoles(kv, 'guild-a', { pleb: '22222222222222222' })

    const guildIds = await listRankedRoleConfigGuildIds(kv)
    expect(guildIds).toEqual(['guild-a', 'guild-b'])

    const dirty = await markRankedRolesDirty(kv, 'match-report:abc')
    expect(dirty.reason).toBe('match-report:abc')
  })
})

async function seedPlayers(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  mode: 'ffa' | 'duel' | 'teamers',
  count: number,
  options: { prefix: string },
): Promise<void> {
  for (let index = 1; index <= count; index++) {
    const playerId = playerIdFor(options.prefix, index)
    await seedPlayerIdentity(db, playerId)
    await seedRating(db, {
      playerId,
      mode,
      mu: 40 - index,
      sigma: 6,
      gamesPlayed: 6,
      lastPlayedAt: NOW,
    })
  }
}

async function seedPlayerIdentity(db: Awaited<ReturnType<typeof createTestDatabase>>['db'], playerId: string): Promise<void> {
  await db.insert(players).values({
    id: playerId,
    displayName: playerId,
    avatarUrl: null,
    createdAt: NOW,
  }).onConflictDoNothing()
}

async function seedRating(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  row: {
    playerId: string
    mode: 'ffa' | 'duel' | 'teamers'
    mu: number
    sigma: number
    gamesPlayed: number
    lastPlayedAt: number
  },
): Promise<void> {
  await db.insert(playerRatings).values(row).onConflictDoUpdate({
    target: [playerRatings.playerId, playerRatings.mode],
    set: row,
  })
}

async function seedPreviousAssignment(
  kv: KVNamespace,
  guildId: string,
  playerId: string,
  assignment: { tier: 'pleb' | 'squire' | 'gladiator' | 'legion' | 'champion', sourceMode: 'ffa' | 'duel' | 'teamers' | null },
): Promise<void> {
  await kv.put(`ranked-roles:current-assignments:${guildId}`, JSON.stringify({
    byPlayerId: {
      [playerId]: assignment,
    },
  }))
}

function playerIdFor(prefix: string, index: number): string {
  const prefixValue = [...prefix].reduce((total, char) => total + char.charCodeAt(0), 0)
  return `1${String(prefixValue).padStart(4, '0')}${String(index).padStart(12, '0')}`
}
