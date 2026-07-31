import { playerRatings, players } from '@civup/db'
import { afterEach, describe, expect, test } from 'bun:test'
import { applyPendingRankedRoleDiscordChanges, getCurrentRankAssignments, getRankedRoleDemotionCandidates, listRankedRoleConfigGuildIds, listRankedRoleMatchUpdateLines, markRankedRolesDirty, previewRankedRoles, rankedRoleMembershipNeedsRepair, repairCurrentRankedRoleMembership, repairRankedRoleMembership, resetCurrentRankedRoleState, syncRankedRoles } from '../../src/services/ranked/role-sync.ts'
import { setRankedRoleCurrentRoles } from '../../src/services/ranked/roles.ts'
import { createTrackedKv } from '../helpers/tracked-kv.ts'
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

  test('preview assigns the Discord role from the global pool while keeping mode ladders visible', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedPlayers(db, 'ffa', 20, { prefix: 'ffa' })
    await seedPlayers(db, 'duel', 8, { prefix: 'duel' })
    const heroId = playerIdFor('hero', 1)
    await seedPlayerIdentity(db, heroId)
    await seedRating(db, { playerId: heroId, mode: 'ffa', mu: 25, sigma: 8.333, gamesPlayed: 10, lastPlayedAt: NOW })
    await seedRating(db, { playerId: heroId, mode: 'duel', mu: 40, sigma: 6, gamesPlayed: 10, lastPlayedAt: NOW })
    await seedRating(db, { playerId: heroId, mode: 'global', mu: 40, sigma: 6, gamesPlayed: 25, winsVsTier1: 1, winsVsTier2Plus: 4, lastPlayedAt: NOW })

    const preview = await previewRankedRoles({ db, kv, guildId: 'guild-1', now: NOW })
    const hero = preview.playerPreviews.find(player => player.playerId === heroId)

    expect(hero).not.toBeUndefined()
    expect(hero?.ladderTiers.ffa).toBe(TIER_4)
    expect(hero?.ladderTiers.duel).toBe(TIER_1)
    expect(hero?.assignment.tier).toBe(TIER_1)
    expect(hero?.assignment.sourceMode).toBeNull()

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
    await seedRating(db, { playerId: heroId, mode: 'global', mu: 40, sigma: 6, gamesPlayed: 25, lastPlayedAt: NOW })

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
    expect(preview.playerPreviews[0]?.assignment.sourceMode).toBeNull()

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
    await seedRating(db, { playerId: heroId, mode: 'global', mu: 40, sigma: 6, gamesPlayed: 16, lastPlayedAt: NOW })

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
    expect(preview.playerPreviews[0]?.assignment.sourceMode).toBeNull()

    sqlite.close()
  })

  test('repeated effective quality wins can floor a tier-4 candidate to tier 3', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedPlayers(db, 'ffa', 8, { prefix: 'ffa' })
    const targetId = playerIdFor('ffa', 6)

    await seedRating(db, {
      playerId: targetId,
      mode: 'global',
      mu: 34,
      sigma: 6,
      gamesPlayed: 9,
      lastPlayedAt: NOW,
      winsVsTier2Plus: 2,
      effectiveWinsVsTier2Plus: 0.5,
    })

    const preview = await previewRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      now: NOW,
      playerIds: [targetId],
      includePlayerIdentities: false,
    })

    expect(preview.playerPreviews[0]?.assignment.tier).toBe(TIER_3)

    sqlite.close()
  })

  test('a single tier-2 quality win does not floor a tier-4 candidate to tier 3', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedPlayers(db, 'ffa', 8, { prefix: 'ffa' })
    const targetId = playerIdFor('ffa', 6)

    await seedRating(db, {
      playerId: targetId,
      mode: 'global',
      mu: 34,
      sigma: 6,
      gamesPlayed: 9,
      lastPlayedAt: NOW,
      winsVsTier2Plus: 1,
      effectiveWinsVsTier2Plus: 1,
    })

    const preview = await previewRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      now: NOW,
      playerIds: [targetId],
      includePlayerIdentities: false,
    })

    expect(preview.playerPreviews[0]?.assignment.tier).toBe(TIER_4)

    sqlite.close()
  })

  test('participation floor lifts high-volume tier-5 players to tier 4 without reapplying tier-3 quality floors', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedPlayers(db, 'ffa', 20, { prefix: 'ffa' })
    const targetId = playerIdFor('participation', 1)
    await seedPlayerIdentity(db, targetId)

    await seedRating(db, {
      playerId: targetId,
      mode: 'global',
      mu: 15,
      sigma: 5,
      gamesPlayed: 35,
      wins: 5,
      effectiveGames: 35,
      lastPlayedAt: NOW,
      winsVsTier1: 3,
      winsVsTier2Plus: 8,
      effectiveWinsVsTier1: 1,
      effectiveWinsVsTier2Plus: 2,
    })

    const preview = await previewRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      now: NOW,
      playerIds: [targetId],
      includePlayerIdentities: false,
    })

    expect(preview.playerPreviews[0]?.assignment.tier).toBe(TIER_4)

    sqlite.close()
  })

  test('stored participation-floor tier 4 does not chain into tier 3 quality floor', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedPlayers(db, 'ffa', 20, { prefix: 'ffa' })
    const targetId = playerIdFor('participation-chain', 1)
    await seedPlayerIdentity(db, targetId)

    await seedRating(db, {
      playerId: targetId,
      mode: 'global',
      mu: 15,
      sigma: 5,
      gamesPlayed: 36,
      wins: 13,
      effectiveGames: 36,
      lastPlayedAt: NOW,
      winsVsTier1: 3,
      winsVsTier2Plus: 8,
      effectiveWinsVsTier1: 0.92,
      effectiveWinsVsTier2Plus: 2.33,
    })
    await seedPreviousAssignment(kv, 'guild-1', targetId, { tier: TIER_4, sourceMode: null })

    const preview = await previewRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      now: NOW,
      playerIds: [targetId],
      includePlayerIdentities: false,
    })

    expect(preview.playerPreviews[0]?.assignment.tier).toBe(TIER_4)

    sqlite.close()
  })

  test('participation floor requires enough wins', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedPlayers(db, 'ffa', 20, { prefix: 'ffa' })
    const targetId = playerIdFor('participation', 2)
    await seedPlayerIdentity(db, targetId)

    await seedRating(db, {
      playerId: targetId,
      mode: 'global',
      mu: 15,
      sigma: 5,
      gamesPlayed: 35,
      wins: 4,
      effectiveGames: 35,
      lastPlayedAt: NOW,
    })

    const preview = await previewRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      now: NOW,
      playerIds: [targetId],
      includePlayerIdentities: false,
    })

    expect(preview.playerPreviews[0]?.assignment.tier).toBe(TIER_5)

    sqlite.close()
  })

  test('quality floors cannot create tier 2 without tier-2 evidence', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedPlayers(db, 'ffa', 8, { prefix: 'ffa' })
    const targetId = playerIdFor('ffa', 3)

    await seedRating(db, {
      playerId: targetId,
      mode: 'global',
      mu: 37,
      sigma: 6,
      gamesPlayed: 15,
      effectiveGames: 13,
      lastPlayedAt: NOW,
      winsVsTier1: 3,
      winsVsTier2Plus: 15,
    })

    const preview = await previewRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      now: NOW,
      playerIds: [targetId],
      includePlayerIdentities: false,
    })

    expect(preview.playerPreviews[0]?.assignment.tier).toBe(TIER_3)

    sqlite.close()
  })

  test('quality wins can floor tier-3 global evidence to tier 2 after the tier-2 gate', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedPlayers(db, 'ffa', 8, { prefix: 'ffa' })
    const targetId = playerIdFor('ffa', 3)

    await seedRating(db, {
      playerId: targetId,
      mode: 'global',
      mu: 37,
      sigma: 6,
      gamesPlayed: 12,
      effectiveGames: 16,
      lastPlayedAt: NOW,
      winsVsTier1: 3,
      winsVsTier2Plus: 15,
      effectiveWinsVsTier1: 3,
      effectiveWinsVsTier2Plus: 15,
    })

    const preview = await previewRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      now: NOW,
      playerIds: [targetId],
      includePlayerIdentities: false,
    })

    expect(preview.playerPreviews[0]?.assignment.tier).toBe(TIER_2)

    sqlite.close()
  })

  test('tier-3 mode evidence with role score support can floor a player to tier 2', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedPlayers(db, 'ffa', 20, { prefix: 'ffa' })
    const targetId = playerIdFor('ffa', 8)

    await seedRating(db, { playerId: targetId, mode: 'ffa', mu: 32, sigma: 6, gamesPlayed: 18, lastPlayedAt: NOW })
    await seedRating(db, {
      playerId: targetId,
      mode: 'global',
      mu: 27,
      sigma: 6,
      gamesPlayed: 16,
      effectiveGames: 16,
      winsVsTier1: 2,
      lastPlayedAt: NOW,
    })

    const preview = await previewRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      now: NOW,
      playerIds: [targetId],
      includePlayerIdentities: false,
    })

    expect(preview.playerPreviews[0]?.ladderTiers.ffa).toBe(TIER_3)
    expect(preview.playerPreviews[0]?.assignment.tier).toBe(TIER_2)

    sqlite.close()
  })

  test('tier-3 mode evidence tier-2 floor requires role score support', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedPlayers(db, 'ffa', 20, { prefix: 'ffa' })
    const targetId = playerIdFor('ffa', 8)

    await seedRating(db, { playerId: targetId, mode: 'ffa', mu: 32, sigma: 6, gamesPlayed: 18, lastPlayedAt: NOW })
    await seedRating(db, {
      playerId: targetId,
      mode: 'global',
      mu: 26,
      sigma: 6,
      gamesPlayed: 16,
      effectiveGames: 16,
      winsVsTier1: 2,
      lastPlayedAt: NOW,
    })

    const preview = await previewRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      now: NOW,
      playerIds: [targetId],
      includePlayerIdentities: false,
    })

    expect(preview.playerPreviews[0]?.ladderTiers.ffa).toBe(TIER_3)
    expect(preview.playerPreviews[0]?.assignment.tier).toBe(TIER_4)

    sqlite.close()
  })

  test('thin current tier 1 stays protected until tier-1 evidence gate', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedPlayers(db, 'ffa', 20, { prefix: 'ffa' })
    const targetId = playerIdFor('ffa', 20)

    await seedPreviousAssignment(kv, 'guild-1', targetId, { tier: TIER_1, sourceMode: null })

    const preview = await previewRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      now: NOW,
      playerIds: [targetId],
      includePlayerIdentities: false,
    })

    expect(preview.playerPreviews[0]?.assignment.tier).toBe(TIER_1)
    expect(preview.playerPreviews[0]?.pendingDemotion).toBeNull()

    sqlite.close()
  })

  test('tier-2-or-better best-mode evidence can floor a qualified player to tier 3', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedPlayers(db, 'ffa', 8, { prefix: 'ffa' })
    const targetId = playerIdFor('ffa', 8)

    await seedRating(db, { playerId: targetId, mode: 'ffa', mu: 42, sigma: 6, gamesPlayed: 20, lastPlayedAt: NOW })
    await seedRating(db, { playerId: targetId, mode: 'global', mu: 20, sigma: 6, gamesPlayed: 10, lastPlayedAt: NOW })

    const preview = await previewRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      now: NOW,
      playerIds: [targetId],
      includePlayerIdentities: false,
    })

    expect(preview.playerPreviews[0]?.ladderTiers.ffa).toBe(TIER_1)
    expect(preview.playerPreviews[0]?.assignment.tier).toBe(TIER_3)

    sqlite.close()
  })

  test('grace cap gives overflow players one weaker grace role using the full ranked population', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    const graceIds = [9, 10, 11, 12, 19, 20].map(index => playerIdFor('grace-cap', index))

    for (let index = 1; index <= 20; index++) {
      const playerId = playerIdFor('grace-cap', index)
      await seedPlayerIdentity(db, playerId)
      await seedRating(db, {
        playerId,
        mode: 'global',
        mu: 60 - index,
        sigma: 6,
        gamesPlayed: 12,
        effectiveGames: 12,
        lastPlayedAt: NOW,
        winsVsTier2Plus: index >= 9 && index <= 12 ? 2 : 0,
        effectiveWinsVsTier2Plus: index >= 9 && index <= 12 ? 0.5 : 0,
      })
    }
    await seedRating(db, { playerId: graceIds[4]!, mode: 'duel', mu: 40, sigma: 6, gamesPlayed: 20, lastPlayedAt: NOW })
    await seedRating(db, { playerId: graceIds[5]!, mode: 'duel', mu: 39, sigma: 6, gamesPlayed: 20, lastPlayedAt: NOW })

    const preview = await previewRankedRoles({ db, kv, guildId: 'guild-1', now: NOW, includePlayerIdentities: false })
    const previewById = new Map(preview.playerPreviews.map(player => [player.playerId, player]))

    for (const playerId of graceIds.slice(0, 4)) {
      expect(previewById.get(playerId)?.assignment.tier).toBe(TIER_3)
    }
    for (const playerId of graceIds.slice(4)) {
      expect(previewById.get(playerId)?.assignment.tier).toBe(TIER_4)
    }

    const focusedPreview = await previewRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      now: NOW,
      playerIds: [graceIds[5]!],
      includePlayerIdentities: false,
    })

    expect(focusedPreview.playerPreviews).toHaveLength(1)
    expect(focusedPreview.playerPreviews[0]?.assignment.tier).toBe(TIER_4)

    sqlite.close()
  })

  test('daily sync keeps demotion candidates until the delay is reached', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedPlayers(db, 'ffa', 8, { prefix: 'ffa' })
    const demotionTargetId = playerIdFor('old-tier-3', 1)
    await seedPlayerIdentity(db, demotionTargetId)
    await seedRating(db, { playerId: demotionTargetId, mode: 'ffa', mu: 26, sigma: 8.333, gamesPlayed: 10, lastPlayedAt: NOW })
    await seedRating(db, { playerId: demotionTargetId, mode: 'global', mu: 10, sigma: 8.333, gamesPlayed: 10, lastPlayedAt: NOW })

    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier5: '11111111111111111',
      tier4: '22222222222222222',
      tier3: '33333333333333333',
      tier2: '44444444444444444',
      tier1: '55555555555555555',
    })
    await seedPreviousAssignment(kv, 'guild-1', demotionTargetId, { tier: TIER_3, sourceMode: 'ffa' })

    for (let index = 0; index < 6; index++) {
      const result = await syncRankedRoles({
        db,
        kv,
        guildId: 'guild-1',
        now: NOW + index * DAY_MS,
        advanceDemotionWindow: true,
      })
      const preview = result.playerPreviews.find(player => player.playerId === demotionTargetId)
      expect(preview?.assignment.tier).toBe(TIER_3)
      expect(preview?.pendingDemotion?.belowKeepSyncs).toBe(index + 1)
    }

    const finalResult = await syncRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      now: NOW + 6 * DAY_MS,
      advanceDemotionWindow: true,
    })
    const demoted = finalResult.playerPreviews.find(player => player.playerId === demotionTargetId)

    expect(demoted?.assignment.tier).toBe(TIER_4)
    expect(demoted?.pendingDemotion).toBeNull()

    const storedCandidates = await getRankedRoleDemotionCandidates(kv, 'guild-1')
    expect(storedCandidates.byPlayerId[demotionTargetId]).toBeUndefined()

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
    expect(topPlayerCall?.roleId).toBe('33333333333333333')

    const assignments = await getCurrentRankAssignments(kv, 'guild-1')
    expect(assignments.byPlayerId[topPlayerId]?.tier).toBe(TIER_3)
    expect(assignments.byPlayerId[bottomPlayerId]?.tier).toBe(TIER_4)

    sqlite.close()
  })

  test('sync skips Discord fetches for already-applied assignments', async () => {
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

    const { getCalls, deleteCalls, putCalls } = installMemberRoleFetchMock()

    await syncRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      token: 'token',
      now: NOW,
      applyDiscord: true,
    })

    getCalls.length = 0
    deleteCalls.length = 0
    putCalls.length = 0

    const result = await syncRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      token: 'token',
      now: NOW + 1,
      applyDiscord: true,
    })

    expect(result.appliedDiscordChanges).toBe(0)
    expect(getCalls).toHaveLength(0)
    expect(deleteCalls).toHaveLength(0)
    expect(putCalls).toHaveLength(0)

    sqlite.close()
  })

  test('known member roles avoid Discord work when the ranked role is already correct', async () => {
    globalThis.fetch = (async () => {
      throw new Error('Discord should not be called for a correct ranked membership.')
    }) as typeof fetch

    const input = {
      currentRoleIds: ['44444444444444444', '77777777777777777'],
      desiredRoleId: '44444444444444444',
      managedRoleIds: ['11111111111111111', '22222222222222222', '33333333333333333', '44444444444444444', '55555555555555555'],
    }

    expect(rankedRoleMembershipNeedsRepair(input)).toBe(false)
    expect(await repairRankedRoleMembership({
      token: 'token',
      guildId: 'guild-1',
      playerId: playerIdFor('self-heal', 1),
      ...input,
    })).toBe(false)
  })

  test('known member roles replace a stale ranked role without fetching the member', async () => {
    const playerId = playerIdFor('self-heal', 2)
    const { getCalls, deleteCalls, putCalls } = installMemberRoleFetchMock(new Map([
      [playerId, new Set(['11111111111111111'])],
    ]))
    const input = {
      currentRoleIds: ['11111111111111111'],
      desiredRoleId: '44444444444444444',
      managedRoleIds: ['11111111111111111', '22222222222222222', '33333333333333333', '44444444444444444', '55555555555555555'],
    }

    expect(rankedRoleMembershipNeedsRepair(input)).toBe(true)
    expect(await repairRankedRoleMembership({
      token: 'token',
      guildId: 'guild-1',
      playerId,
      ...input,
    })).toBe(true)
    expect(getCalls).toHaveLength(0)
    expect(deleteCalls).toEqual([{ userId: playerId, roleId: '11111111111111111' }])
    expect(putCalls).toEqual([{ userId: playerId, roleId: '44444444444444444' }])
  })

  test('known member role repair keeps the existing role when adding the desired role fails', async () => {
    const calls: Array<{ method: string, roleId: string }> = []
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input))
      const method = init?.method ?? 'GET'
      calls.push({ method, roleId: url.pathname.split('/').at(-1) ?? '' })
      return new Response('missing permissions', { status: 403 })
    }) as typeof fetch

    await expect(repairRankedRoleMembership({
      token: 'token',
      guildId: 'guild-1',
      playerId: playerIdFor('self-heal', 3),
      currentRoleIds: ['11111111111111111'],
      desiredRoleId: '44444444444444444',
      managedRoleIds: ['11111111111111111', '44444444444444444'],
    })).rejects.toThrow('Discord add guild member role failed: 403')
    expect(calls).toEqual([{ method: 'PUT', roleId: '44444444444444444' }])
  })

  test('stats repair bypasses the assignment cache before changing known member roles', async () => {
    const kv = createTestKv()
    const playerId = playerIdFor('self-heal', 4)
    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier5: '11111111111111111',
      tier4: '22222222222222222',
      tier3: '33333333333333333',
      tier2: '44444444444444444',
      tier1: '55555555555555555',
    })
    await seedPreviousAssignment(kv, 'guild-1', playerId, { tier: TIER_2, sourceMode: null })
    await getCurrentRankAssignments(kv, 'guild-1')
    await kv.put('ranked-roles:current-assignments:guild-1', JSON.stringify({
      byPlayerId: {
        [playerId]: { tier: TIER_3, sourceMode: null },
      },
    }))

    const { getCalls, deleteCalls, putCalls } = installMemberRoleFetchMock(new Map([
      [playerId, new Set(['11111111111111111'])],
    ]))
    expect(await repairCurrentRankedRoleMembership({
      kv,
      token: 'token',
      guildId: 'guild-1',
      playerId,
      currentRoleIds: ['11111111111111111'],
    })).toBe(true)
    expect(getCalls).toHaveLength(0)
    expect(putCalls).toEqual([{ userId: playerId, roleId: '33333333333333333' }])
    expect(deleteCalls).toEqual([{ userId: playerId, roleId: '11111111111111111' }])
  })

  test('pending Discord retry is read-only when nothing is pending', async () => {
    const { kv, operations, runWithoutTracking } = createTrackedKv()
    const playerId = playerIdFor('ffa', 1)

    await runWithoutTracking(async () => {
      await setRankedRoleCurrentRoles(kv, 'guild-1', {
        tier5: '11111111111111111',
        tier4: '22222222222222222',
        tier3: '33333333333333333',
        tier2: '44444444444444444',
        tier1: '55555555555555555',
      })
      await seedPreviousAssignment(kv, 'guild-1', playerId, {
        tier: TIER_3,
        sourceMode: null,
        appliedRoleId: '33333333333333333',
      })
    })
    globalThis.fetch = (async () => {
      throw new Error('Discord should not be called when no rank roles are pending.')
    }) as typeof fetch

    const result = await applyPendingRankedRoleDiscordChanges({
      kv,
      guildId: 'guild-1',
      token: 'token',
      maxPlayers: 8,
    })

    expect(result).toEqual({ attemptedChanges: 0, appliedChanges: 0, pendingChanges: 0 })
    expect(operations).toEqual([])
  })

  test('sync applies Discord role changes in bounded persisted batches', async () => {
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
    installMemberRoleFetchMock()

    const firstResult = await syncRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      token: 'token',
      now: NOW,
      applyDiscord: true,
      maxDiscordRoleSyncPlayers: 2,
    })

    expect(firstResult.appliedDiscordChanges).toBe(2)
    expect(firstResult.pendingDiscordChanges).toBe(6)
    let assignments = await getCurrentRankAssignments(kv, 'guild-1')
    expect(countAppliedRoleIds(assignments)).toBe(2)

    const secondResult = await syncRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      token: 'token',
      now: NOW + 1,
      applyDiscord: true,
      maxDiscordRoleSyncPlayers: 2,
    })

    expect(secondResult.appliedDiscordChanges).toBe(2)
    expect(secondResult.pendingDiscordChanges).toBe(4)
    assignments = await getCurrentRankAssignments(kv, 'guild-1')
    expect(countAppliedRoleIds(assignments)).toBe(4)

    sqlite.close()
  })

  test('pending Discord retry prioritizes known stale role changes before unknown applied roles', async () => {
    const kv = createTestKv()
    const unknownAppliedRoleId = playerIdFor('aaa', 1)
    const staleAppliedRoleId = playerIdFor('zzz', 1)

    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier5: '11111111111111111',
      tier4: '22222222222222222',
      tier3: '33333333333333333',
      tier2: '44444444444444444',
      tier1: '55555555555555555',
    })
    await kv.put('ranked-roles:current-assignments:guild-1', JSON.stringify({
      byPlayerId: {
        [unknownAppliedRoleId]: { tier: TIER_3, sourceMode: null },
        [staleAppliedRoleId]: { tier: TIER_3, sourceMode: null, appliedRoleId: '22222222222222222' },
      },
    }))
    const { deleteCalls, putCalls } = installMemberRoleFetchMock(new Map([
      [staleAppliedRoleId, new Set(['22222222222222222'])],
    ]))

    const result = await applyPendingRankedRoleDiscordChanges({
      kv,
      guildId: 'guild-1',
      token: 'token',
      maxPlayers: 1,
    })
    const assignments = await getCurrentRankAssignments(kv, 'guild-1')

    expect(result.appliedChanges).toBe(1)
    expect(result.pendingChanges).toBe(1)
    expect(deleteCalls).toEqual([{ userId: staleAppliedRoleId, roleId: '22222222222222222' }])
    expect(putCalls).toEqual([{ userId: staleAppliedRoleId, roleId: '33333333333333333' }])
    expect(assignments.byPlayerId[staleAppliedRoleId]?.appliedRoleId).toBe('33333333333333333')
    expect(assignments.byPlayerId[unknownAppliedRoleId]?.appliedRoleId).toBeUndefined()
  })

  test('sync persists desired assignments when Discord apply has pending failures', async () => {
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

    const playerId = playerIdFor('ffa', 1)
    await seedPreviousAssignment(kv, 'guild-1', playerId, {
      tier: TIER_4,
      sourceMode: null,
      appliedRoleId: '22222222222222222',
    })
    globalThis.fetch = (async () => new Response('discord unavailable', { status: 500 })) as typeof fetch

    const result = await syncRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      token: 'token',
      now: NOW,
      applyDiscord: true,
      playerIds: [playerId],
    })

    expect(result.pendingDiscordChanges).toBe(1)
    const assignments = await getCurrentRankAssignments(kv, 'guild-1')
    expect(assignments.byPlayerId[playerId]?.tier).toBe(TIER_3)
    expect(assignments.byPlayerId[playerId]?.appliedRoleId).toBe('22222222222222222')

    sqlite.close()
  })

  test('sync repairs stale Discord roles for unchanged assignments', async () => {
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

    const playerId = playerIdFor('ffa', 1)
    await seedPreviousAssignment(kv, 'guild-1', playerId, { tier: TIER_3, sourceMode: null })
    const { memberRoles, deleteCalls, putCalls } = installMemberRoleFetchMock(new Map([
      [playerId, new Set(['22222222222222222'])],
    ]))

    const result = await syncRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      token: 'token',
      now: NOW,
      applyDiscord: true,
      playerIds: [playerId],
    })

    expect(result.appliedDiscordChanges).toBe(1)
    expect(deleteCalls).toEqual([{ userId: playerId, roleId: '22222222222222222' }])
    expect(putCalls).toEqual([{ userId: playerId, roleId: '33333333333333333' }])
    expect(memberRoles.get(playerId)?.has('22222222222222222')).toBe(false)
    expect(memberRoles.get(playerId)?.has('33333333333333333')).toBe(true)

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

    const { deleteCalls, putCalls } = installMemberRoleFetchMock()

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

    deleteCalls.length = 0
    putCalls.length = 0

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

  test('role id migrations remove old roles for every affected member in one sync', async () => {
    const { db, sqlite } = await createTestDatabase()
    const kv = createTestKv()
    await seedPlayers(db, 'ffa', 40, { prefix: 'migration' })

    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier5: '11111111111111111',
      tier4: '22222222222222222',
      tier3: '33333333333333333',
      tier2: '44444444444444444',
      tier1: '55555555555555555',
    })

    const { memberRoles, getCalls } = installMemberRoleFetchMock()
    const result = await syncRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      token: 'token',
      now: NOW,
      applyDiscord: true,
    })
    expect(result.pendingDiscordChanges).toBe(0)

    const assignments = await getCurrentRankAssignments(kv, 'guild-1')
    const tier4PlayerIds = Object.entries(assignments.byPlayerId)
      .filter(([_playerId, assignment]) => assignment.tier === TIER_4)
      .map(([playerId]) => playerId)
      .sort((a, b) => a.localeCompare(b))
    expect(tier4PlayerIds.length).toBeGreaterThan(12)

    await setRankedRoleCurrentRoles(kv, 'guild-1', {
      tier4: '99999999999999999',
    })

    getCalls.length = 0
    const migrationResult = await syncRankedRoles({
      db,
      kv,
      guildId: 'guild-1',
      token: 'token',
      now: NOW + 10,
      applyDiscord: true,
    })
    expect(migrationResult.pendingDiscordChanges).toBe(0)
    expect(getCalls).toHaveLength(tier4PlayerIds.length)

    for (const playerId of tier4PlayerIds) {
      const roles = memberRoles.get(playerId) ?? new Set<string>()
      expect(roles.has('22222222222222222')).toBe(false)
      expect(roles.has('99999999999999999')).toBe(true)
    }

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

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('⬆️')
    expect(lines[0]).toContain('<@&11111111111111111> -> <@&33333333333333333>')

    sqlite.close()
  })

  test('season reset clears tracked assignments and reapplies the fallback tier-5 role', async () => {
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
    await seedRating(db, {
      playerId,
      mode: 'global',
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
    mode: 'duel' | 'duo' | 'squad' | 'ffa' | 'red-death' | 'global'
    mu: number
    sigma: number
    gamesPlayed: number
    lastPlayedAt: number
    wins?: number
    effectiveGames?: number
    winsVsTier1?: number
    winsVsTier2Plus?: number
    effectiveWinsVsTier1?: number
    effectiveWinsVsTier2Plus?: number
  },
): Promise<void> {
  await db.insert(playerRatings).values({
    ...row,
    wins: row.wins ?? 0,
    effectiveGames: row.effectiveGames ?? row.gamesPlayed,
    winsVsTier1: row.winsVsTier1 ?? 0,
    winsVsTier2Plus: row.winsVsTier2Plus ?? 0,
    effectiveWinsVsTier1: row.effectiveWinsVsTier1 ?? 0,
    effectiveWinsVsTier2Plus: row.effectiveWinsVsTier2Plus ?? 0,
  }).onConflictDoUpdate({
    target: [playerRatings.playerId, playerRatings.mode],
    set: {
      ...row,
      wins: row.wins ?? 0,
      effectiveGames: row.effectiveGames ?? row.gamesPlayed,
      winsVsTier1: row.winsVsTier1 ?? 0,
      winsVsTier2Plus: row.winsVsTier2Plus ?? 0,
      effectiveWinsVsTier1: row.effectiveWinsVsTier1 ?? 0,
      effectiveWinsVsTier2Plus: row.effectiveWinsVsTier2Plus ?? 0,
    },
  })
}

async function seedPreviousAssignment(
  kv: KVNamespace,
  guildId: string,
  playerId: string,
  assignment: { tier: string, sourceMode: 'duel' | 'duo' | 'squad' | 'ffa' | 'red-death' | null, appliedRoleId?: string },
): Promise<void> {
  await kv.put(`ranked-roles:current-assignments:${guildId}`, JSON.stringify({
    byPlayerId: {
      [playerId]: assignment,
    },
  }))
}

function installMemberRoleFetchMock(memberRoles = new Map<string, Set<string>>()): {
  memberRoles: Map<string, Set<string>>
  getCalls: Array<{ userId: string }>
  deleteCalls: Array<{ userId: string, roleId: string }>
  putCalls: Array<{ userId: string, roleId: string }>
} {
  const getCalls: Array<{ userId: string }> = []
  const deleteCalls: Array<{ userId: string, roleId: string }> = []
  const putCalls: Array<{ userId: string, roleId: string }> = []

  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    if (method === 'GET' && url.pathname.includes('/members/')) {
      const userId = url.pathname.split('/').at(-1) ?? ''
      getCalls.push({ userId })
      return Response.json({ roles: [...(memberRoles.get(userId) ?? new Set<string>())] })
    }
    if ((method === 'PUT' || method === 'DELETE') && url.pathname.includes('/members/')) {
      const parts = url.pathname.split('/')
      const roleId = parts.at(-1) ?? ''
      const userId = parts.at(-3) ?? ''
      const roles = memberRoles.get(userId) ?? new Set<string>()
      if (method === 'DELETE') {
        deleteCalls.push({ userId, roleId })
        roles.delete(roleId)
      }
      if (method === 'PUT') {
        putCalls.push({ userId, roleId })
        roles.add(roleId)
      }
      memberRoles.set(userId, roles)
      return new Response(null, { status: 204 })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch

  return { memberRoles, getCalls, deleteCalls, putCalls }
}

function countAppliedRoleIds(assignments: Awaited<ReturnType<typeof getCurrentRankAssignments>>): number {
  return Object.values(assignments.byPlayerId).filter(assignment => assignment.appliedRoleId != null).length
}

function playerIdFor(prefix: string, index: number): string {
  const prefixValue = [...prefix].reduce((total, char) => total + char.charCodeAt(0), 0)
  return `1${String(prefixValue).padStart(4, '0')}${String(index).padStart(12, '0')}`
}
