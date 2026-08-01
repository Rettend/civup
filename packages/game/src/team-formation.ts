import type { DraftSeat, DraftState, DraftStep, GameMode } from './types.ts'
import { isCaptainPickSupported } from './mode.ts'

export interface TeamFormationPlayerStats {
  publicRating: number
  rank: number | null
  gamesPlayed: number
  wins: number
}

export interface TeamFormationGroup {
  id: string
  seatIndices: number[]
}

export interface TeamFormationState {
  enabled: boolean
  phase: 'idle' | 'active' | 'done'
  /** Monotonic turn token used to reject delayed or duplicate picks. */
  revision: number
  firstTeam: 0 | 1 | null
  currentTeam: 0 | 1 | null
  captainSeatIndices: [number, number]
  teamSeatIndices: [number[], number[]]
  unassignedSeatIndices: number[]
  groups: TeamFormationGroup[]
  legalGroupIds: string[]
  consumedByTeam: [number, number]
  timerSeconds: number
  endsAt: number | null
  statsBySeat: Record<number, TeamFormationPlayerStats>
}

export interface TeamFormationSnapshot {
  enabled: boolean
  phase: TeamFormationState['phase']
  revision: number
  firstTeam: 0 | 1 | null
  currentTeam: 0 | 1 | null
  captainSeatIndices: [number, number]
  teamSeatIndices: [number[], number[]]
  unassignedSeatIndices: number[]
  groups: TeamFormationGroup[]
  legalGroupIds: string[]
  legalSeatIndices: number[]
  endsAt: number | null
  timerSeconds: number
  statsBySeat: Record<number, TeamFormationPlayerStats>
}

export type TeamFormationResult<T = TeamFormationState> = { state: T } | { error: string }

export const EMPTY_TEAM_FORMATION_STATE: TeamFormationState = {
  enabled: false,
  phase: 'idle',
  revision: 0,
  firstTeam: null,
  currentTeam: null,
  captainSeatIndices: [0, 1],
  teamSeatIndices: [[], []],
  unassignedSeatIndices: [],
  groups: [],
  legalGroupIds: [],
  consumedByTeam: [0, 0],
  timerSeconds: 0,
  endsAt: null,
  statsBySeat: {},
}

export function createTeamFormationState(input: {
  mode: GameMode
  seats: readonly DraftSeat[]
  partySeatIndices?: readonly (readonly number[])[]
  timerSeconds?: number
  statsBySeat?: Readonly<Record<number, TeamFormationPlayerStats>>
}): TeamFormationResult {
  if (!isCaptainPickSupported(input.mode, input.seats.length)) {
    return { error: 'Captain Pick is not supported for this lobby layout.' }
  }
  if (input.seats.length % 2 !== 0) return { error: 'Captain Pick requires two equal teams.' }

  const groupsResult = buildGroups(input.seats, input.partySeatIndices ?? [])
  if ('error' in groupsResult) return groupsResult
  const groups = groupsResult.groups
  const captainGroupA = groups.find(group => group.seatIndices.includes(0))
  const captainGroupB = groups.find(group => group.seatIndices.includes(1))
  if (!captainGroupA || !captainGroupB) return { error: 'Captain Pick could not resolve both captains.' }
  if (captainGroupA.id === captainGroupB.id) return { error: 'A party cannot contain both captains.' }
  for (const group of groups) {
    const guildIds = new Set(group.seatIndices.flatMap(index => input.seats[index]?.sourceGuild?.id ? [input.seats[index]!.sourceGuild!.id] : []))
    if (guildIds.size > 1) return { error: 'A party cannot contain players from different servers.' }
  }

  const teamSeatIndices: [number[], number[]] = [
    [0, ...captainGroupA.seatIndices.filter(seatIndex => seatIndex !== 0)],
    [1, ...captainGroupB.seatIndices.filter(seatIndex => seatIndex !== 1)],
  ]
  const consumedByTeam: [number, number] = [teamSeatIndices[0].length - 1, teamSeatIndices[1].length - 1]
  const teamQuota = (input.seats.length / 2) - 1
  if (consumedByTeam.some(consumed => consumed > teamQuota)) {
    return { error: 'A captain party is too large for its team.' }
  }

  const remainingGroups = groups.filter(group => group.id !== captainGroupA.id && group.id !== captainGroupB.id)
  const unassignedSeatIndices = remainingGroups.flatMap(group => group.seatIndices)
  const base: TeamFormationState = {
    enabled: true,
    phase: 'idle',
    revision: 0,
    firstTeam: null,
    currentTeam: null,
    captainSeatIndices: [0, 1],
    teamSeatIndices,
    unassignedSeatIndices,
    groups: remainingGroups,
    legalGroupIds: [],
    consumedByTeam,
    timerSeconds: normalizeTimer(input.timerSeconds),
    endsAt: null,
    statsBySeat: cloneStats(input.statsBySeat),
  }

  if (!isFormationFeasible(base, input.seats, 0) || !isFormationFeasible(base, input.seats, 1)) {
    return { error: 'Players cannot be assigned into legal Captain Pick teams.' }
  }
  return { state: base }
}

