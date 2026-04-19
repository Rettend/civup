import type { GameMode } from './types.ts'
import { isTeamMode } from './mode.ts'

export const MAP_TYPE_IDS = ['standard', 'east-vs-west', 'random'] as const
export type MapTypeId = (typeof MAP_TYPE_IDS)[number]

export const MAP_SCRIPT_IDS = [
  'pangaea-ultima',
  'pangaea-ultima-no-wrap',
  'seven-seas',
  'rich-highlands',
  'lakes',
  'tilted-axis',
  'primordial',
  'inland-sea',
  'random',
] as const
export type MapScriptId = (typeof MAP_SCRIPT_IDS)[number]

export interface MapTypeOption {
  id: MapTypeId
  name: string
  description: string
}

export interface MapScriptOption {
  id: MapScriptId
  name: string
  hint?: string
  imageUrl?: string
  icon?: string
}

export interface MapVoteSelection {
  mapTypes: MapTypeId[]
  mapScripts: MapScriptId[]
}

export interface RevealedMapVoteSeatBallot extends MapVoteSelection {
  seatIndex: number
  confirmed: boolean
}

export interface RankedChoiceTieBreak<T extends string> {
  rule: 'original-first-choice' | 'total-mentions' | 'seeded-random'
  candidates: T[]
  chosenId: T
}

export interface RankedChoiceRoundTally<T extends string> {
  id: T
  votes: number
}

export interface RankedChoiceRound<T extends string> {
  round: number
  tallies: RankedChoiceRoundTally<T>[]
  activeBallotCount: number
  majorityThreshold: number
  eliminatedId: T | null
  winnerId: T | null
  tieBreak: RankedChoiceTieBreak<T> | null
}

export interface ResolvedMapVoteResult {
  mapType: Exclude<MapTypeId, 'random'>
  mapScript: Exclude<MapScriptId, 'random'>
  winningSeatCount: number
  seed: string
  mapTypeWinner: MapTypeId
  mapScriptWinner: MapScriptId
  mapTypeRounds: RankedChoiceRound<MapTypeId>[]
  mapScriptRounds: RankedChoiceRound<MapScriptId>[]
  resolvedRandomMapType: Exclude<MapTypeId, 'random'> | null
  resolvedRandomMapScript: Exclude<MapScriptId, 'random'> | null
}

export type MapVotePhase = 'idle' | 'voting' | 'reveal' | 'done'

export interface MapVoteSnapshot {
  enabled: boolean
  supported: boolean
  phase: MapVotePhase
  endsAt: number | null
  selection: MapVoteSelection | null
  hasConfirmed: boolean
  confirmedSeatIndices: number[]
  revealedVotes: RevealedMapVoteSeatBallot[] | null
  result: ResolvedMapVoteResult | null
}

interface LegacyMapVoteSelection {
  mapType?: unknown
  mapTypes?: unknown
  mapScripts?: unknown
}

interface RankedChoiceResolution<T extends string> {
  winnerId: T
  rounds: RankedChoiceRound<T>[]
  finalVotes: number
}

export const MAP_VOTE_VOTING_DURATION_MS = 60_000
export const MAP_VOTE_REVEAL_DURATION_MS = 5_000
export const MAP_VOTE_VOTING_DURATION_SECONDS = MAP_VOTE_VOTING_DURATION_MS / 1000
export const MAP_VOTE_REVEAL_DURATION_SECONDS = MAP_VOTE_REVEAL_DURATION_MS / 1000
export const MAX_MAP_VOTE_MAP_TYPE_PICKS = MAP_TYPE_IDS.length
export const MAX_MAP_VOTE_MAP_SCRIPT_PICKS = 3

export const MAP_TYPES: readonly MapTypeOption[] = [
  { id: 'standard', name: 'Standard', description: 'Teams scattered across the map' },
  { id: 'east-vs-west', name: 'East vs West', description: 'Teams on opposite sides' },
  { id: 'random', name: 'Random', description: 'Picks one at random' },
]

