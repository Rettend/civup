import type { GameMode, QueueEntry } from '@civup/game'
import type { PlayerRating } from '@civup/rating'
import { isTeamMode, teamCount as modeTeamCount, teamSize } from '@civup/game'
import { createRating, predictWinProbabilities } from '@civup/rating'

export type LobbyArrangeStrategy = 'randomize' | 'balance' | 'shuffle-teams'

interface RatingSnapshot {
  mu: number
  sigma: number
}

interface PlayerGroup {
  playerIds: string[]
  size: number
}

interface GroupAssignment {
  teamByGroup: number[]
  teamCounts: number[]
}

interface ArrangementCandidate {
  assignment: GroupAssignment
  score: number
  key: string
}

export interface ArrangeLobbySlotsInput {
  mode: GameMode
  slots: (string | null)[]
  queueEntries: QueueEntry[]
  strategy: LobbyArrangeStrategy
  ratingsByPlayerId?: Map<string, RatingSnapshot>
  random?: () => number
}

export function arrangeLobbySlots(
  input: ArrangeLobbySlotsInput,
): { slots: (string | null)[] } | { error: string } {
  if (input.strategy === 'shuffle-teams' && !isTeamMode(input.mode)) {
    return { error: 'Shuffle teams is only available in team lobbies.' }
  }
  if (isTeamMode(input.mode)) return arrangeTeamLobbySlots(input)
  return arrangeSeatLobbySlots(input)
}

function arrangeSeatLobbySlots(
  input: ArrangeLobbySlotsInput,
): { slots: (string | null)[] } | { error: string } {
  const slottedPlayerIds = input.slots.filter((playerId): playerId is string => playerId != null)
  if (slottedPlayerIds.length === 0) return { slots: Array.from({ length: input.slots.length }, () => null as string | null) }

  if (input.strategy === 'randomize') {
    const random = input.random ?? Math.random
    return { slots: shuffle(input.slots, random) }
  }

  const ratingsByPlayerId = input.ratingsByPlayerId ?? new Map<string, RatingSnapshot>()
  const slotOrderByPlayerId = buildSlotOrderByPlayerId(input.slots)
  const balancedPlayerIds = [...slottedPlayerIds].sort((left, right) => {
    const ratingDiff = getArrangeSkill(ratingsByPlayerId, left) - getArrangeSkill(ratingsByPlayerId, right)
    if (ratingDiff !== 0) return ratingDiff

    const leftOrder = slotOrderByPlayerId.get(left) ?? Number.MAX_SAFE_INTEGER
    const rightOrder = slotOrderByPlayerId.get(right) ?? Number.MAX_SAFE_INTEGER
    if (leftOrder !== rightOrder) return leftOrder - rightOrder
    return left.localeCompare(right)
  })

  return { slots: buildSeatSlots(input.slots.length, balancedPlayerIds) }
}

