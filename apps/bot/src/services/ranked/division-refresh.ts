import type { Database, divisionRankPolicies } from '@civup/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { divisionRankStates } from '@civup/db'
import { OVERALL_RANK_POLICY_VERSION } from '@civup/rating'
import { publishPendingDivisionPlayers } from './division-projection.ts'
import { calculateDueDivisionRanks } from './division-rank-runtime.ts'

/** One-time catch-up of saved ranked assignments; Discord delivery remains changed-player work. */
export async function refreshRankedPopulation(
  db: Database,
  kv: KVNamespace,
  policy: typeof divisionRankPolicies.$inferSelect,
  now = Date.now(),
) {
  if (policy.phase !== 'active') throw new Error('Ranked roles must already be configured.')
  const { preparation } = JSON.parse(policy.configJson)
  const scope = and(
    eq(divisionRankStates.guildId, policy.guildId),
    sql`(
    json_extract(${divisionRankStates.resultJson}, '$.band.minimum') is not null
    or (${divisionRankStates.appliedRoleId} is not null and ${divisionRankStates.appliedRoleId} != ${preparation.unrankedRoleId}))`,
    sql`json_extract(${divisionRankStates.resultJson}, '$.policyVersion') is not ${OVERALL_RANK_POLICY_VERSION}`,
  )
  const rows = await db
    .select({ playerId: divisionRankStates.playerId })
    .from(divisionRankStates)
    .where(scope)
    .limit(40)
  let result: { calculated: number; blocked: string | null } = { calculated: 0, blocked: null }
  if (rows.length) {
    const ids = rows.map(row => row.playerId)
    await db
      .update(divisionRankStates)
      .set({ nextCheckAt: 0 })
      .where(and(scope, inArray(divisionRankStates.playerId, ids)))
    result = await calculateDueDivisionRanks(db, policy, now, 40, ids)
  }
  await publishPendingDivisionPlayers(db, kv, policy.guildId)
  const [remaining] = await db
    .select({ count: sql<number>`count(*)` })
    .from(divisionRankStates)
    .where(scope)
  return { ...result, remaining: remaining!.count }
}
