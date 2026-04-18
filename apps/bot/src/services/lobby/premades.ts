import type { GameMode, QueueEntry } from '@civup/game'
import { playerCountOptions, teamCount as modeTeamCount, teamSize as modeTeamSize, slotToTeamIndex } from '@civup/game'

interface CompactModeChangeOptions {
  sourceMode?: GameMode
  sourceSlots?: readonly (string | null)[]
}

export function compactSlottedPremadesForMode(
  mode: GameMode,
  orderedPlayerIds: string[],
  _queueEntries: QueueEntry[],
  options?: CompactModeChangeOptions,
): { slots: (string | null)[] } | { error: string } {
  const targetSize = resolveCompactTargetSize(mode, orderedPlayerIds.length)
  if (targetSize == null) {
    return { error: `${mode} does not support ${orderedPlayerIds.length} players.` }
  }

  if (mode === 'ffa') {
    const slots = Array.from({ length: targetSize }, () => null as string | null)
    for (let index = 0; index < targetSize; index++) slots[index] = orderedPlayerIds[index] ?? null
    return { slots }
  }

  const teamSize = modeTeamSize(mode, targetSize)
  if (!teamSize) {
    return { error: `${mode} does not support ${orderedPlayerIds.length} players.` }
  }

  const preservedTeams = buildCurrentTeamsForModeChange(mode, orderedPlayerIds, targetSize, options)
  const teams = preservedTeams ?? buildSequentialTeams(orderedPlayerIds, modeTeamCount(mode, targetSize), teamSize)
  return { slots: buildTeamSlots(teamSize, teams, targetSize) }
}

function buildCurrentTeamsForModeChange(
  mode: GameMode,
  orderedPlayerIds: string[],
  targetSize: number,
  options?: CompactModeChangeOptions,
): string[][] | null {
  const sourceMode = options?.sourceMode
  const sourceSlots = options?.sourceSlots
  if (!sourceMode || !sourceSlots) return null

  const sourceTeamSize = modeTeamSize(sourceMode, sourceSlots.length)
  const targetTeamSize = modeTeamSize(mode, targetSize)
  if (!sourceTeamSize || !targetTeamSize) return null

  if (modeTeamCount(sourceMode, sourceSlots.length) !== modeTeamCount(mode, targetSize)) return null

  const orderedPlayerSet = new Set(orderedPlayerIds)
  const seen = new Set<string>()
  const teamIdsByTeam = Array.from({ length: modeTeamCount(mode, targetSize) }, () => [] as string[])

  for (let index = 0; index < sourceSlots.length; index++) {
    const playerId = sourceSlots[index]
    if (!playerId || seen.has(playerId) || !orderedPlayerSet.has(playerId)) continue

    const teamIndex = slotToTeamIndex(sourceMode, index, sourceSlots.length)
    if (teamIndex == null) return null
    teamIdsByTeam[teamIndex]?.push(playerId)
    seen.add(playerId)
  }

  if (seen.size !== orderedPlayerIds.length) return null
  if (teamIdsByTeam.some(teamIds => teamIds.length > targetTeamSize)) return null
  return teamIdsByTeam
}

function buildSequentialTeams(playerIds: string[], teamCount: number, teamSize: number): string[][] {
  const teams = Array.from({ length: teamCount }, () => [] as string[])
  for (let index = 0; index < playerIds.length; index++) {
    const teamIndex = Math.floor(index / teamSize)
    teams[teamIndex]?.push(playerIds[index]!)
  }
  return teams
}

function buildTeamSlots(teamSize: number, teamIdsByTeam: string[][], slotCount: number): (string | null)[] {
  const slots = Array.from({ length: slotCount }, () => null as string | null)
  for (let team = 0; team < teamIdsByTeam.length; team++) {
    const teamIds = teamIdsByTeam[team] ?? []
    for (let index = 0; index < teamSize; index++) {
      slots[(team * teamSize) + index] = teamIds[index] ?? null
    }
  }
  return slots
}

function resolveCompactTargetSize(mode: GameMode, playerCount: number): number | null {
  return playerCountOptions(mode).find(option => playerCount <= option) ?? null
}