function arrangeTeamLobbySlots(
  input: ArrangeLobbySlotsInput,
): { slots: (string | null)[] } | { error: string } {
  if (!isTeamMode(input.mode)) {
    return { error: 'Team arrange actions are only available in team lobbies.' }
  }

  const teamSlotCount = teamSize(input.mode, input.slots.length)
  if (!teamSlotCount) {
    return { error: 'Team arrange actions are only available in team lobbies.' }
  }
  const slottedPlayerIds = input.slots.filter((playerId): playerId is string => playerId != null)
  const activeTeamCount = modeTeamCount(input.mode, slottedPlayerIds.length)

  if (slottedPlayerIds.length === 0) {
    return { slots: Array.from({ length: input.slots.length }, () => null as string | null) }
  }

  const slotOrderByPlayerId = buildSlotOrderByPlayerId(input.slots)

  if (input.strategy === 'randomize') {
    const random = input.random ?? Math.random
    return { slots: shuffle(input.slots, random) }
  }

  if (input.strategy === 'shuffle-teams') {
    const random = input.random ?? Math.random
    const groups = buildRelativeOrderGroups(slottedPlayerIds, activeTeamCount)
    return { slots: buildShuffledTeamSlots(teamSlotCount, groups, activeTeamCount, input.slots.length, random) }
  }

  const groups = slottedPlayerIds.map((playerId) => ({
    playerIds: [playerId],
    size: 1,
  } satisfies PlayerGroup))
  const assignments = enumerateAssignments(groups, teamSlotCount, activeTeamCount)
  if (assignments.length === 0) return { error: 'Could not auto-balance teams for this lobby.' }

  const minSizeDiff = Math.min(...assignments.map((assignment) => {
    const minCount = Math.min(...assignment.teamCounts)
    const maxCount = Math.max(...assignment.teamCounts)
    return maxCount - minCount
  }))
  const candidateAssignments = assignments.filter((assignment) => {
    const minCount = Math.min(...assignment.teamCounts)
    const maxCount = Math.max(...assignment.teamCounts)
    return (maxCount - minCount) === minSizeDiff
  })

  const ratingsByPlayerId = input.ratingsByPlayerId ?? new Map<string, RatingSnapshot>()
  const scoredCandidates = candidateAssignments.map((assignment) => {
    const teamIdsByTeam = assignmentToTeams(assignment, groups, activeTeamCount)
    const score = scoreBalancedCandidate(teamIdsByTeam, ratingsByPlayerId)
    const key = teamIdsByTeam.map(teamIds => teamIds.join(',')).join('|')

    return {
      assignment,
      score,
      key,
    } satisfies ArrangementCandidate
  })

  const minScore = Math.min(...scoredCandidates.map(candidate => candidate.score))
  const tied = scoredCandidates
    .filter(candidate => candidate.score === minScore)
    .sort((left, right) => left.key.localeCompare(right.key))
  const chosen = tied[0]
  if (!chosen) return { error: 'Could not auto-balance teams for this lobby.' }

  const teamIdsByTeam = assignmentToTeams(chosen.assignment, groups, activeTeamCount)
  return { slots: buildTeamSlots(teamSlotCount, teamIdsByTeam, input.slots.length) }
}

function buildSlotOrderByPlayerId(slots: readonly (string | null)[]): Map<string, number> {
  const slotOrderByPlayerId = new Map<string, number>()
  for (let index = 0; index < slots.length; index++) {
    const playerId = slots[index]
    if (!playerId || slotOrderByPlayerId.has(playerId)) continue
    slotOrderByPlayerId.set(playerId, index)
  }
  return slotOrderByPlayerId
}

function buildRelativeOrderGroups(slottedPlayerIds: string[], activeTeamCount: number): string[][] {
  if (slottedPlayerIds.length === 0 || activeTeamCount <= 0) return []

  const baseSize = Math.floor(slottedPlayerIds.length / activeTeamCount)
  const remainder = slottedPlayerIds.length % activeTeamCount
  const groups: string[][] = []
  let offset = 0

  for (let team = 0; team < activeTeamCount; team++) {
    const groupSize = baseSize + (team < remainder ? 1 : 0)
    groups.push(slottedPlayerIds.slice(offset, offset + groupSize))
    offset += groupSize
  }

  return groups.filter(group => group.length > 0)
}

function enumerateAssignments(groups: PlayerGroup[], teamSize: number, teamTotal: number): GroupAssignment[] {
  if (groups.length === 0) {
    return [{ teamByGroup: [], teamCounts: Array.from({ length: teamTotal }, () => 0) }]
  }

  const assignments: GroupAssignment[] = []
  const firstGroupSize = groups[0]?.size ?? 0
  if (firstGroupSize > teamSize) return []

  const teamByGroup: number[] = [0]
  const teamCounts = Array.from({ length: teamTotal }, (_, index) => index === 0 ? firstGroupSize : 0)

  const walk = (index: number) => {
    if (index >= groups.length) {
      assignments.push({
        teamByGroup: [...teamByGroup],
        teamCounts: [...teamCounts],
      })
      return
    }

    const group = groups[index]
    if (!group) return

    for (let team = 0; team < teamTotal; team++) {
      if ((teamCounts[team] ?? 0) + group.size > teamSize) continue
      teamByGroup[index] = team
      teamCounts[team] = (teamCounts[team] ?? 0) + group.size
      walk(index + 1)
      teamCounts[team] = (teamCounts[team] ?? 0) - group.size
    }
  }

  walk(1)
  return assignments
}

