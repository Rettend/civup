import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import {
  createDb,
  divisionRankPolicies,
  divisionRankSources,
  divisionRankStates,
  matches,
  playerRatingEvents,
  playerRatings,
  players,
  seasonPeakDivisionRanks,
  seasonRatingStates,
  seasons,
} from '@civup/db'
import { PUBLIC_RATING_BANDS, rankDivisionSuffix } from '@civup/rating'
import { buildRankCommandImage } from '../../src/commands/rank.ts'
import { playerDecayEmbed } from '../../src/embeds/decay.ts'
import {
  activateDivisionRanks,
  calculateDueDivisionRanks,
  captureDivisionRanks,
  getDivisionRankPolicy,
  maintainDivisionRanks,
  scanDivisionMembers,
  scopeDivisionMemberships,
  stageDivisionRanks,
} from '../../src/services/ranked/division-rank-runtime.ts'
import { currentRankAssignmentsKey } from '../../src/services/ranked/role-sync.ts'
import { RANKED_ROLE_CONFIG_KEY_PREFIX } from '../../src/services/ranked/roles.ts'
import { createSqliteD1Database } from '../helpers/d1.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

test('staging and calculation do not activate or publish; cancellation invalidates saved evidence atomically', async () => {
  const { sqlite } = await createTestDatabase()
  const d1 = createSqliteD1Database(sqlite)
  const db = createDb(d1)
  const kv = createTestKv()
  const now = 1_800_000_000_000
  try {
    const sourceRoleIds = [
      '100000000000000001',
      '100000000000000002',
      '100000000000000003',
      '100000000000000004',
      '100000000000000005',
    ]
    const unrankedRoleId = '100000000000000006'
    await kv.put(
      `${RANKED_ROLE_CONFIG_KEY_PREFIX}guild`,
      JSON.stringify({ tiers: sourceRoleIds.map(roleId => ({ roleId, label: null, color: null })), unrankedRoleId }),
    )
    await db.insert(players).values({ id: 'p', displayName: 'Player', createdAt: 0 })
    await db.insert(seasons).values({
      id: 's9',
      seasonNumber: 9,
      name: 'Season 9',
      startsAt: 0,
      active: true,
      ratingSystem: 'rp',
      publicReadsEnabled: true,
      isolatedRatingsEnabled: true,
    })
    await db.insert(playerRatings).values([
      { playerId: 'p', mode: 'global', publicRating: 1200, effectiveGames: 50 },
      { playerId: 'p', mode: 'duel', publicRating: 1100, effectiveGames: 50 },
    ])
    await stageDivisionRanks(
      db,
      kv,
      {
        version: 1,
        guildId: 'guild',
        sourceRoleIds,
        unrankedRoleId,
        pendingCreate: null,
        status: 'prepared',
        roleIdsByMinimum: Object.fromEntries(
          PUBLIC_RATING_BANDS.map((band, index) => [
            band.minimum,
            `2000000000000000${index.toString().padStart(2, '0')}`,
          ]),
        ),
      },
      now,
    )
    const policy = (await getDivisionRankPolicy(db, 'guild'))!
    expect(policy.phase).toBe('prepared')
    await db
      .insert(matches)
      .values({ id: 'match', seasonId: 's9', gameMode: '1v1', createdAt: now, status: 'completed' })
    await db.insert(playerRatingEvents).values({
      matchId: 'match',
      playerId: 'p',
      mode: 'global',
      gameMode: '1v1',
      matchCreatedAt: now,
      matchCompletedAt: now,
      effectiveGamesDelta: 1,
      effectiveWinsVsTier2PlusDelta: 1,
      ratingBeforeMu: 25,
      ratingBeforeSigma: 3,
      ratingAfterMu: 26,
      ratingAfterSigma: 3,
    })
    sqlite.exec(
      "insert into rating_mutation_leases(id, match_id, generation, created_at) values('writer', 'match', 0, 0)",
    )
    expect(await calculateDueDivisionRanks(db, policy, now)).toEqual({ calculated: 0, blocked: 'rating-writers' })
    expect((await db.select().from(divisionRankStates))[0]!.resultJson).toBeNull()
    sqlite.exec("delete from rating_mutation_leases where id = 'writer'")
    const batch = d1.batch.bind(d1)
    let injectWriter = true
    d1.batch = (async (statements: D1PreparedStatement[]) => {
      if (injectWriter) {
        injectWriter = false
        sqlite.exec(
          "insert into rating_mutation_leases(id, match_id, generation, created_at) values('racing-writer', 'match', 0, 0)",
        )
      }
      return batch(statements)
    }) as D1Database['batch']
    expect(await calculateDueDivisionRanks(db, policy, now)).toEqual({ calculated: 0, blocked: 'source-changed' })
    expect((await db.select().from(divisionRankStates))[0]!.resultJson).toBeNull()
    expect(sqlite.query('select count(*) as n from division_quality_credits').get()).toEqual({ n: 0 })
    expect(sqlite.query('select id from rating_mutation_leases').all()).toEqual([{ id: 'racing-writer' }])
    sqlite.exec("delete from rating_mutation_leases where id = 'racing-writer'")
    let failedBatches = 0
    d1.batch = (async () => {
      failedBatches++
      throw new Error('D1_ERROR: malformed JSON: SQLITE_ERROR')
    }) as D1Database['batch']
    await expect(calculateDueDivisionRanks(db, policy, now)).rejects.toThrow('malformed JSON')
    expect(failedBatches).toBe(1)
    expect((await db.select().from(divisionRankStates))[0]!.resultJson).toBeNull()
    d1.batch = batch
    expect(await calculateDueDivisionRanks(db, policy, now)).toEqual({ calculated: 1, blocked: null })
    let [state] = await db.select().from(divisionRankStates)
    expect(JSON.parse(state!.resultJson!).recent.highRankWins).toBe(1)
    expect(state!.appliedRoleId).toBeNull()
    expect(await kv.get(currentRankAssignmentsKey('guild'))).toBeNull()
    await expect(activateDivisionRanks(db, kv, 'token', 'guild', 'bot', '', now)).rejects.toThrow('supply their digest')
    expect(await calculateDueDivisionRanks(db, policy, now)).toEqual({ calculated: 0, blocked: null })
    const before = (await db.select().from(divisionRankSources))[0]!.revision
    await db.update(matches).set({ status: 'cancelled' }).where(eq(matches.id, 'match'))
    expect((await db.select().from(divisionRankSources))[0]!.revision).toBeGreaterThan(before)
    expect((await db.select().from(divisionRankStates))[0]!.nextCheckAt).toBe(0)
    await calculateDueDivisionRanks(db, policy, now)
    ;[state] = await db.select().from(divisionRankStates)
    expect(JSON.parse(state!.resultJson!).recent.highRankWins).toBe(0)
    expect((await db.select().from(divisionRankPolicies))[0]!.phase).toBe('prepared')
    const originalFetch = globalThis.fetch
    const prepared = JSON.parse(policy.configJson).preparation
    const memberRoles = [sourceRoleIds[2]!, 'unrelated']
    let memberPages = 0
    const roles = [
      ...sourceRoleIds.map((id, index) => ({ id, name: `Broad ${index}`, permissions: '0', position: index + 1 })),
      ...PUBLIC_RATING_BANDS.map(band => ({
        id: prepared.roleIdsByMinimum[band.minimum],
        name: `Broad ${Number(band.tier.slice(4)) - 1}${rankDivisionSuffix(band.division)}`,
        permissions: '0',
        position: 10 + PUBLIC_RATING_BANDS.indexOf(band),
      })),
      { id: 'bot-role', permissions: '8', position: 100 },
      { id: unrankedRoleId, permissions: '0', position: 1 },
    ]
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url)
      if (path.endsWith('/channels')) return Response.json([])
      if (path.endsWith('/roles')) return Response.json(roles)
      if (path.endsWith('/members/bot')) return Response.json({ roles: ['bot-role'] })
      if (path.includes('/members?')) {
        memberPages++
        return Response.json([{ user: { id: 'p' }, roles: memberRoles }])
      }
      if (path.endsWith('/members/p')) return Response.json({ roles: [...memberRoles] })
      if (path.includes('/members/p/roles/')) {
        const id = path.split('/').at(-1)!
        if (init?.method === 'PUT') memberRoles.push(id)
        else if (init?.method === 'DELETE') memberRoles.splice(memberRoles.indexOf(id), 1)
        else throw new Error('Unexpected member operation')
        return new Response(null, { status: 204 })
      }
      throw new Error(`Unexpected Discord request ${path}`)
    }) as typeof fetch
    try {
      await scanDivisionMembers(db, 'token', policy, now)
      expect(memberPages).toBe(1)
      expect(
        await scanDivisionMembers(db, 'token', (await getDivisionRankPolicy(db, 'guild'))!, now + 30 * 86_400_000),
      ).toEqual({ scanned: 0, complete: true })
      expect(memberPages).toBe(1)
      await scopeDivisionMemberships(db, kv, (await getDivisionRankPolicy(db, 'guild'))!)
      const capture = await captureDivisionRanks(db, 'guild')
      await expect(activateDivisionRanks(db, kv, 'token', 'guild', 'bot', '0'.repeat(64), now)).rejects.toThrow(
        'changed',
      )
      await expect(activateDivisionRanks(db, kv, 'token', 'guild', 'bot', capture.digest, now)).rejects.toThrow()
      expect((await getDivisionRankPolicy(db, 'guild'))!.phase).toBe('prepared')
      sqlite.exec("update rating_maintenance set state = 'paused'")
      roles.find(role => role.id === sourceRoleIds[1])!.permissions = '8'
      await expect(activateDivisionRanks(db, kv, 'token', 'guild', 'bot', capture.digest, now)).rejects.toThrow(
        'grant permissions',
      )
      roles.find(role => role.id === sourceRoleIds[1])!.permissions = '0'
      const put = kv.put.bind(kv)
      let failed = false
      kv.put = (async (key: string, value: string, options?: KVNamespacePutOptions) => {
        if (!failed && key === currentRankAssignmentsKey('guild')) {
          failed = true
          throw new Error('Projection interrupted')
        }
        return put(key, value, options)
      }) as KVNamespace['put']
      await expect(activateDivisionRanks(db, kv, 'token', 'guild', 'bot', capture.digest, now)).rejects.toThrow(
        'Projection interrupted',
      )
      expect((await getDivisionRankPolicy(db, 'guild'))!.phase).toBe('activating')
      await activateDivisionRanks(db, kv, 'token', 'guild', 'bot', capture.digest, now)
      expect((await getDivisionRankPolicy(db, 'guild'))!.phase).toBe('active')
      expect(memberRoles).toEqual([sourceRoleIds[2]!, 'unrelated'])
      sqlite.exec("update rating_maintenance set state = 'open'")
      await db.insert(seasonRatingStates).values({
        seasonId: 's9',
        playerId: 'p',
        mode: 'global',
        mu: 25,
        sigma: 3,
        evidence: {},
        updatedAt: now,
        seasonGames: 1,
      })
      await maintainDivisionRanks(db, kv, 'token', (await getDivisionRankPolicy(db, 'guild'))!, now)
      expect(memberRoles).toEqual(['unrelated', prepared.roleIdsByMinimum[1100]])
      expect((await db.select().from(seasonPeakDivisionRanks))[0]!.minimum).toBe(1100)
      expect(await buildRankCommandImage(db, kv, 'guild', 'p', { scope: 'overall', gameLimit: 20 })).toEqual({
        content: `<@p> - <@&${prepared.roleIdsByMinimum[1100]}>`,
      })
      const decay = playerDecayEmbed({
        displayName: 'Player',
        ratings: [],
        policy: null,
        season: null,
        now,
        modeOnly: true,
      })
      expect(decay.fields?.slice(0, 4).map(field => field.name)).toEqual(['Duel', 'Duo', 'Squad', 'FFA'])
      expect(JSON.stringify(decay)).not.toContain('Overall')
      memberRoles.splice(1, 1)
      await scanDivisionMembers(db, 'token', (await getDivisionRankPolicy(db, 'guild'))!, now + 86_400_001)
      await maintainDivisionRanks(db, kv, 'token', (await getDivisionRankPolicy(db, 'guild'))!, now + 86_400_001)
      expect(memberRoles).toEqual(['unrelated'])
      expect(memberPages).toBe(1)
      // Unchanged assignments do not trigger another Discord membership check.
      await db.update(matches).set({ status: 'completed' }).where(eq(matches.id, 'match'))
      await maintainDivisionRanks(db, kv, 'token', (await getDivisionRankPolicy(db, 'guild'))!, now + 86_400_002)
      expect(memberRoles).toEqual(['unrelated'])
      expect(memberPages).toBe(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  } finally {
    sqlite.close()
  }
})
