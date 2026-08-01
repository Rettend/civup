export interface ActivityConnectionState {
  guildId: string
  approvedGuildIds?: string[]
}

export function resolveActivityConnectionGuildRefresh(
  state: ActivityConnectionState | null,
  approvedGuildIds: readonly string[],
): { allowed: boolean, configurationChanged: boolean, state: ActivityConnectionState } {
  const guildId = state?.guildId ?? ''
  const previousGuildIds = state?.approvedGuildIds ?? []
  const configurationChanged = previousGuildIds.length !== approvedGuildIds.length
    || previousGuildIds.some((id, index) => id !== approvedGuildIds[index])
  return {
    allowed: guildId.length > 0 && approvedGuildIds.includes(guildId),
    configurationChanged,
    state: { guildId, approvedGuildIds: [...approvedGuildIds] },
  }
}