export const MAP_SCRIPTS: readonly MapScriptOption[] = [
  { id: 'pangaea-ultima', name: 'Pangaea Ultima', hint: 'Wrap', imageUrl: '/assets/maps/Map_Pangaea.webp' },
  { id: 'pangaea-ultima-no-wrap', name: 'Pangaea Ultima', hint: 'No Wrap', imageUrl: '/assets/maps/Map_Pangaea.webp' },
  { id: 'seven-seas', name: 'Seven Seas', imageUrl: '/assets/maps/Map_Seven_Seas.webp' },
  { id: 'rich-highlands', name: 'Rich Highlands', imageUrl: '/assets/maps/Map_4_Leaf.webp' },
  { id: 'lakes', name: 'Lakes', imageUrl: '/assets/maps/Map_Lakes.webp' },
  { id: 'tilted-axis', name: 'Tilted Axis', imageUrl: '/assets/maps/Map_Tilted_Axis.webp' },
  { id: 'primordial', name: 'Primordial', imageUrl: '/assets/maps/Map_Primodial.webp' },
  { id: 'inland-sea', name: 'Inland Sea', imageUrl: '/assets/maps/Map_Inland_Sea.webp' },
  { id: 'random', name: 'Random', icon: 'i-ph-dice-five-bold' },
]

export const MAP_TYPE_BY_ID: Record<MapTypeId, MapTypeOption> = Object.fromEntries(
  MAP_TYPES.map(option => [option.id, option]),
) as Record<MapTypeId, MapTypeOption>

export const MAP_SCRIPT_BY_ID: Record<MapScriptId, MapScriptOption> = Object.fromEntries(
  MAP_SCRIPTS.map(option => [option.id, option]),
) as Record<MapScriptId, MapScriptOption>

export const DEFAULT_MAP_VOTE_SELECTION: MapVoteSelection = {
  mapTypes: [],
  mapScripts: [],
}

export const EMPTY_MAP_VOTE_SNAPSHOT: MapVoteSnapshot = {
  enabled: false,
  supported: false,
  phase: 'idle',
  endsAt: null,
  selection: null,
  hasConfirmed: false,
  confirmedSeatIndices: [],
  revealedVotes: null,
  result: null,
}

export function isMapTypeId(value: string | null | undefined): value is MapTypeId {
  return value != null && MAP_TYPE_IDS.includes(value as MapTypeId)
}

export function isMapScriptId(value: string | null | undefined): value is MapScriptId {
  return value != null && MAP_SCRIPT_IDS.includes(value as MapScriptId)
}

export function isMapVoteSupportedForMode(mode: GameMode, options: { redDeath?: boolean } = {}): boolean {
  if (options.redDeath) return false
  return isTeamMode(mode)
}

export function normalizeMapVoteEnabled(mode: GameMode, enabled: boolean, options: { redDeath?: boolean } = {}): boolean {
  return isMapVoteSupportedForMode(mode, options) && enabled === true
}

export function formatMapVoteResultLabel(mapType: MapTypeId | null | undefined, mapScript: MapScriptId | null | undefined): string {
  const scriptOption = mapScript ? MAP_SCRIPT_BY_ID[mapScript] : null
  const scriptName = scriptOption?.name ?? ''
  if (!scriptName) return mapTypeLabel(mapType)
  const scriptLabel = scriptOption?.hint ? `${scriptName} (${scriptOption.hint})` : scriptName
  if (mapType === 'east-vs-west') return `${scriptLabel} EvW`
  const typeLabel = mapTypeLabel(mapType)
  return typeLabel ? `${typeLabel} ${scriptLabel}` : scriptLabel
}

export function createMapVoteRng(seed: string): () => number {
  let hash = 2166136261
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  let state = hash >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let next = Math.imul(state ^ (state >>> 15), 1 | state)
    next ^= next + Math.imul(next ^ (next >>> 7), 61 | next)
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296
  }
}

export function pickRandomMapType(rng: () => number, exclude: readonly MapTypeId[] = []): Exclude<MapTypeId, 'random'> {
  return pickRandomId<Exclude<MapTypeId, 'random'>>(
    MAP_TYPES.map(option => option.id).filter((id): id is Exclude<MapTypeId, 'random'> => id !== 'random' && !exclude.includes(id)),
    'standard',
    rng,
  )
}

