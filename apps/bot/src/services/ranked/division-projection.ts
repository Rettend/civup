import type { Database } from '@civup/db'
import type { CurrentRankAssignment } from './role-sync.ts'
import { divisionRankStates } from '@civup/db'
import { and, eq, sql } from 'drizzle-orm'
import type { resolveOverallRank } from '@civup/rating'

export const divisionPlayerProjectionKey = (guildId: string, playerId: string) => `ranked-role-player:v2:${guildId}:${playerId}`
export function divisionAssignment(row: typeof divisionRankStates.$inferSelect): CurrentRankAssignment | null {
  if (!row.resultJson) return null
  const result = JSON.parse(row.resultJson) as ReturnType<typeof resolveOverallRank>
  return { tier: result.band?.tier ?? 'tier5', sourceMode: result.sourceMode, unranked: !result.band,
    divisionMinimum: result.band?.minimum ?? null, policyVersion: result.policyVersion, appliedRoleId: row.appliedRoleId, overallRating: result.overallRating }
}
/** Only changed player projections; never load or rewrite the guild's complete assignment map. */
export async function publishPendingDivisionPlayers(db: Database, kv: KVNamespace, guildId: string, limit = 40) {
  const rows = await db.select().from(divisionRankStates).where(and(eq(divisionRankStates.guildId, guildId), eq(divisionRankStates.projectionPending, true))).limit(limit)
  for (const row of rows) {
    await kv.put(divisionPlayerProjectionKey(guildId, row.playerId), JSON.stringify(divisionAssignment(row)))
    await db.update(divisionRankStates).set({ projectionPending: false }).where(and(eq(divisionRankStates.guildId, guildId), eq(divisionRankStates.playerId, row.playerId), sql`${divisionRankStates.resultJson} is ${row.resultJson}`))
  }
  return rows.length
}

export async function nextDivisionWakeAt(db: Database, guildId: string, now = Date.now()): Promise<number | null> {
  const [due, retry, pending, projection] = await Promise.all([
    db.select({ at: divisionRankStates.nextCheckAt }).from(divisionRankStates).where(and(eq(divisionRankStates.guildId, guildId), sql`${divisionRankStates.nextCheckAt} is not null`, sql`${divisionRankStates.retryAt} <= ${now}`)).orderBy(divisionRankStates.nextCheckAt).limit(1),
    db.select({ at: divisionRankStates.retryAt }).from(divisionRankStates).where(and(eq(divisionRankStates.guildId, guildId), sql`${divisionRankStates.nextCheckAt} is not null`, sql`${divisionRankStates.retryAt} > ${now}`)).orderBy(divisionRankStates.retryAt).limit(1),
    db.select({ at: divisionRankStates.retryAt }).from(divisionRankStates).where(and(eq(divisionRankStates.guildId, guildId), eq(divisionRankStates.pending, true))).orderBy(divisionRankStates.retryAt).limit(1),
    db.select({ playerId: divisionRankStates.playerId }).from(divisionRankStates).where(and(eq(divisionRankStates.guildId, guildId), eq(divisionRankStates.projectionPending, true))).limit(1),
  ])
  const times = [...due.map(row => row.at!), ...retry.map(row => row.at), ...pending.map(row => row.at), ...(projection.length ? [now] : [])]
  return times.length ? Math.max(now + 1000, Math.min(...times)) : null
}
