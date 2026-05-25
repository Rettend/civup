import type { GameMode } from './types.ts'
import { isTeamMode } from './mode.ts'
import { createSeededRandom } from './random.ts'

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
  'continents',
  'random',
] as const
export type MapScriptId = (typeof MAP_SCRIPT_IDS)[number]

export const MAP_VOTE_MAP_IDS = [
  'random',
  'pangaea-ultima',
  'pangaea-ultima-no-wrap',
  'pangaea-ultima-east-vs-west',
  'pangaea-ultima-no-wrap-east-vs-west',
  'seven-seas',
  'rich-highlands',
  'lakes',
  'tilted-axis',
  'primordial',
  'inland-sea',
  'inland-sea-east-vs-west',
  'continents',
  'continents-east-vs-west',
] as const
export type MapVoteMapId = (typeof MAP_VOTE_MAP_IDS)[number]

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

export interface MapVoteMapOption {
  id: MapVoteMapId
  name: string
  mapType: MapTypeId
  mapScript: MapScriptId
  badgeLeft?: string
  badgeRight?: string
  imageUrl?: string
  icon?: string
}

export interface MapVoteSelection {
  maps: MapVoteMapId[]
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
  maps?: unknown
}

interface RankedChoiceResolution<T extends string> {
  winnerId: T
  rounds: RankedChoiceRound<T>[]
  finalVotes: number
}

export const MAP_VOTE_VOTING_DURATION_MS = 90_000
export const MAP_VOTE_REVEAL_DURATION_MS = 10_000
export const MAP_VOTE_VOTING_DURATION_SECONDS = MAP_VOTE_VOTING_DURATION_MS / 1000
export const MAP_VOTE_REVEAL_DURATION_SECONDS = MAP_VOTE_REVEAL_DURATION_MS / 1000
export const MAX_MAP_VOTE_MAP_PICKS = 3
export const MAX_MAP_VOTE_MAP_TYPE_PICKS = MAP_TYPE_IDS.length
export const MAX_MAP_VOTE_MAP_SCRIPT_PICKS = MAX_MAP_VOTE_MAP_PICKS

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
  { id: 'continents', name: 'Continents', imageUrl: '/assets/maps/Map_Continents.webp' },
  { id: 'random', name: 'Random', icon: 'i-ph-dice-five-bold' },
]

export const MAP_VOTE_MAPS: readonly MapVoteMapOption[] = [
  { id: 'random', name: 'Random', mapType: 'random', mapScript: 'random', icon: 'i-ph-dice-five-bold' },
  { id: 'pangaea-ultima', name: 'Pangaea Ultima', mapType: 'standard', mapScript: 'pangaea-ultima', badgeLeft: 'Wrap', imageUrl: '/assets/maps/Map_Pangaea.webp' },
  { id: 'pangaea-ultima-no-wrap', name: 'Pangaea Ultima', mapType: 'standard', mapScript: 'pangaea-ultima-no-wrap', badgeLeft: 'No Wrap', imageUrl: '/assets/maps/Map_Pangaea.webp' },
  { id: 'pangaea-ultima-east-vs-west', name: 'Pangaea Ultima', mapType: 'east-vs-west', mapScript: 'pangaea-ultima', badgeLeft: 'Wrap', badgeRight: 'EvW', imageUrl: '/assets/maps/Map_Pangaea.webp' },
  { id: 'pangaea-ultima-no-wrap-east-vs-west', name: 'Pangaea Ultima', mapType: 'east-vs-west', mapScript: 'pangaea-ultima-no-wrap', badgeLeft: 'No Wrap', badgeRight: 'EvW', imageUrl: '/assets/maps/Map_Pangaea.webp' },
  { id: 'seven-seas', name: 'Seven Seas', mapType: 'standard', mapScript: 'seven-seas', imageUrl: '/assets/maps/Map_Seven_Seas.webp' },
  { id: 'rich-highlands', name: 'Rich Highlands', mapType: 'standard', mapScript: 'rich-highlands', imageUrl: '/assets/maps/Map_4_Leaf.webp' },
  { id: 'lakes', name: 'Lakes', mapType: 'standard', mapScript: 'lakes', imageUrl: '/assets/maps/Map_Lakes.webp' },
  { id: 'tilted-axis', name: 'Tilted Axis', mapType: 'standard', mapScript: 'tilted-axis', imageUrl: '/assets/maps/Map_Tilted_Axis.webp' },
  { id: 'primordial', name: 'Primordial', mapType: 'standard', mapScript: 'primordial', imageUrl: '/assets/maps/Map_Primodial.webp' },
  { id: 'inland-sea', name: 'Inland Sea', mapType: 'standard', mapScript: 'inland-sea', imageUrl: '/assets/maps/Map_Inland_Sea.webp' },
  { id: 'inland-sea-east-vs-west', name: 'Inland Sea', mapType: 'east-vs-west', mapScript: 'inland-sea', badgeRight: 'EvW', imageUrl: '/assets/maps/Map_Inland_Sea.webp' },
  { id: 'continents', name: 'Continents', mapType: 'standard', mapScript: 'continents', imageUrl: '/assets/maps/Map_Continents.webp' },
  { id: 'continents-east-vs-west', name: 'Continents', mapType: 'east-vs-west', mapScript: 'continents', badgeRight: 'EvW', imageUrl: '/assets/maps/Map_Continents.webp' },
]

