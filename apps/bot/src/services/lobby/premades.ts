import type { GameMode, QueueEntry } from '@civup/game'
import { maxPlayerCount, teamCount as modeTeamCount, teamSize as modeTeamSize, slotToTeamIndex } from '@civup/game'

export interface SlottedPremadeGroup {
  playerIds: string[]
  slots: number[]
  teamIndex: number
}

export function buildSlottedPremadeGroups(
  mode: GameMode,
  slots: (string | null)[],
  queueEntries: QueueEntry[],
): SlottedPremadeGroup[] {
  const teamSize = modeTeamSize(mode)
  if (!teamSize) return []

  const slottedPlayerIds = slots.filter((playerId): playerId is string => playerId != null)
  if (slottedPlayerIds.length === 0) return []

  const slotByPlayerId = new Map<string, number>()
  for (let index = 0; index < slots.length; index++) {
    const playerId = slots[index]
    if (!playerId || slotByPlayerId.has(playerId)) continue
    slotByPlayerId.set(playerId, index)
  }

  const queueByPlayerId = new Map(queueEntries.map(entry => [entry.playerId, entry]))
  const groups = buildGroupsFromPartyIds(slottedPlayerIds, queueByPlayerId, slotByPlayerId)

  return groups.map((group) => {
    const groupSlots = group
      .map(playerId => slotByPlayerId.get(playerId))
      .filter((slot): slot is number => slot != null)
      .sort((left, right) => left - right)
    const firstSlot = groupSlots[0] ?? 0
    return {
      playerIds: group,
      slots: groupSlots,
      teamIndex: slotToTeamIndex(mode, firstSlot, slots.length) ?? 0,
    }
  })
}

export function arePremadeGroupsAdjacent(
  mode: GameMode,
  slots: (string | null)[],
  queueEntries: QueueEntry[],
): boolean {
  const groups = buildSlottedPremadeGroups(mode, slots, queueEntries)
  for (const group of groups) {
    if (group.slots.length <= 1) continue

    const firstSlot = group.slots[0]
    if (firstSlot == null) return false
    const teamIndex = slotToTeamIndex(mode, firstSlot)
    if (teamIndex == null) return false

    for (let index = 1; index < group.slots.length; index++) {
      const previousSlot = group.slots[index - 1]
      const currentSlot = group.slots[index]
      if (previousSlot == null || currentSlot == null) return false
      if (slotToTeamIndex(mode, currentSlot) !== teamIndex) return false
      if (currentSlot !== previousSlot + 1) return false
    }
  }

  return true
}

export function buildActivePremadeEdgeSet(
  mode: GameMode,
  slots: (string | null)[],
  queueEntries: QueueEntry[],
): Set<number> {
  const edges = new Set<number>()
  const groups = buildSlottedPremadeGroups(mode, slots, queueEntries)

  for (const group of groups) {
    for (let index = 0; index < group.slots.length - 1; index++) {
      const leftSlot = group.slots[index]
      const rightSlot = group.slots[index + 1]
      if (leftSlot == null || rightSlot == null) continue
      if (rightSlot !== leftSlot + 1) continue
      if (slotToTeamIndex(mode, leftSlot) !== slotToTeamIndex(mode, rightSlot)) continue
      edges.add(leftSlot)
    }
  }

  return edges
}

export function moveSlottedPremadeGroup(
  mode: GameMode,
  slots: (string | null)[],
  group: SlottedPremadeGroup,
  sourceSlot: number,
  targetSlot: number,
): { slots: (string | null)[] } | { error: string } {
  if (group.playerIds.length <= 1) {
    return { slots: [...slots] }
  }

  if (!group.slots.includes(sourceSlot)) {
    return { error: 'Could not locate this linked premade in the current slots.' }
  }

  if (group.slots.includes(targetSlot)) {
    return { slots: [...slots] }
  }

  const groupPlayerSet = new Set(group.playerIds)
  const currentStart = Math.min(...group.slots)
  const candidateSegments = buildContiguousSegments(mode, group.playerIds.length)
    .filter(segment => segment.includes(targetSlot))
    .filter((segment) => {
      for (const destination of segment) {
        const occupant = slots[destination]
        if (occupant && !groupPlayerSet.has(occupant)) return false
      }
      return true
    })
    .sort((left, right) => {
      const leftDistance = Math.abs((left[0] ?? 0) - currentStart)
      const rightDistance = Math.abs((right[0] ?? 0) - currentStart)
      if (leftDistance !== rightDistance) return leftDistance - rightDistance
      return (left[0] ?? 0) - (right[0] ?? 0)
    })

  const destinationSlots = candidateSegments[0]
  if (!destinationSlots) {
    return { error: 'Choose open slots for the linked premade.' }
  }

  const nextSlots = [...slots]
  for (const slot of group.slots) {
    nextSlots[slot] = null
  }

  for (let index = 0; index < group.playerIds.length; index++) {
    const playerId = group.playerIds[index]
    const destination = destinationSlots[index]
    if (!playerId || destination == null) continue
    nextSlots[destination] = playerId
  }

  return { slots: nextSlots }
}