export function startTeamFormation(
  state: TeamFormationState,
  seats: readonly DraftSeat[],
  firstTeam: 0 | 1,
  now: number,
): TeamFormationResult {
  if (!state.enabled || state.phase !== 'idle') return { error: 'Captain Pick has already started.' }
  if (state.unassignedSeatIndices.length === 0) return { state: finishFormation({ ...state, firstTeam }) }

  const currentTeam = getNextTeamFormationOwner(firstTeam, getTeamQuota(seats), state.consumedByTeam)
  if (currentTeam == null) return { error: 'Captain Pick has no legal next captain.' }
  const active = withLegalGroups({
    ...state,
    phase: 'active',
    firstTeam,
    currentTeam,
    endsAt: state.timerSeconds > 0 ? now + state.timerSeconds * 1000 : null,
  }, seats)
  if (active.legalGroupIds.length === 0) return { error: 'Captain Pick has no legal player group for the current captain.' }
  return { state: active }
}

export function selectTeamFormationGroup(
  state: TeamFormationState,
  seats: readonly DraftSeat[],
  actorSeatIndex: number,
  groupId: string,
  expectedRevision: number,
  now: number,
): TeamFormationResult {
  if (!state.enabled || state.phase !== 'active' || state.currentTeam == null) return { error: 'Captain Pick is not active.' }
  if (expectedRevision !== state.revision) return { error: 'That Captain Pick turn has already changed.' }
  if (state.captainSeatIndices[state.currentTeam] !== actorSeatIndex) return { error: 'Only the current captain can pick a player.' }
  if (!state.legalGroupIds.includes(groupId)) return { error: 'That player group is not a legal pick.' }
  const group = state.groups.find(candidate => candidate.id === groupId)
  if (!group) return { error: 'That player group is no longer available.' }

  const team = state.currentTeam
  const groups = state.groups.filter(candidate => candidate.id !== groupId)
  const unassigned = new Set(state.unassignedSeatIndices)
  for (const seatIndex of group.seatIndices) unassigned.delete(seatIndex)
  const consumedByTeam: [number, number] = [...state.consumedByTeam]
  consumedByTeam[team] += group.seatIndices.length
  const teamSeatIndices: [number[], number[]] = [
    [...state.teamSeatIndices[0]],
    [...state.teamSeatIndices[1]],
  ]
  teamSeatIndices[team].push(...group.seatIndices)

  const next: TeamFormationState = {
    ...state,
    revision: state.revision + 1,
    teamSeatIndices,
    consumedByTeam,
    groups,
    unassignedSeatIndices: [...unassigned].sort((left, right) => left - right),
    legalGroupIds: [],
    endsAt: null,
  }
  if (next.unassignedSeatIndices.length === 0) return { state: finishFormation(next) }

  const currentTeam = getNextTeamFormationOwner(state.firstTeam!, getTeamQuota(seats), consumedByTeam)
  if (currentTeam == null) return { error: 'Captain Pick could not resolve the next captain.' }
  const active = withLegalGroups({
    ...next,
    currentTeam,
    endsAt: next.timerSeconds > 0 ? now + next.timerSeconds * 1000 : null,
  }, seats)
  if (active.legalGroupIds.length === 0) return { error: 'Captain Pick has no legal player group for the current captain.' }
  return { state: active }
}

export function selectTeamFormationTimeout(
  state: TeamFormationState,
  seats: readonly DraftSeat[],
  now: number,
  random: () => number,
): TeamFormationResult {
  if (!state.enabled || state.phase !== 'active' || state.currentTeam == null) return { error: 'Captain Pick is not active.' }
  const legal = state.legalGroupIds
  if (legal.length === 0) return { error: 'Captain Pick has no legal timeout selection.' }
  const index = Math.min(legal.length - 1, Math.max(0, Math.floor(random() * legal.length)))
  return selectTeamFormationGroup(state, seats, state.captainSeatIndices[state.currentTeam], legal[index]!, state.revision, now)
}