export const MAP_TYPE_BY_ID: Record<MapTypeId, MapTypeOption> = Object.fromEntries(
  MAP_TYPES.map(option => [option.id, option]),
) as Record<MapTypeId, MapTypeOption>

export const MAP_SCRIPT_BY_ID: Record<MapScriptId, MapScriptOption> = Object.fromEntries(
  MAP_SCRIPTS.map(option => [option.id, option]),
) as Record<MapScriptId, MapScriptOption>

export const MAP_VOTE_MAP_BY_ID: Record<MapVoteMapId, MapVoteMapOption> = Object.fromEntries(
  MAP_VOTE_MAPS.map(option => [option.id, option]),
) as Record<MapVoteMapId, MapVoteMapOption>

const MAP_VOTE_MAP_ID_BY_RESULT = Object.fromEntries(
  MAP_VOTE_MAPS.map(option => [`${option.mapType}:${option.mapScript}`, option.id]),
) as Record<string, MapVoteMapId>

export const DEFAULT_MAP_VOTE_SELECTION: MapVoteSelection = {
  maps: [],
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

export function isMapVoteMapId(value: string | null | undefined): value is MapVoteMapId {
  return value != null && MAP_VOTE_MAP_IDS.includes(value as MapVoteMapId)
}

export function isMapVoteSupportedForMode(mode: GameMode, options: { redDeath?: boolean } = {}): boolean {
  if (options.redDeath) return false
  return mode === 'ffa' || mode === '1v1' || isTeamMode(mode)
}

export function normalizeMapVoteEnabled(mode: GameMode, enabled: boolean, options: { redDeath?: boolean } = {}): boolean {
  return isMapVoteSupportedForMode(mode, options) && enabled === true
}

export function formatMapVoteResultLabel(mapType: MapTypeId | null | undefined, mapScript: MapScriptId | null | undefined): string {
  const scriptLabel = formatMapScriptLabel(mapScript)
  if (!scriptLabel) {
    if (mapType === 'standard') return 'Stnd'
    if (mapType === 'east-vs-west') return 'EvW'
    return mapTypeLabel(mapType)
  }
  if (mapType === 'east-vs-west') return `${scriptLabel} EvW`
  if (mapType === 'standard') return `${scriptLabel} Stnd`
  const typeLabel = mapTypeLabel(mapType)
  return typeLabel ? `${typeLabel} ${scriptLabel}` : scriptLabel
}

export function formatMapVoteResultTitle(mapType: MapTypeId | null | undefined, mapScript: MapScriptId | null | undefined): string {
  const scriptLabel = formatMapScriptLabel(mapScript)
  const typeLabel = mapTypeLabel(mapType)
  if (!scriptLabel) return typeLabel
  if (!typeLabel) return scriptLabel
  return `${scriptLabel} ${typeLabel}`
}

export function createMapVoteRng(seed: string): () => number {
  return createSeededRandom(seed)
}

export function getMapVoteMapIdForResult(mapType: MapTypeId | null | undefined, mapScript: MapScriptId | null | undefined): MapVoteMapId | null {
  if (mapType === 'random' || mapScript === 'random') return 'random'
  if (!mapType || !mapScript) return null
  return MAP_VOTE_MAP_ID_BY_RESULT[`${mapType}:${mapScript}`] ?? null
}

export function getMapVoteMapOptionForResult(mapType: MapTypeId | null | undefined, mapScript: MapScriptId | null | undefined): MapVoteMapOption | null {
  const id = getMapVoteMapIdForResult(mapType, mapScript)
  return id ? MAP_VOTE_MAP_BY_ID[id] ?? null : null
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
  const maps = normalizeRankedIds(extractMaps(selection), isMapVoteMapId, MAX_MAP_VOTE_MAP_PICKS)
  if (maps.length > 0) return { maps }
  return { maps: normalizeLegacyMapVoteMapIds(selection) }
}

export function isMapVoteSelectionConfirmable(selection: MapVoteSelection | LegacyMapVoteSelection | null | undefined): boolean {
  if (selection == null) return false
  const normalizedSelection = normalizeMapVoteSelection(selection)
  return normalizedSelection.maps.length > 0
}

export function resolveMapVoteWinner(votes: readonly (MapVoteSelection | LegacyMapVoteSelection)[], rng: () => number, seed = ''): ResolvedMapVoteResult {
  const normalizedVotes = votes.map(vote => normalizeMapVoteSelection(vote))
  const mapResult = resolveRankedChoiceElection(
    normalizedVotes.map(vote => vote.maps),
    MAP_VOTE_MAPS.map(option => option.id),
    'pangaea-ultima',
    rng,
  )

  const resolvedRandomMapId = mapResult.winnerId === 'random' ? pickRandomMapVoteMap(rng) : null
  const resolvedMapId = resolvedRandomMapId ?? (mapResult.winnerId === 'random' ? 'pangaea-ultima' : mapResult.winnerId)
  const resolvedOption = MAP_VOTE_MAP_BY_ID[resolvedMapId]
  const winnerOption = MAP_VOTE_MAP_BY_ID[mapResult.winnerId]

  return {
    mapType: resolvedOption.mapType as Exclude<MapTypeId, 'random'>,
    mapScript: resolvedOption.mapScript as Exclude<MapScriptId, 'random'>,
    winningSeatCount: mapResult.finalVotes,
    seed,
    mapTypeWinner: winnerOption.mapType,
    mapScriptWinner: winnerOption.mapScript,
    mapTypeRounds: [],
    mapScriptRounds: [],
    resolvedRandomMapType: resolvedRandomMapId ? resolvedOption.mapType as Exclude<MapTypeId, 'random'> : null,
    resolvedRandomMapScript: resolvedRandomMapId ? resolvedOption.mapScript as Exclude<MapScriptId, 'random'> : null,
  }
}

function extractMaps(selection: MapVoteSelection | LegacyMapVoteSelection | null | undefined): readonly unknown[] {
  return Array.isArray(selection?.maps) ? selection.maps : []
}

function extractMapTypes(selection: MapVoteSelection | LegacyMapVoteSelection | null | undefined): readonly unknown[] {
  const legacySelection = selection as LegacyMapVoteSelection | null | undefined
  if (Array.isArray(legacySelection?.mapTypes)) return legacySelection.mapTypes
  const legacyMapType = typeof legacySelection?.mapType === 'string' ? legacySelection.mapType : null
  return legacyMapType != null ? [legacyMapType] : []
}

function extractMapScripts(selection: MapVoteSelection | LegacyMapVoteSelection | null | undefined): readonly unknown[] {
  const legacySelection = selection as LegacyMapVoteSelection | null | undefined
  return Array.isArray(legacySelection?.mapScripts) ? legacySelection.mapScripts : []
}

function normalizeLegacyMapVoteMapIds(selection: MapVoteSelection | LegacyMapVoteSelection | null | undefined): MapVoteMapId[] {
  const mapTypes = normalizeRankedIds(extractMapTypes(selection), isMapTypeId, MAX_MAP_VOTE_MAP_TYPE_PICKS)
  const mapScripts = normalizeRankedIds(extractMapScripts(selection), isMapScriptId, MAX_MAP_VOTE_MAP_PICKS)
  if (mapTypes.length === 0 && mapScripts.length === 0) return []
  const primaryType = mapTypes.find(mapType => mapType !== 'random') ?? 'standard'

  if (mapScripts.length === 0) {
    if (mapTypes[0] === 'random') return ['random']
    if (primaryType === 'east-vs-west') return ['pangaea-ultima-east-vs-west']
    if (primaryType === 'standard') return ['pangaea-ultima']
    return []
  }

  const maps: MapVoteMapId[] = []
  for (const mapScript of mapScripts) {
    const mapId = getLegacyMapVoteMapId(primaryType, mapScript)
    if (mapId != null && !maps.includes(mapId)) maps.push(mapId)
    if (maps.length >= MAX_MAP_VOTE_MAP_PICKS) break
  }
  return maps
}

function getLegacyMapVoteMapId(mapType: Exclude<MapTypeId, 'random'>, mapScript: MapScriptId): MapVoteMapId | null {
  if (mapScript === 'random') return 'random'
  return getMapVoteMapIdForResult(mapType, mapScript)
    ?? getMapVoteMapIdForResult('standard', mapScript)
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

function formatMapScriptLabel(mapScript: MapScriptId | null | undefined): string {
  const scriptOption = mapScript ? MAP_SCRIPT_BY_ID[mapScript] : null
  const scriptName = scriptOption?.name ?? ''
  if (!scriptName) return ''
  return scriptOption?.hint ? `${scriptName} (${scriptOption.hint})` : scriptName
}

function mapTypeLabel(mapType: MapTypeId | null | undefined): string {
  if (!mapType) return ''
  return MAP_TYPE_BY_ID[mapType]?.name ?? mapType
}

function pickRandomMapVoteMap(rng: () => number, exclude: readonly MapVoteMapId[] = []): Exclude<MapVoteMapId, 'random'> {
  return pickRandomId<Exclude<MapVoteMapId, 'random'>>(
    MAP_VOTE_MAPS.map(option => option.id).filter((id): id is Exclude<MapVoteMapId, 'random'> => id !== 'random' && !exclude.includes(id)),
    'pangaea-ultima',
    rng,
  )
}

function pickRandomId<T extends string>(pool: readonly T[], fallback: T, rng: () => number): T {
  if (pool.length === 0) return fallback
  const index = Math.max(0, Math.min(pool.length - 1, Math.floor(rng() * pool.length)))
  return pool[index] ?? fallback
}