export function rebuildQueueEntriesFromPremadeEdgeSet(
  mode: GameMode,
  slots: (string | null)[],
  queueEntries: QueueEntry[],
  activeEdges: Set<number>,
): QueueEntry[] {
  const teamSize = modeTeamSize(mode)
  if (!teamSize) return queueEntries

  const queueOrderByPlayerId = new Map<string, number>()
  for (let index = 0; index < queueEntries.length; index++) {
    const entry = queueEntries[index]
    if (!entry || queueOrderByPlayerId.has(entry.playerId)) continue
    queueOrderByPlayerId.set(entry.playerId, index)
  }

  const slottedPlayerIds = slots.filter((playerId): playerId is string => playerId != null)
  const slottedSet = new Set(slottedPlayerIds)
  const slottedAdjacency = new Map<string, Set<string>>()

  for (const playerId of slottedPlayerIds) {
    slottedAdjacency.set(playerId, new Set<string>())
  }

  for (const leftSlot of activeEdges) {
    const rightSlot = leftSlot + 1
    const leftPlayerId = slots[leftSlot]
    const rightPlayerId = slots[rightSlot]
    if (!leftPlayerId || !rightPlayerId) continue
    if (slotToTeamIndex(mode, leftSlot) == null || slotToTeamIndex(mode, leftSlot) !== slotToTeamIndex(mode, rightSlot)) continue
    slottedAdjacency.get(leftPlayerId)?.add(rightPlayerId)
    slottedAdjacency.get(rightPlayerId)?.add(leftPlayerId)
  }

  const slottedGroups = buildGroupsFromAdjacency(slottedPlayerIds, slottedAdjacency, buildSlotOrderMap(slots))

  const queueByPlayerId = new Map(queueEntries.map(entry => [entry.playerId, entry]))
  const unslottedPlayerIds = queueEntries
    .map(entry => entry.playerId)
    .filter(playerId => !slottedSet.has(playerId))
  const unslottedGroups = buildGroupsFromPartyIds(unslottedPlayerIds, queueByPlayerId, queueOrderByPlayerId)

  const groupByPlayerId = new Map<string, string[]>()
  for (const group of [...slottedGroups, ...unslottedGroups]) {
    for (const playerId of group) {
      groupByPlayerId.set(playerId, group)
    }
  }

  return queueEntries.map((entry) => {
    const group = groupByPlayerId.get(entry.playerId) ?? [entry.playerId]
    const nextPartyIds = group.filter(playerId => playerId !== entry.playerId)
    return {
      ...entry,
      partyIds: nextPartyIds.length > 0 ? nextPartyIds : undefined,
    }
  })
}