export function buildTeamFormationSnapshot(state: TeamFormationState): TeamFormationSnapshot {
  const compact = !state.enabled || state.phase === 'done'
  const legalGroupSet = new Set(state.legalGroupIds)
  return {
    enabled: state.enabled,
    phase: state.phase,
    revision: state.revision,
    firstTeam: state.firstTeam,
    currentTeam: state.currentTeam,
    captainSeatIndices: [...state.captainSeatIndices],
    teamSeatIndices: [[...state.teamSeatIndices[0]], [...state.teamSeatIndices[1]]],
    unassignedSeatIndices: [...state.unassignedSeatIndices],
    groups: compact ? [] : state.groups.map(group => ({ id: group.id, seatIndices: [...group.seatIndices] })),
    legalGroupIds: compact ? [] : [...state.legalGroupIds],
    legalSeatIndices: compact
      ? []
      : state.groups.filter(group => legalGroupSet.has(group.id)).flatMap(group => group.seatIndices),
    endsAt: state.endsAt,
    timerSeconds: state.timerSeconds,
    statsBySeat: compact ? {} : cloneStats(state.statsBySeat),
  }
}

export function applyTeamFormationToDraftState(state: DraftState, formation: TeamFormationState): TeamFormationResult<DraftState> {
  if (!formation.enabled || formation.phase !== 'done') return { error: 'Captain Pick is not complete.' }
  if (state.status !== 'waiting' || state.currentStepIndex !== -1) return { error: 'Draft already started before Captain Pick completed.' }
  if (state.bans.length > 0 || state.picks.length > 0 || state.pendingBlindBans.length > 0 || Object.keys(state.submissions).length > 0) {
    return { error: 'Draft selections already exist before Captain Pick completed.' }
  }
  if (formation.teamSeatIndices.some(team => team.length !== state.seats.length / 2)) return { error: 'Captain Pick teams are incomplete.' }

  const seatIndexMap = buildTeamFormationSeatIndexMap(formation.teamSeatIndices)
  const teamBySeat = new Map<number, number>()
  formation.teamSeatIndices.forEach((seatIndices, team) => {
    for (const seatIndex of seatIndices) teamBySeat.set(seatIndex, team)
  })
  if (teamBySeat.size !== state.seats.length) return { error: 'Captain Pick team assignments are invalid.' }

  return {
    state: {
      ...state,
      seats: state.seats.map((seat, seatIndex) => ({ ...seat, team: teamBySeat.get(seatIndex) })),
      steps: remapDraftSteps(state.steps, seatIndexMap),
    },
  }
}

export function buildTeamFormationSeatIndexMap(teamSeatIndices: readonly (readonly number[])[]): Map<number, number> {
  const map = new Map<number, number>()
  const teamCount = teamSeatIndices.length
  teamSeatIndices.forEach((seatIndices, team) => {
    seatIndices.forEach((seatIndex, position) => map.set(position * teamCount + team, seatIndex))
  })
  return map
}

/** Remap every seat-bearing field in a draft step. */
export function remapDraftSteps(steps: readonly DraftStep[], seatIndexMap: ReadonlyMap<number, number>): DraftStep[] {
  return steps.map((step) => {
    const fallbackPickOrder = step.fallbackPickOrder?.map(seatIndex => remapSeatIndex(seatIndex, seatIndexMap))
    const civBlitzCategoriesBySeat = step.civBlitzCategoriesBySeat
      ? remapSeatRecord(step.civBlitzCategoriesBySeat, seatIndexMap, categories => [...categories])
      : undefined
    return {
      ...step,
      seats: step.seats === 'all' ? 'all' : step.seats.map(seatIndex => remapSeatIndex(seatIndex, seatIndexMap)),
      ...(fallbackPickOrder ? { fallbackPickOrder } : {}),
      ...(civBlitzCategoriesBySeat ? { civBlitzCategoriesBySeat } : {}),
    }
  })
}

export function getTeamFormationSnakeOrder(teamSize: number, firstTeam: 0 | 1): Array<0 | 1> {
  const quota = Math.max(0, Math.round(teamSize) - 1)
  const order: Array<0 | 1> = []
  for (let index = 0; index < quota * 2; index++) {
    const base = Math.floor((index + 1) / 2) % 2 as 0 | 1
    order.push((firstTeam === 0 ? base : 1 - base) as 0 | 1)
  }
  return order
}

export function getNextTeamFormationOwner(
  firstTeam: 0 | 1,
  quota: number,
  consumedByTeam: readonly [number, number],
): 0 | 1 | null {
  const seen: [number, number] = [0, 0]
  for (const team of getTeamFormationSnakeOrder(quota + 1, firstTeam)) {
    seen[team] += 1
    if (seen[team] > consumedByTeam[team]) return team
  }
  return null
}

