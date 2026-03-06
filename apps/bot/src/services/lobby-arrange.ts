import type { GameMode, QueueEntry } from '@civup/game'
import type { PlayerRating } from '@civup/rating'
import { createRating, predictWinProbabilities } from '@civup/rating'

export type TeamArrangeStrategy = 'randomize' | 'balance'

interface RatingSnapshot {
  mu: number
  sigma: number
}

interface PremadeGroup {
  playerIds: string[]
  size: number
}

interface GroupAssignment {
  teamByGroup: (0 | 1)[]
  teamACount: number
  teamBCount: number
}

interface ArrangementCandidate {
  assignment: GroupAssignment
  score: number
  key: string
}

export interface ArrangeTeamLobbySlotsInput {
  mode: GameMode
  slots: (string | null)[]
  queueEntries: QueueEntry[]
  strategy: TeamArrangeStrategy
  ratingsByPlayerId?: Map<string, RatingSnapshot>
  random?: () => number
}

export function arrangeTeamLobbySlots(
  input: ArrangeTeamLobbySlotsInput,
): { slots: (string | null)[] } | { error: string } {
  if (input.mode !== '2v2' && input.mode !== '3v3') {
    return { error: 'Team arrange actions are only available in 2v2 and 3v3 lobbies.' }
  }

  const teamSize = input.mode === '2v2' ? 2 : 3
  const queueByPlayerId = new Map(input.queueEntries.map(entry => [entry.playerId, entry]))
  const slottedPlayerIds = input.slots.filter((playerId): playerId is string => playerId != null)

  if (slottedPlayerIds.length === 0) {
    return { slots: Array.from({ length: teamSize * 2 }, () => null as string | null) }
  }

  const slotOrderByPlayerId = new Map<string, number>()
  for (let index = 0; index < input.slots.length; index++) {
    const playerId = input.slots[index]
    if (!playerId || slotOrderByPlayerId.has(playerId)) continue
    slotOrderByPlayerId.set(playerId, index)
  }

  const groups = buildPremadeGroups(slottedPlayerIds, queueByPlayerId, slotOrderByPlayerId)
  for (const group of groups) {
    if (group.size > teamSize) {
      return { error: 'One premade is larger than the lobby team size.' }
    }
  }

  const assignments = enumerateAssignments(groups, teamSize)
  if (assignments.length === 0) {
    return { error: 'Could not find a valid team layout for the current premades.' }
  }

  const minSizeDiff = Math.min(...assignments.map(assignment => Math.abs(assignment.teamACount - assignment.teamBCount)))
  const candidateAssignments = assignments.filter(
    assignment => Math.abs(assignment.teamACount - assignment.teamBCount) === minSizeDiff,
  )

  const ratingsByPlayerId = input.ratingsByPlayerId ?? new Map<string, RatingSnapshot>()
  const scoredCandidates = candidateAssignments.map((assignment) => {
    const { teamAIds, teamBIds } = assignmentToTeams(assignment, groups)
    const score = input.strategy === 'balance'
      ? scoreBalancedCandidate(teamAIds, teamBIds, ratingsByPlayerId)
      : 0
    const key = `${teamAIds.join(',')}|${teamBIds.join(',')}`

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
    const { teamAIds, teamBIds } = assignmentToTeams(chosen.assignment, groups)
    const randomizedTeamA = randomizeTeamOrder(teamAIds, groups, random)
    const randomizedTeamB = randomizeTeamOrder(teamBIds, groups, random)
    return { slots: buildTeamSlots(teamSize, randomizedTeamA, randomizedTeamB) }
  }

  const minScore = Math.min(...scoredCandidates.map(candidate => candidate.score))
  const tied = scoredCandidates
    .filter(candidate => candidate.score === minScore)
    .sort((left, right) => left.key.localeCompare(right.key))
  const chosen = tied[0]
  if (!chosen) return { error: 'Could not auto-balance teams for this lobby.' }

  const { teamAIds, teamBIds } = assignmentToTeams(chosen.assignment, groups)
  return { slots: buildTeamSlots(teamSize, teamAIds, teamBIds) }
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

function enumerateAssignments(groups: PremadeGroup[], teamSize: number): GroupAssignment[] {
  if (groups.length === 0) {
    return [{ teamByGroup: [], teamACount: 0, teamBCount: 0 }]
  }

  const assignments: GroupAssignment[] = []
  const firstGroupSize = groups[0]?.size ?? 0
  if (firstGroupSize > teamSize) return []

  const teamByGroup: (0 | 1)[] = [0]

  const walk = (index: number, teamACount: number, teamBCount: number) => {
    if (index >= groups.length) {
      assignments.push({
        teamByGroup: [...teamByGroup],
        teamACount,
        teamBCount,
      })
      return
    }

    const group = groups[index]
    if (!group) return

    if (teamACount + group.size <= teamSize) {
      teamByGroup[index] = 0
      walk(index + 1, teamACount + group.size, teamBCount)
    }

    if (teamBCount + group.size <= teamSize) {
      teamByGroup[index] = 1
      walk(index + 1, teamACount, teamBCount + group.size)
    }
  }

  walk(1, firstGroupSize, 0)
  return assignments
}

function assignmentToTeams(
  assignment: GroupAssignment,
  groups: PremadeGroup[],
): { teamAIds: string[], teamBIds: string[] } {
  const teamAIds: string[] = []
  const teamBIds: string[] = []

  for (let index = 0; index < groups.length; index++) {
    const group = groups[index]
    if (!group) continue

    const team = assignment.teamByGroup[index]
    if (team === 0) {
      teamAIds.push(...group.playerIds)
      continue
    }

    teamBIds.push(...group.playerIds)
  }

  return { teamAIds, teamBIds }
}

function scoreBalancedCandidate(
  teamAIds: string[],
  teamBIds: string[],
  ratingsByPlayerId: Map<string, RatingSnapshot>,
): number {
  if (teamAIds.length === 0 || teamBIds.length === 0) return Number.POSITIVE_INFINITY

  const teamA = teamAIds.map(playerId => toPlayerRating(playerId, ratingsByPlayerId))
  const teamB = teamBIds.map(playerId => toPlayerRating(playerId, ratingsByPlayerId))

  try {
    const probabilities = predictWinProbabilities([teamA, teamB])
    const teamAWinChance = probabilities[0]
    if (typeof teamAWinChance !== 'number' || !Number.isFinite(teamAWinChance)) {
      return Number.POSITIVE_INFINITY
    }
    return Math.abs(teamAWinChance - 0.5)
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

function buildTeamSlots(teamSize: number, teamAIds: string[], teamBIds: string[]): (string | null)[] {
  const slots = Array.from({ length: teamSize * 2 }, () => null as string | null)

  for (let index = 0; index < teamSize; index++) {
    slots[index] = teamAIds[index] ?? null
    slots[teamSize + index] = teamBIds[index] ?? null
  }

  return slots
}