export function pickRandomMapScript(rng: () => number, exclude: readonly MapScriptId[] = []): Exclude<MapScriptId, 'random'> {
  return pickRandomId<Exclude<MapScriptId, 'random'>>(
    MAP_SCRIPTS.map(option => option.id).filter((id): id is Exclude<MapScriptId, 'random'> => id !== 'random' && !exclude.includes(id)),
    'pangaea-ultima',
    rng,
  )
}

export function normalizeMapVoteSelection(selection: MapVoteSelection | LegacyMapVoteSelection | null | undefined): MapVoteSelection {
  return {
    mapTypes: normalizeRankedIds(extractMapTypes(selection), isMapTypeId, MAX_MAP_VOTE_MAP_TYPE_PICKS),
    mapScripts: normalizeRankedIds(extractMapScripts(selection), isMapScriptId, MAX_MAP_VOTE_MAP_SCRIPT_PICKS),
  }
}

export function isMapVoteSelectionConfirmable(selection: MapVoteSelection | LegacyMapVoteSelection | null | undefined): boolean {
  if (selection == null) return false
  const normalizedSelection = normalizeMapVoteSelection(selection)
  return normalizedSelection.mapTypes.length > 0 || normalizedSelection.mapScripts.length > 0
}

export function resolveMapVoteWinner(votes: readonly MapVoteSelection[], rng: () => number, seed = ''): ResolvedMapVoteResult {
  const normalizedVotes = votes.map(vote => normalizeMapVoteSelection(vote))
  const mapTypeResult = resolveRankedChoiceElection(
    normalizedVotes.map(vote => vote.mapTypes),
    MAP_TYPES.map(option => option.id),
    'standard',
    rng,
  )
  const mapScriptResult = resolveRankedChoiceElection(
    normalizedVotes.map(vote => vote.mapScripts),
    MAP_SCRIPTS.map(option => option.id),
    'pangaea-ultima',
    rng,
  )

  const resolvedRandomMapType = mapTypeResult.winnerId === 'random' ? pickRandomMapType(rng) : null
  const resolvedRandomMapScript = mapScriptResult.winnerId === 'random' ? pickRandomMapScript(rng) : null
  const resolvedMapType = resolvedRandomMapType ?? (mapTypeResult.winnerId as Exclude<MapTypeId, 'random'>)
  const resolvedMapScript = resolvedRandomMapScript ?? (mapScriptResult.winnerId as Exclude<MapScriptId, 'random'>)

  return {
    mapType: resolvedMapType,
    mapScript: resolvedMapScript,
    winningSeatCount: mapScriptResult.finalVotes,
    seed,
    mapTypeWinner: mapTypeResult.winnerId,
    mapScriptWinner: mapScriptResult.winnerId,
    mapTypeRounds: mapTypeResult.rounds,
    mapScriptRounds: mapScriptResult.rounds,
    resolvedRandomMapType,
    resolvedRandomMapScript,
  }
}

function extractMapTypes(selection: MapVoteSelection | LegacyMapVoteSelection | null | undefined): readonly unknown[] {
  if (Array.isArray(selection?.mapTypes)) return selection.mapTypes
  const legacySelection = selection as LegacyMapVoteSelection | null | undefined
  const legacyMapType = typeof legacySelection?.mapType === 'string' ? legacySelection.mapType : null
  return legacyMapType != null ? [legacyMapType] : []
}

function extractMapScripts(selection: MapVoteSelection | LegacyMapVoteSelection | null | undefined): readonly unknown[] {
  return Array.isArray(selection?.mapScripts) ? selection.mapScripts : []
}

function normalizeRankedIds<T extends string>(values: readonly unknown[], isValid: (value: string | null | undefined) => value is T, limit: number): T[] {
  const normalized: T[] = []
  for (const value of values) {
    if (typeof value !== 'string' || !isValid(value) || normalized.includes(value)) continue
    normalized.push(value)
    if (normalized.length >= limit) break
  }
  return normalized
}

