import type { GameMode, QueueEntry } from '@civup/game'
import type { PlayerRating } from '@civup/rating'
import { isTeamMode, teamCount as modeTeamCount, teamSize } from '@civup/game'
import { createRating, predictWinProbabilities } from '@civup/rating'

export type LobbyArrangeStrategy = 'randomize' | 'balance'

interface RatingSnapshot {
  mu: number
  sigma: number
}

interface PremadeGroup {
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
    return { slots: buildSeatSlots(input.slots.length, shuffle(slottedPlayerIds, random)) }
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
    return { error: 'Team arrange actions are only available in 2v2, 3v3, and 4v4 lobbies.' }
  }

  const teamSlotCount = teamSize(input.mode)
  if (!teamSlotCount) {
    return { error: 'Team arrange actions are only available in 2v2, 3v3, and 4v4 lobbies.' }
  }
  const queueByPlayerId = new Map(input.queueEntries.map(entry => [entry.playerId, entry]))
  const slottedPlayerIds = input.slots.filter((playerId): playerId is string => playerId != null)
  const activeTeamCount = modeTeamCount(input.mode, slottedPlayerIds.length)

  if (slottedPlayerIds.length === 0) {
    return { slots: Array.from({ length: input.slots.length }, () => null as string | null) }
  }

  const slotOrderByPlayerId = buildSlotOrderByPlayerId(input.slots)

  const groups = buildPremadeGroups(slottedPlayerIds, queueByPlayerId, slotOrderByPlayerId)
  for (const group of groups) {
    if (group.size > teamSlotCount) {
      return { error: 'One premade is larger than the lobby team size.' }
    }
  }

  const assignments = enumerateAssignments(groups, teamSlotCount, activeTeamCount)
  if (assignments.length === 0) {
    return { error: 'Could not find a valid team layout for the current premades.' }
  }

  const minSizeDiff = Math.min(...assignments.map(assignment => {
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
    const score = input.strategy === 'balance'
      ? scoreBalancedCandidate(teamIdsByTeam, ratingsByPlayerId)
      : 0
    const key = teamIdsByTeam.map(teamIds => teamIds.join(',')).join('|')

    return {
      assignment,
      score,
      key,
    } satisfies ArrangementCandidate
  })

  if (input.strategy === 'randomize') {
    const random = input.random ?? Math.random
    const index = Math.floor(random() * scoredCandidates.length)
    const chosen = scoredCandidates[index] ?? scoredCandidates[0]
    if (!chosen) return { error: 'Could not randomize teams for this lobby.' }
    const teamIdsByTeam = assignmentToTeams(chosen.assignment, groups, activeTeamCount)
    const randomizedTeams = teamIdsByTeam.map(teamIds => randomizeTeamOrder(teamIds, groups, random))
    return { slots: buildTeamSlots(teamSlotCount, randomizedTeams, input.slots.length) }
  }

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

function buildPremadeGroups(
  slottedPlayerIds: string[],
  queueByPlayerId: Map<string, QueueEntry>,
  slotOrderByPlayerId: Map<string, number>,
): PremadeGroup[] {
  const slottedSet = new Set(slottedPlayerIds)
  const adjacency = new Map<string, Set<string>>()

  for (const playerId of slottedPlayerIds) {
    adjacency.set(playerId, adjacency.get(playerId) ?? new Set<string>())
    const partyIds = queueByPlayerId.get(playerId)?.partyIds ?? []

    for (const teammateId of partyIds) {
      if (!slottedSet.has(teammateId)) continue
      adjacency.get(playerId)?.add(teammateId)
      const reverse = adjacency.get(teammateId) ?? new Set<string>()
      reverse.add(playerId)
      adjacency.set(teammateId, reverse)
    }
  }

  const groups: PremadeGroup[] = []
  const visited = new Set<string>()

  for (const playerId of slottedPlayerIds) {
    if (visited.has(playerId)) continue

    const stack = [playerId]
    const members: string[] = []
    visited.add(playerId)

    while (stack.length > 0) {
      const current = stack.pop()
      if (!current) continue
      members.push(current)

      const neighbors = adjacency.get(current)
      if (!neighbors) continue
      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) continue
        visited.add(neighbor)
        stack.push(neighbor)
      }
    }

    members.sort((left, right) => {
      const leftOrder = slotOrderByPlayerId.get(left) ?? Number.MAX_SAFE_INTEGER
      const rightOrder = slotOrderByPlayerId.get(right) ?? Number.MAX_SAFE_INTEGER
      if (leftOrder !== rightOrder) return leftOrder - rightOrder
      return left.localeCompare(right)
    })

    groups.push({
      playerIds: members,
      size: members.length,
    })
  }

  return groups
}

function enumerateAssignments(groups: PremadeGroup[], teamSize: number, teamTotal: number): GroupAssignment[] {
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
  groups: PremadeGroup[],
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

function randomizeTeamOrder(
  teamIds: string[],
  groups: PremadeGroup[],
  random: () => number,
): string[] {
  if (teamIds.length <= 1) return [...teamIds]

  const playerSet = new Set(teamIds)
  const teamGroups = groups
    .map(group => group.playerIds.filter(playerId => playerSet.has(playerId)))
    .filter(group => group.length > 0)

  const shuffledGroups = shuffle(teamGroups, random).map(group => shuffle(group, random))
  return shuffledGroups.flat()
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