export function compactSlottedPremadesForMode(
  mode: GameMode,
  orderedPlayerIds: string[],
  queueEntries: QueueEntry[],
): { slots: (string | null)[] } | { error: string } {
  const targetSize = maxPlayerCount(mode)
  const normalizedOrderedPlayers = orderedPlayerIds.slice(0, targetSize)

  if (mode === 'ffa') {
    const slots = Array.from({ length: targetSize }, () => null as string | null)
    for (let index = 0; index < targetSize; index++) {
      slots[index] = normalizedOrderedPlayers[index] ?? null
    }
    return { slots }
  }

  const teamSize = modeTeamSize(mode)
  if (!teamSize) {
    return { error: 'Linked premades do not fit this mode.' }
  }
  const activeTeamCount = modeTeamCount(mode, normalizedOrderedPlayers.length)

  const queueByPlayerId = new Map(queueEntries.map(entry => [entry.playerId, entry]))
  const orderByPlayerId = new Map(normalizedOrderedPlayers.map((playerId, index) => [playerId, index]))
  const groups = buildGroupsFromPartyIds(normalizedOrderedPlayers, queueByPlayerId, orderByPlayerId)

  if (groups.some(group => group.length > teamSize)) {
    return { error: 'Linked premades do not fit this mode.' }
  }

  const teams = Array.from({ length: activeTeamCount }, () => [] as string[])
  for (const group of groups) {
    const destination = teams.find(team => team.length + group.length <= teamSize)
    if (!destination) {
      return { error: 'Linked premades do not fit this mode.' }
    }
    destination.push(...group)
  }

  const slots = Array.from({ length: targetSize }, () => null as string | null)
  for (let team = 0; team < teams.length; team++) {
    const teamIds = teams[team] ?? []
    for (let index = 0; index < teamSize; index++) {
      slots[team * teamSize + index] = teamIds[index] ?? null
    }
  }
  return { slots }
}

function buildContiguousSegments(mode: GameMode, size: number): number[][] {
  const teamSize = modeTeamSize(mode)
  if (!teamSize || size <= 0 || size > teamSize) return []
  const totalTeams = modeTeamCount(mode, maxPlayerCount(mode))

  const segments: number[][] = []
  for (let team = 0; team < totalTeams; team++) {
    const teamStart = team * teamSize
    for (let start = teamStart; start <= teamStart + teamSize - size; start++) {
      segments.push(Array.from({ length: size }, (_, index) => start + index))
    }
  }
  return segments
}

function buildGroupsFromPartyIds(
  playerIds: string[],
  queueByPlayerId: Map<string, QueueEntry>,
  orderByPlayerId: Map<string, number>,
): string[][] {
  const adjacency = new Map<string, Set<string>>()
  const allowedIds = new Set(playerIds)

  for (const playerId of playerIds) {
    adjacency.set(playerId, adjacency.get(playerId) ?? new Set<string>())
    const partyIds = queueByPlayerId.get(playerId)?.partyIds ?? []
    for (const teammateId of partyIds) {
      if (!allowedIds.has(teammateId)) continue
      adjacency.get(playerId)?.add(teammateId)
      const reverse = adjacency.get(teammateId) ?? new Set<string>()
      reverse.add(playerId)
      adjacency.set(teammateId, reverse)
    }
  }

  return buildGroupsFromAdjacency(playerIds, adjacency, orderByPlayerId)
}

function buildGroupsFromAdjacency(
  playerIds: string[],
  adjacency: Map<string, Set<string>>,
  orderByPlayerId: Map<string, number>,
): string[][] {
  const groups: string[][] = []
  const visited = new Set<string>()

  for (const playerId of playerIds) {
    if (visited.has(playerId)) continue

    const stack = [playerId]
    const group: string[] = []
    visited.add(playerId)

    while (stack.length > 0) {
      const current = stack.pop()
      if (!current) continue
      group.push(current)

      const neighbors = adjacency.get(current)
      if (!neighbors) continue
      for (const neighbor of neighbors) {
        if (visited.has(neighbor)) continue
        visited.add(neighbor)
        stack.push(neighbor)
      }
    }

    group.sort((left, right) => {
      const leftOrder = orderByPlayerId.get(left) ?? Number.MAX_SAFE_INTEGER
      const rightOrder = orderByPlayerId.get(right) ?? Number.MAX_SAFE_INTEGER
      if (leftOrder !== rightOrder) return leftOrder - rightOrder
      return left.localeCompare(right)
    })

    groups.push(group)
  }

  return groups
}

function buildSlotOrderMap(slots: (string | null)[]): Map<string, number> {
  const orderByPlayerId = new Map<string, number>()
  for (let index = 0; index < slots.length; index++) {
    const playerId = slots[index]
    if (!playerId || orderByPlayerId.has(playerId)) continue
    orderByPlayerId.set(playerId, index)
  }
  return orderByPlayerId
}
