import type { Database } from '@civup/db'
import { divisionRankStates } from '@civup/db'
import { and, eq, inArray } from 'drizzle-orm'
import { divisionAssignment } from './division-projection.ts'
import { getCurrentRankAssignments } from './role-sync.ts'
import { getRankedRoleConfig } from './roles.ts'

/** Reports record the participants' assigned ranks even while KV delivery is pending. */
export async function loadMatchOpponentTiers(db: Database, kv: KVNamespace, guildId: string | null | undefined, playerIds: readonly string[]): Promise<Map<string, string>> {
  if (!guildId || !playerIds.length) return new Map()
  const ids = [...new Set(playerIds)]
  if ((await getRankedRoleConfig(kv, guildId)).divisionPolicy) {
    const rows = await db.select().from(divisionRankStates).where(and(eq(divisionRankStates.guildId, guildId), inArray(divisionRankStates.playerId, ids)))
    return new Map(rows.flatMap(row => {
      const assignment = divisionAssignment(row)
      return assignment && !assignment.unranked ? [[row.playerId, assignment.tier]] : []
    }))
  }
  const saved = await getCurrentRankAssignments(kv, guildId)
  return new Map(ids.flatMap(id => {
    const assignment = saved.byPlayerId[id]
    return assignment && !assignment.unranked ? [[id, assignment.tier]] : []
  }))
}
