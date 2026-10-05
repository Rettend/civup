import type { DiscordGuildRoleResponse } from '../discord/index.ts'
import { fetchGuildRoles, updateGuildRolePositions } from '../discord/index.ts'

export function planHistoricalRoleOrder(
  roles: DiscordGuildRoleResponse[],
  historicalIds: readonly string[],
  liveIds: readonly string[],
): Array<{ id: string; position: number }> {
  const historical = new Set(historicalIds)
  const live = new Set(liveIds)
  if (!live.size || [...historical].some(id => live.has(id)))
    throw new Error('Historical roles and live ranked roles must be distinct and configured.')
  const byId = new Map(roles.map(role => [role.id, role]))
  for (const id of [...historical, ...live]) {
    const role = byId.get(id)
    if (!role || !Number.isSafeInteger(role.position) || role.position! < 1)
      throw new Error('A ranked role or its position is missing.')
    if (historical.has(id) && role.managed)
      throw new Error('A managed integration role cannot be used as a historical rank.')
  }
  const ordered = [...historical]
    .map(id => byId.get(id)!)
    .sort((a, b) => a.position! - b.position! || a.id.localeCompare(b.id))
  const lowestLive = Math.min(...[...live].map(id => byId.get(id)!.position!))
  if (ordered.every(role => role.position! < lowestLive)) return []
  return ordered.map((role, index) => ({ id: role.id, position: index + 1 }))
}

export async function ensureHistoricalRoleOrder(
  token: string,
  guildId: string,
  historicalIds: readonly string[],
  liveIds: readonly string[],
): Promise<void> {
  const plan = planHistoricalRoleOrder(await fetchGuildRoles(token, guildId), historicalIds, liveIds)
  if (!plan.length) return
  await updateGuildRolePositions(token, guildId, plan)
  if (planHistoricalRoleOrder(await fetchGuildRoles(token, guildId), historicalIds, liveIds).length)
    throw new Error('Historical roles are still above live ranked roles. Check the bot role hierarchy before retrying.')
}