function resolveRankedChoiceElection<T extends string>(
  ballots: readonly (readonly T[])[],
  candidateIds: readonly T[],
  fallback: T,
  rng: () => number,
): RankedChoiceResolution<T> {
  const normalizedBallots = ballots
    .map(ballot => normalizeRankedCandidateBallot(ballot, candidateIds))
    .filter(ballot => ballot.length > 0)

  if (normalizedBallots.length === 0) return { winnerId: fallback, rounds: [], finalVotes: 0 }

  const candidateOrder = new Map(candidateIds.map((id, index) => [id, index]))
  const originalFirstChoiceVotes = new Map(candidateIds.map(id => [id, 0]))
  const totalMentions = new Map(candidateIds.map(id => [id, 0]))

  for (const ballot of normalizedBallots) {
    const firstChoice = ballot[0]
    if (firstChoice != null) originalFirstChoiceVotes.set(firstChoice, (originalFirstChoiceVotes.get(firstChoice) ?? 0) + 1)
    for (const candidateId of ballot) totalMentions.set(candidateId, (totalMentions.get(candidateId) ?? 0) + 1)
  }

  const remainingCandidateIds = candidateIds.filter(candidateId => (totalMentions.get(candidateId) ?? 0) > 0)
  if (remainingCandidateIds.length === 0) return { winnerId: fallback, rounds: [], finalVotes: 0 }

  const rounds: RankedChoiceRound<T>[] = []

  while (remainingCandidateIds.length > 0) {
    const tallies = tallyRankedChoiceRound(normalizedBallots, remainingCandidateIds)
    const roundTallies = remainingCandidateIds
      .map(id => ({ id, votes: tallies.get(id) ?? 0 }))
      .sort((left, right) => {
        if (right.votes !== left.votes) return right.votes - left.votes
        return (candidateOrder.get(left.id) ?? 0) - (candidateOrder.get(right.id) ?? 0)
      })
    const activeBallotCount = roundTallies.reduce((count, tally) => count + tally.votes, 0)
    const majorityThreshold = Math.floor(activeBallotCount / 2) + 1
    const outrightWinner = roundTallies.find(tally => tally.votes >= majorityThreshold)

    if (outrightWinner != null) {
      rounds.push({
        round: rounds.length + 1,
        tallies: roundTallies,
        activeBallotCount,
        majorityThreshold,
        eliminatedId: null,
        winnerId: outrightWinner.id,
        tieBreak: null,
      })
      return { winnerId: outrightWinner.id, rounds, finalVotes: outrightWinner.votes }
    }

    if (remainingCandidateIds.length === 1) {
      const winnerId = remainingCandidateIds[0] ?? fallback
      rounds.push({
        round: rounds.length + 1,
        tallies: roundTallies,
        activeBallotCount,
        majorityThreshold,
        eliminatedId: null,
        winnerId,
        tieBreak: null,
      })
      return { winnerId, rounds, finalVotes: tallies.get(winnerId) ?? 0 }
    }

    if (remainingCandidateIds.length === 2 && roundTallies[0]?.votes === roundTallies[1]?.votes) {
      const leftTally = roundTallies[0]!
      const rightTally = roundTallies[1]!
      const tie = breakRankedChoiceTie(
        [leftTally.id, rightTally.id],
        'winner',
        originalFirstChoiceVotes,
        totalMentions,
        rng,
      )
      const winnerVotes = tallies.get(tie.chosenId) ?? 0
      rounds.push({
        round: rounds.length + 1,
        tallies: roundTallies,
        activeBallotCount,
        majorityThreshold,
        eliminatedId: null,
        winnerId: tie.chosenId,
        tieBreak: tie.tieBreak,
      })
      return { winnerId: tie.chosenId, rounds, finalVotes: winnerVotes }
    }

    const lowestVotes = roundTallies[roundTallies.length - 1]?.votes ?? 0
    const lowestIds = roundTallies.filter(tally => tally.votes === lowestVotes).map(tally => tally.id)
    const tie = lowestIds.length === 1
      ? { chosenId: lowestIds[0] ?? fallback, tieBreak: null }
      : breakRankedChoiceTie(lowestIds, 'eliminate', originalFirstChoiceVotes, totalMentions, rng)

    rounds.push({
      round: rounds.length + 1,
      tallies: roundTallies,
      activeBallotCount,
      majorityThreshold,
      eliminatedId: tie.chosenId,
      winnerId: null,
      tieBreak: tie.tieBreak,
    })

    const eliminatedIndex = remainingCandidateIds.indexOf(tie.chosenId)
    if (eliminatedIndex < 0) break
    remainingCandidateIds.splice(eliminatedIndex, 1)
  }

  return { winnerId: fallback, rounds, finalVotes: 0 }
}

