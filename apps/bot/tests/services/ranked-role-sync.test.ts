import { playerRatings, players } from '@civup/db'
import { afterEach, describe, expect, test } from 'bun:test'
import { getCurrentRankAssignments, getRankedRoleDemotionCandidates, listRankedRoleConfigGuildIds, listRankedRoleMatchUpdateLines, markRankedRolesDirty, previewRankedRoles, resetCurrentRankedRoleState, syncRankedRoles } from '../../src/services/ranked/role-sync.ts'
import { setRankedRoleCurrentRoles } from '../../src/services/ranked/roles.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

const DAY_MS = 86_400_000
const NOW = 1_700_000_000_000
const originalFetch = globalThis.fetch
const TIER_1 = 'tier1'
const TIER_2 = 'tier2'
const TIER_3 = 'tier3'
const TIER_4 = 'tier4'
const TIER_5 = 'tier5'

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
    await seedRating(db, { playerId: heroId, mode: 'ffa', mu: 25, sigma: 8.333, gamesPlayed: 10, lastPlayedAt: NOW })
    await seedRating(db, { playerId: heroId, mode: 'duel', mu: 40, sigma: 6, gamesPlayed: 10, lastPlayedAt: NOW })

    const preview = await previewRankedRoles({ db, kv, guildId: 'guild-1', now: NOW })
    const hero = preview.playerPreviews.find(player => player.playerId === heroId)

    expect(hero).not.toBeUndefined()
    expect(hero?.ladderTiers.ffa).toBe(TIER_5)
    expect(hero?.ladderTiers.duel).toBe(TIER_1)
    expect(hero?.assignment.tier).toBe(TIER_1)
    expect(hero?.assignment.sourceMode).toBe('duel')

    sqlite.close()
  })

  test('preview can focus on requested players without loading the full preview roster', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedPlayers(db, 'ffa', 8, { prefix: 'ffa' })
    await seedPlayers(db, 'duel', 8, { prefix: 'duel' })
    const heroId = playerIdFor('hero', 1)
    await seedPlayerIdentity(db, heroId)
    await seedRating(db, { playerId: heroId, mode: 'duel', mu: 40, sigma: 6, gamesPlayed: 10, lastPlayedAt: NOW })

    const preview = await previewRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      now: NOW,
      playerIds: [heroId],
      includePlayerIdentities: false,
    })

    expect(preview.playerPreviews).toHaveLength(1)
    expect(preview.playerPreviews[0]?.playerId).toBe(heroId)
    expect(preview.playerPreviews[0]?.displayName).toBe(`<@${heroId}>`)
    expect(preview.playerPreviews[0]?.assignment.sourceMode).toBe('duel')

    sqlite.close()
  })

  test('protected unlock counts only apply within the protected source mode', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const duoHeroId = playerIdFor('duo-hero', 1)
    await seedPlayerIdentity(db, duoHeroId)
    await seedRating(db, { playerId: duoHeroId, mode: 'duo', mu: 40, sigma: 6, gamesPlayed: 12, lastPlayedAt: NOW })

    await kv.put('ranked-roles:current-assignments:guild-1', JSON.stringify({
      byPlayerId: Object.fromEntries(Array.from({ length: 80 }, (_value, index) => [playerIdFor('protected-squad', index + 1), {
        tier: TIER_4,
        sourceMode: 'squad',
        protectedUntilTotalGames: 10,
      }])),
    }))

    const preview = await previewRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      now: NOW,
      playerIds: [duoHeroId],
      includePlayerIdentities: false,
    })

    expect(preview.playerPreviews).toHaveLength(1)
    expect(preview.playerPreviews[0]?.ladderTiers.duo).toBe(TIER_1)
    expect(preview.playerPreviews[0]?.assignment.tier).toBe(TIER_1)
    expect(preview.playerPreviews[0]?.assignment.sourceMode).toBe('duo')

    sqlite.close()
  })

  test('players below the minimum games still affect ranked placement', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const heroId = playerIdFor('duo-hero', 2)

    await seedPlayerIdentity(db, playerIdFor('duo-hero', 1))
    await seedRating(db, {
      playerId: playerIdFor('duo-hero', 1),
      mode: 'duo',
      mu: 41,
      sigma: 6,
      gamesPlayed: 9,
      lastPlayedAt: NOW,
    })

    await seedPlayerIdentity(db, heroId)
    await seedRating(db, {
      playerId: heroId,
      mode: 'duo',
      mu: 40,
      sigma: 6,
      gamesPlayed: 10,
      lastPlayedAt: NOW,
    })

    for (let index = 3; index <= 11; index++) {
      const playerId = playerIdFor('duo-hero', index)
      await seedPlayerIdentity(db, playerId)
      await seedRating(db, {
        playerId,
        mode: 'duo',
        mu: 40 - index,
        sigma: 6,
        gamesPlayed: 9,
        lastPlayedAt: NOW,
      })
    }

    await kv.put('ranked-roles:current-assignments:guild-1', JSON.stringify({
      byPlayerId: Object.fromEntries(Array.from({ length: 40 }, (_value, index) => [playerIdFor('protected-duo', index + 1), {
        tier: TIER_4,
        sourceMode: 'duo',
        protectedUntilTotalGames: 10,
      }])),
    }))

    const preview = await previewRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      now: NOW,
      playerIds: [heroId],
      includePlayerIdentities: false,
    })

    expect(preview.playerPreviews).toHaveLength(1)
    expect(preview.playerPreviews[0]?.ladderTiers.duo).toBe(TIER_2)
    expect(preview.playerPreviews[0]?.assignment.tier).toBe(TIER_2)
    expect(preview.playerPreviews[0]?.assignment.sourceMode).toBe('duo')

    sqlite.close()
  })

  test('daily sync keeps demotion candidates until the delay is reached', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedPlayers(db, 'ffa', 8, { prefix: 'ffa' })
    const oldSquireId = playerIdFor('old-squire', 1)
    await seedPlayerIdentity(db, oldSquireId)
    await seedRating(db, { playerId: oldSquireId, mode: 'ffa', mu: 26, sigma: 8.333, gamesPlayed: 10, lastPlayedAt: NOW })

    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier5: '11111111111111111',
      tier4: '22222222222222222',
      tier3: '33333333333333333',
      tier2: '44444444444444444',
      tier1: '55555555555555555',
    })
    await seedPreviousAssignment(kv, 'guild-1', oldSquireId, { tier: TIER_4, sourceMode: 'ffa' })

    for (let index = 0; index < 6; index++) {
      const result = await syncRankedRoles({
        db,
        kv,
        guildId: 'guild-1',
        now: NOW + index * DAY_MS,
        advanceDemotionWindow: true,
      })
      const preview = result.playerPreviews.find(player => player.playerId === oldSquireId)
      expect(preview?.assignment.tier).toBe(TIER_4)
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

    expect(demoted?.assignment.tier).toBe(TIER_5)
    expect(demoted?.pendingDemotion).toBeNull()

    const storedCandidates = await getRankedRoleDemotionCandidates(kv, 'guild-1')
    expect(storedCandidates.byPlayerId[oldSquireId]).toBeUndefined()

    sqlite.close()
  })

  test('migration protection suppresses demotion until the player reaches 10 total games', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedPlayers(db, 'ffa', 8, { prefix: 'ffa' })
    const heroId = playerIdFor('migrated-squire', 1)
    await seedPlayerIdentity(db, heroId)
    await seedRating(db, { playerId: heroId, mode: 'ffa', mu: 20, sigma: 8.333, gamesPlayed: 9, lastPlayedAt: NOW })

    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier5: '11111111111111111',
      tier4: '22222222222222222',
      tier3: '33333333333333333',
      tier2: '44444444444444444',
      tier1: '55555555555555555',
    })
    await seedPreviousAssignment(kv, 'guild-1', heroId, { tier: TIER_4, sourceMode: null, protectedUntilTotalGames: 10 })

    const beforeThreshold = await syncRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      now: NOW,
      advanceDemotionWindow: true,
    })
    const protectedPlayer = beforeThreshold.playerPreviews.find(player => player.playerId === heroId)
    expect(protectedPlayer?.assignment.tier).toBe(TIER_4)
    expect(protectedPlayer?.pendingDemotion).toBeNull()

    await seedRating(db, { playerId: heroId, mode: 'ffa', mu: 20, sigma: 8.333, gamesPlayed: 10, lastPlayedAt: NOW + DAY_MS })
    await kv.delete('leaderboard:snapshot:ffa')

    const afterThreshold = await syncRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      now: NOW + DAY_MS,
      advanceDemotionWindow: true,
    })
    const pendingPlayer = afterThreshold.playerPreviews.find(player => player.playerId === heroId)
    expect(pendingPlayer?.assignment.tier).toBe(TIER_5)
    expect(pendingPlayer?.pendingDemotion).toBeNull()

    sqlite.close()
  })

  test('sync stores assignments and applies Discord member role changes', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedPlayers(db, 'ffa', 8, { prefix: 'ffa' })

    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier5: '11111111111111111',
      tier4: '22222222222222222',
      tier3: '33333333333333333',
      tier2: '44444444444444444',
      tier1: '55555555555555555',
    })

    const roleCalls: Array<{ method: 'PUT' | 'DELETE', userId: string, roleId: string }> = []
    const topPlayerId = playerIdFor('ffa', 1)
    const bottomPlayerId = playerIdFor('ffa', 8)
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      const method = init?.method
      if ((method === 'PUT' || method === 'DELETE') && url.pathname.includes('/members/')) {
        const parts = url.pathname.split('/')
        const roleId = parts.at(-1) ?? ''
        const userId = parts.at(-3) ?? ''
        roleCalls.push({ method, userId, roleId })
        return new Response(null, { status: 204 })
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
    expect(roleCalls.filter(call => call.method === 'PUT')).toHaveLength(8)
    expect(roleCalls.filter(call => call.method === 'DELETE')).toHaveLength(0)
    const topPlayerCall = roleCalls.find(call => call.userId === topPlayerId)
    expect(topPlayerCall?.roleId).toBe('55555555555555555')

    const assignments = await getCurrentRankAssignments(kv, 'guild-1')
    expect(assignments.byPlayerId[topPlayerId]?.tier).toBe(TIER_1)
    expect(assignments.byPlayerId[bottomPlayerId]?.tier).toBe(TIER_5)

    sqlite.close()
  })

  test('sync skips Discord fetches for unchanged assignments', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedPlayers(db, 'ffa', 8, { prefix: 'ffa' })

    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier5: '11111111111111111',
      tier4: '22222222222222222',
      tier3: '33333333333333333',
      tier2: '44444444444444444',
      tier1: '55555555555555555',
    })

    globalThis.fetch = (async (_input, init) => {
      if (init?.method === 'PUT' || init?.method === 'DELETE') return new Response(null, { status: 204 })
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

    let writeCalls = 0
    globalThis.fetch = (async (_input, init) => {
      if (init?.method === 'PUT' || init?.method === 'DELETE') {
        writeCalls += 1
        return new Response(null, { status: 204 })
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch

    const result = await syncRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      token: 'token',
      now: NOW + 1,
      applyDiscord: true,
    })

    expect(result.appliedDiscordChanges).toBe(0)
    expect(writeCalls).toBe(0)

    sqlite.close()
  })

  test('sync reapplies affected members when ranked role ids change', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedPlayers(db, 'ffa', 8, { prefix: 'ffa' })

    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier5: '11111111111111111',
      tier4: '22222222222222222',
      tier3: '33333333333333333',
      tier2: '44444444444444444',
      tier1: '55555555555555555',
    })

    globalThis.fetch = (async (_input, init) => {
      if (init?.method === 'PUT' || init?.method === 'DELETE') return new Response(null, { status: 204 })
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

    const initialAssignments = await getCurrentRankAssignments(kv, 'guild-1')
    const affectedPlayerIds = Object.entries(initialAssignments.byPlayerId)
      .filter(([_playerId, assignment]) => assignment.tier === TIER_4)
      .map(([playerId]) => playerId)
      .sort((a, b) => a.localeCompare(b))

    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier4: '99999999999999999',
    })

    const deleteCalls: Array<{ userId: string, roleId: string }> = []
    const putCalls: Array<{ userId: string, roleId: string }> = []
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      const method = init?.method
      if ((method === 'PUT' || method === 'DELETE') && url.pathname.includes('/members/')) {
        const parts = url.pathname.split('/')
        const roleId = parts.at(-1) ?? ''
        const userId = parts.at(-3) ?? ''
        if (method === 'DELETE') deleteCalls.push({ userId, roleId })
        if (method === 'PUT') putCalls.push({ userId, roleId })
        return new Response(null, { status: 204 })
      }
      return new Response('not found', { status: 404 })
    }) as typeof fetch

    const result = await syncRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      token: 'token',
      now: NOW + 1,
      applyDiscord: true,
    })

    expect(result.appliedDiscordChanges).toBe(affectedPlayerIds.length)
    expect(deleteCalls.map(call => call.userId).sort((a, b) => a.localeCompare(b))).toEqual(affectedPlayerIds)
    expect(putCalls.map(call => call.userId).sort((a, b) => a.localeCompare(b))).toEqual(affectedPlayerIds)
    expect(new Set(deleteCalls.map(call => call.roleId))).toEqual(new Set(['22222222222222222']))
    expect(new Set(putCalls.map(call => call.roleId))).toEqual(new Set(['99999999999999999']))

    sqlite.close()
  })

  test('builds compact ranked role update lines for match participants', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedPlayers(db, 'ffa', 8, { prefix: 'ffa' })

    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier5: '11111111111111111',
      tier4: '22222222222222222',
      tier3: '33333333333333333',
      tier2: '44444444444444444',
      tier1: '55555555555555555',
    })
    await seedPreviousAssignment(kv, 'guild-1', playerIdFor('ffa', 1), { tier: TIER_5, sourceMode: null })
    const preview = await syncRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      now: NOW,
    })
    const lines = await listRankedRoleMatchUpdateLines({
      kv,
      guildId: 'guild-1',
      preview,
      playerIds: [playerIdFor('ffa', 1), playerIdFor('ffa', 2), playerIdFor('ffa', 8)],
    })

    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('⬆️')
    expect(lines[0]).toContain('<@&11111111111111111> -> <@&55555555555555555>')

    sqlite.close()
  })

  test('season reset clears tracked assignments and reapplies the fallback pleb role', async () => {
    const kv = createTestKv()
    const heroId = playerIdFor('hero', 1)

    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier5: '11111111111111111',
      tier4: '22222222222222222',
      tier3: '33333333333333333',
      tier2: '44444444444444444',
      tier1: '55555555555555555',
    })
    await seedPreviousAssignment(kv, 'guild-1', heroId, { tier: TIER_4, sourceMode: 'ffa' })

    const roleCalls: Array<{ method: 'PUT' | 'DELETE', userId: string, roleId: string }> = []
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      const method = init?.method
      if ((method === 'PUT' || method === 'DELETE') && url.pathname.includes('/members/')) {
        const parts = url.pathname.split('/')
        const roleId = parts.at(-1) ?? ''
        const userId = parts.at(-3) ?? ''
        roleCalls.push({ method, userId, roleId })
        return new Response(null, { status: 204 })
      }

      return new Response('not found', { status: 404 })
    }) as typeof fetch

    const result = await resetCurrentRankedRoleState({
      kv,
      guildId: 'guild-1',
      token: 'token',
    })

    expect(result.clearedAssignments).toBe(1)
    expect(result.appliedDiscordChanges).toBe(1)
    expect(roleCalls).toEqual([
      { method: 'DELETE', userId: heroId, roleId: '22222222222222222' },
      { method: 'PUT', userId: heroId, roleId: '11111111111111111' },
    ])

    const assignments = await getCurrentRankAssignments(kv, 'guild-1')
    expect(assignments.byPlayerId[heroId]).toBeUndefined()

    const candidates = await getRankedRoleDemotionCandidates(kv, 'guild-1')
    expect(candidates.byPlayerId[heroId]).toBeUndefined()
  })

  test('lists configured guilds and stores ranked dirty state', async () => {
    const kv = createTestKv()
    await setRankedRoleCurrentRoles(kv, 'guild-b', { tier5: '11111111111111111' })
    await setRankedRoleCurrentRoles(kv, 'guild-a', { tier5: '22222222222222222' })

    const guildIds = await listRankedRoleConfigGuildIds(kv)
    expect(guildIds).toEqual(['guild-a', 'guild-b'])

    const dirty = await markRankedRolesDirty(kv, 'match-report:abc')
    expect(dirty.reason).toBe('match-report:abc')
  })
})

async function seedPlayers(
  db: Awaited<ReturnType<typeof createTestDatabase>>['db'],
  mode: 'duel' | 'duo' | 'squad' | 'ffa' | 'red-death',
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
      gamesPlayed: 12,
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
    mode: 'duel' | 'duo' | 'squad' | 'ffa' | 'red-death'
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
  assignment: { tier: string, sourceMode: 'duel' | 'duo' | 'squad' | 'ffa' | 'red-death' | null, protectedUntilTotalGames?: number },
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
