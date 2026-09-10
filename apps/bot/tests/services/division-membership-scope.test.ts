import { createDb, divisionRankPolicies, divisionRankStates, players, seasons } from '@civup/db'
import { resolveOverallRank } from '@civup/rating'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { getDivisionRankPolicy, maintainDivisionRanks, scopeDivisionMemberships } from '../../src/services/ranked/division-rank-runtime.ts'
import { currentRankAssignmentsKey } from '../../src/services/ranked/role-sync.ts'
import { createSqliteD1Database } from '../helpers/d1.ts'
import { createTestDatabase, createTestKv } from '../helpers/test-env.ts'

test('transition checks ranked players and legacy cleanup, leaving ordinary Unranked members untouched', async () => {
  const { sqlite } = await createTestDatabase()
  const db = createDb(createSqliteD1Database(sqlite))
  const kv = createTestKv()
  const now = 1_800_000_000_000
  const broad = '100000000000000003'
  const division = '100000000000000009'
  const unranked = '100000000000000010'
  const previousFetch = globalThis.fetch
  try {
    await db.insert(seasons).values({ id: 'season', seasonNumber: 9, name: 'Season', startsAt: 0, active: true, ratingSystem: 'rp', publicReadsEnabled: true })
    await db.insert(players).values(['ranked', 'cleanup', 'untouched'].map(id => ({ id, displayName: id, createdAt: 0 })))
    const configuration = { config: { tiers: [{ roleId: broad }, { roleId: broad }, { roleId: broad }], unrankedRoleId: unranked },
      preparation: { sourceRoleIds: [broad], unrankedRoleId: unranked, roleIdsByMinimum: { 900: division } } }
    await db.insert(divisionRankPolicies).values({ guildId: 'guild', seasonId: 'season', version: 'best-mode-quality-v1', phase: 'prepared', configJson: JSON.stringify(configuration), updatedAt: now })
    const recent = { at: now, effectiveGames: 0, highRankWins: 0, eliteWins: 0 }
    for (const id of ['ranked', 'cleanup', 'untouched']) {
      const result = resolveOverallRank({ modes: id === 'ranked' ? [{ mode: 'duel', rating: 900, effectiveGames: 20 }] : [], recent, lifetimeEliteWins: 0, lifetimeHighRankWins: 0, now })
      await db.insert(divisionRankStates).values({ guildId: 'guild', playerId: id, resultJson: JSON.stringify({ ...result, playerId: id }), desiredRoleId: id === 'ranked' ? division : unranked, pending: true })
    }
    await kv.put(currentRankAssignmentsKey('guild'), JSON.stringify({ byPlayerId: {
      cleanup: { tier: 'tier3', sourceMode: 'duel', appliedRoleId: broad, unranked: true },
      untouched: { tier: 'tier5', sourceMode: null, unranked: true, appliedRoleId: unranked },
    } }))
    const status = await scopeDivisionMemberships(db, kv, (await getDivisionRankPolicy(db, 'guild'))!)
    expect(status.pendingRoles).toBe(2)
    expect(status.membershipScopePrepared).toBe(true)
    await db.update(divisionRankPolicies).set({ phase: 'active' }).where(eq(divisionRankPolicies.guildId, 'guild'))
    const fetched: string[] = []
    const mutations: string[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url)
      if (path.includes('/members?')) throw new Error('A guild scan is forbidden')
      const match = path.match(/\/members\/(ranked|cleanup)(?:\/roles\/(\d+))?$/)
      if (!match) throw new Error(`Unexpected member lookup: ${path}`)
      if (!match[2]) { fetched.push(match[1]!); return Response.json({ roles: [broad, 'unrelated'] }) }
      mutations.push(`${init?.method}:${match[1]}:${match[2]}`)
      return new Response(null, { status: 204 })
    }) as typeof fetch
    await maintainDivisionRanks(db, kv, 'token', (await getDivisionRankPolicy(db, 'guild'))!, now)
    expect(fetched.sort()).toEqual(['cleanup', 'ranked'])
    expect(mutations.sort()).toEqual([`DELETE:cleanup:${broad}`, `DELETE:ranked:${broad}`, `PUT:cleanup:${unranked}`, `PUT:ranked:${division}`].sort())
    expect((await db.select().from(divisionRankStates).where(eq(divisionRankStates.playerId, 'untouched')))[0]!.pending).toBe(false)
  }
  finally { globalThis.fetch = previousFetch; sqlite.close() }
})