function normalizeRankedCandidateBallot<T extends string>(ballot: readonly T[], candidateIds: readonly T[]): T[] {
  const allowed = new Set(candidateIds)
  return ballot.filter((candidateId, index) => allowed.has(candidateId) && ballot.indexOf(candidateId) === index)
}

function tallyRankedChoiceRound<T extends string>(ballots: readonly (readonly T[])[], remainingCandidateIds: readonly T[]): Map<T, number> {
  const remaining = new Set(remainingCandidateIds)
  const tallies = new Map<T, number>()

  for (const ballot of ballots) {
    const currentChoice = ballot.find(candidateId => remaining.has(candidateId))
    if (currentChoice == null) continue
    tallies.set(currentChoice, (tallies.get(currentChoice) ?? 0) + 1)
  }

  return tallies
}

function breakRankedChoiceTie<T extends string>(
  candidateIds: readonly T[],
  mode: 'eliminate' | 'winner',
  originalFirstChoiceVotes: ReadonlyMap<T, number>,
  totalMentions: ReadonlyMap<T, number>,
  rng: () => number,
): { chosenId: T, tieBreak: RankedChoiceTieBreak<T> } {
  const firstChoiceSorted = chooseRankedChoiceCandidates(candidateIds, candidateId => originalFirstChoiceVotes.get(candidateId) ?? 0, mode)
  if (firstChoiceSorted.length === 1) {
    return {
      chosenId: firstChoiceSorted[0]!,
      tieBreak: { rule: 'original-first-choice', candidates: [...candidateIds], chosenId: firstChoiceSorted[0]! },
    }
  }

  const totalMentionSorted = chooseRankedChoiceCandidates(firstChoiceSorted, candidateId => totalMentions.get(candidateId) ?? 0, mode)
  if (totalMentionSorted.length === 1) {
    return {
      chosenId: totalMentionSorted[0]!,
      tieBreak: { rule: 'total-mentions', candidates: [...candidateIds], chosenId: totalMentionSorted[0]! },
    }
  }

  const chosenId = pickRandomId(totalMentionSorted, totalMentionSorted[0]!, rng)
  return {
    chosenId,
    tieBreak: { rule: 'seeded-random', candidates: [...candidateIds], chosenId },
  }
}

function chooseRankedChoiceCandidates<T extends string>(
  candidateIds: readonly T[],
  metric: (candidateId: T) => number,
  mode: 'eliminate' | 'winner',
): T[] {
  if (candidateIds.length === 0) return []
  const targetMetric = candidateIds.reduce((current, candidateId) => {
    const nextMetric = metric(candidateId)
    if (current == null) return nextMetric
    return mode === 'eliminate' ? Math.min(current, nextMetric) : Math.max(current, nextMetric)
  }, null as number | null)
  return candidateIds.filter(candidateId => metric(candidateId) === targetMetric)
}

function mapTypeLabel(mapType: MapTypeId | null | undefined): string {
  switch (mapType) {
    case 'standard':
    case null:
    case undefined:
      return ''
    default:
      return MAP_TYPE_BY_ID[mapType]?.name ?? mapType
  }
}

function pickRandomId<T extends string>(pool: readonly T[], fallback: T, rng: () => number): T {
  if (pool.length === 0) return fallback
  const index = Math.max(0, Math.min(pool.length - 1, Math.floor(rng() * pool.length)))
  return pool[index] ?? fallback
}