function withLegalGroups(state: TeamFormationState, seats: readonly DraftSeat[]): TeamFormationState {
  if (state.currentTeam == null || state.firstTeam == null) return { ...state, legalGroupIds: [] }
  const legalGroupIds = state.groups
    .filter(group => canAssignGroupToTeam(group, state.currentTeam!, state, seats))
    .filter((group) => {
      const next = assignGroupForFeasibility(state, group, state.currentTeam!)
      return isFormationFeasible(next, seats, state.firstTeam!)
    })
    .map(group => group.id)
  return { ...state, legalGroupIds }
}

function isFormationFeasible(state: TeamFormationState, seats: readonly DraftSeat[], firstTeam: 0 | 1): boolean {
  if (state.groups.length === 0) {
    const quota = getTeamQuota(seats)
    return state.consumedByTeam[0] === quota && state.consumedByTeam[1] === quota
  }
  const team = getNextTeamFormationOwner(firstTeam, getTeamQuota(seats), state.consumedByTeam)
  if (team == null) return false
  for (const group of state.groups) {
    if (!canAssignGroupToTeam(group, team, state, seats)) continue
    if (isFormationFeasible(assignGroupForFeasibility(state, group, team), seats, firstTeam)) return true
  }
  return false
}

function canAssignGroupToTeam(group: TeamFormationGroup, team: 0 | 1, state: TeamFormationState, seats: readonly DraftSeat[]): boolean {
  if (state.consumedByTeam[team] + group.seatIndices.length > getTeamQuota(seats)) return false
  const captainGuildId = seats[state.captainSeatIndices[team]]?.sourceGuild?.id ?? null
  const groupGuildIds = new Set(group.seatIndices.flatMap(seatIndex => seats[seatIndex]?.sourceGuild?.id ? [seats[seatIndex]!.sourceGuild!.id] : []))
  if (groupGuildIds.size > 1) return false
  const groupGuildId = [...groupGuildIds][0] ?? null
  return captainGuildId == null ? groupGuildId == null : groupGuildId === captainGuildId
}

function assignGroupForFeasibility(state: TeamFormationState, group: TeamFormationGroup, team: 0 | 1): TeamFormationState {
  const consumedByTeam: [number, number] = [...state.consumedByTeam]
  consumedByTeam[team] += group.seatIndices.length
  return {
    ...state,
    consumedByTeam,
    groups: state.groups.filter(candidate => candidate.id !== group.id),
  }
}

function finishFormation(state: TeamFormationState): TeamFormationState {
  return {
    ...state,
    phase: 'done',
    currentTeam: null,
    unassignedSeatIndices: [],
    groups: [],
    legalGroupIds: [],
    endsAt: null,
    statsBySeat: {},
  }
}

function buildGroups(seats: readonly DraftSeat[], parties: readonly (readonly number[])[]): { groups: TeamFormationGroup[] } | { error: string } {
  const adjacency = new Map<number, Set<number>>(seats.map((_, seatIndex) => [seatIndex, new Set()]))
  for (const party of parties) {
    const normalized = [...new Set(party.filter(seatIndex => Number.isInteger(seatIndex) && seatIndex >= 0 && seatIndex < seats.length))]
    for (const left of normalized) {
      for (const right of normalized) {
        if (left !== right) adjacency.get(left)?.add(right)
      }
    }
  }

  const groups: TeamFormationGroup[] = []
  const visited = new Set<number>()
  for (let seatIndex = 0; seatIndex < seats.length; seatIndex++) {
    if (visited.has(seatIndex)) continue
    const pending = [seatIndex]
    const group: number[] = []
    visited.add(seatIndex)
    while (pending.length > 0) {
      const current = pending.shift()!
      group.push(current)
      for (const related of adjacency.get(current) ?? []) {
        if (visited.has(related)) continue
        visited.add(related)
        pending.push(related)
      }
    }
    group.sort((left, right) => left - right)
    groups.push({ id: `group:${group[0]}`, seatIndices: group })
  }
  return { groups }
}

function getTeamQuota(seats: readonly DraftSeat[]): number {
  return Math.max(0, (seats.length / 2) - 1)
}

function normalizeTimer(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.round(value))
}

function cloneStats(value: Readonly<Record<number, TeamFormationPlayerStats>> | undefined): Record<number, TeamFormationPlayerStats> {
  if (!value) return {}
  return Object.fromEntries(Object.entries(value).map(([seatIndex, stats]) => [seatIndex, { ...stats }]))
}

function remapSeatRecord<T>(record: Record<number, T>, map: ReadonlyMap<number, number>, clone: (value: T) => T): Record<number, T> {
  return Object.fromEntries(Object.entries(record).map(([seatIndex, value]) => [remapSeatIndex(Number(seatIndex), map), clone(value)]))
}

function remapSeatIndex(seatIndex: number, map: ReadonlyMap<number, number>): number {
  return map.get(seatIndex) ?? seatIndex
}