function assignmentToTeams(
  assignment: GroupAssignment,
  groups: PlayerGroup[],
  teamTotal: number,
): string[][] {
  const teamIdsByTeam = Array.from({ length: teamTotal }, () => [] as string[])

  for (let index = 0; index < groups.length; index++) {
    const group = groups[index]
    if (!group) continue

    const team = assignment.teamByGroup[index]
    if (team == null) continue
    teamIdsByTeam[team]?.push(...group.playerIds)
  }

  return teamIdsByTeam
}

function scoreBalancedCandidate(
  teamIdsByTeam: string[][],
  ratingsByPlayerId: Map<string, RatingSnapshot>,
): number {
  if (teamIdsByTeam.some(teamIds => teamIds.length === 0)) return Number.POSITIVE_INFINITY

  const teams = teamIdsByTeam.map(teamIds => teamIds.map(playerId => toPlayerRating(playerId, ratingsByPlayerId)))
  const target = 1 / Math.max(1, teams.length)

  try {
    const probabilities = predictWinProbabilities(teams)
    if (probabilities.some(probability => typeof probability !== 'number' || !Number.isFinite(probability))) {
      return Number.POSITIVE_INFINITY
    }
    return probabilities.reduce((score, probability) => score + Math.abs(probability - target), 0)
  }
  catch {
    return Number.POSITIVE_INFINITY
  }
}

function toPlayerRating(
  playerId: string,
  ratingsByPlayerId: Map<string, RatingSnapshot>,
): PlayerRating {
  const snapshot = ratingsByPlayerId.get(playerId)
  if (snapshot) {
    return {
      playerId,
      mu: snapshot.mu,
      sigma: snapshot.sigma,
    }
  }

  const fallback = createRating(playerId)
  return {
    playerId,
    mu: fallback.mu,
    sigma: fallback.sigma,
  }
}

function getArrangeSkill(ratingsByPlayerId: Map<string, RatingSnapshot>, playerId: string): number {
  return toPlayerRating(playerId, ratingsByPlayerId).mu
}

function buildShuffledTeamSlots(
  teamSize: number,
  groups: string[][],
  activeTeamCount: number,
  slotCount: number,
  random: () => number,
): (string | null)[] {
  const shuffledGroups = shuffle(groups, random)
  const slots = Array.from({ length: slotCount }, () => null as string | null)

  for (let team = 0; team < activeTeamCount; team++) {
    const teamPlayers = shuffledGroups[team] ?? []
    for (let index = 0; index < teamSize; index++) {
      slots[(team * teamSize) + index] = teamPlayers[index] ?? null
    }
  }

  return slots
}

function shuffle<T>(values: T[], random: () => number): T[] {
  const next = [...values]
  for (let i = next.length - 1; i > 0; i--) {
    const swapIndex = Math.floor(random() * (i + 1))
    const temp = next[i]
    next[i] = next[swapIndex]!
    next[swapIndex] = temp!
  }
  return next
}

function buildTeamSlots(teamSize: number, teamIdsByTeam: string[][], slotCount: number): (string | null)[] {
  const slots = Array.from({ length: slotCount }, () => null as string | null)

  for (let team = 0; team < teamIdsByTeam.length; team++) {
    const teamIds = teamIdsByTeam[team] ?? []
    for (let index = 0; index < teamSize; index++) {
      slots[team * teamSize + index] = teamIds[index] ?? null
    }
  }

  return slots
}

function buildSeatSlots(slotCount: number, playerIds: string[]): (string | null)[] {
  const slots = Array.from({ length: slotCount }, () => null as string | null)
  for (let index = 0; index < slotCount; index++) slots[index] = playerIds[index] ?? null
  return slots
}
