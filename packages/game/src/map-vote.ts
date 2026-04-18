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
  mapType: MapTypeId
  mapScript: MapScriptId
}

export interface RevealedMapVoteSeatBallot extends MapVoteSelection {
  seatIndex: number
  confirmed: boolean
}

export interface ResolvedMapVoteResult extends MapVoteSelection {
  winningSeatCount: number
}

export type MapVotePhase = 'idle' | 'voting' | 'reveal' | 'done'

export interface MapVoteSnapshot {
  enabled: boolean
  supported: boolean
  phase: MapVotePhase
  endsAt: number | null
  selection: MapVoteSelection | null
  hasConfirmed: boolean
  revealedVotes: RevealedMapVoteSeatBallot[] | null
  result: ResolvedMapVoteResult | null
}

export const MAP_VOTE_VOTING_DURATION_MS = 5 * 60_000
export const MAP_VOTE_REVEAL_DURATION_MS = 5_000
export const MAP_VOTE_VOTING_DURATION_SECONDS = MAP_VOTE_VOTING_DURATION_MS / 1000
export const MAP_VOTE_REVEAL_DURATION_SECONDS = MAP_VOTE_REVEAL_DURATION_MS / 1000

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
  mapType: 'random',
  mapScript: 'random',
}

export const EMPTY_MAP_VOTE_SNAPSHOT: MapVoteSnapshot = {
  enabled: false,
  supported: false,
  phase: 'idle',
  endsAt: null,
  selection: null,
  hasConfirmed: false,
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
  const typePrefix = mapTypePrefix(mapType)
  const scriptName = scriptOption?.name ?? ''
  if (!scriptName) return typePrefix
  const scriptLabel = scriptOption?.hint ? `${scriptName} (${scriptOption.hint})` : scriptName
  return typePrefix ? `${typePrefix} ${scriptLabel}` : scriptLabel
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

export function resolveMapVoteSelection(selection: MapVoteSelection, rng: () => number): Omit<MapVoteSelection, 'mapType' | 'mapScript'> & { mapType: Exclude<MapTypeId, 'random'>, mapScript: Exclude<MapScriptId, 'random'> } {
  return {
    mapType: selection.mapType === 'random' ? pickRandomMapType(rng) : selection.mapType,
    mapScript: selection.mapScript === 'random' ? pickRandomMapScript(rng) : selection.mapScript,
  }
}

export function resolveMapVoteWinner(votes: readonly MapVoteSelection[], rng: () => number): ResolvedMapVoteResult {
  if (votes.length === 0) {
    return {
      mapType: 'standard',
      mapScript: 'pangaea-ultima',
      winningSeatCount: 0,
    }
  }

  const resolvedVotes = votes.map(vote => resolveMapVoteSelection(vote, rng))
  const mapType = resolveMajority(resolvedVotes.map(vote => vote.mapType), 'standard', rng)
  const mapScript = resolveMajority(resolvedVotes.map(vote => vote.mapScript), 'pangaea-ultima', rng)
  const winningSeatCount = resolvedVotes.filter(vote => vote.mapType === mapType && vote.mapScript === mapScript).length
  return { mapType, mapScript, winningSeatCount }
}

function mapTypePrefix(mapType: MapTypeId | null | undefined): string {
  switch (mapType) {
    case 'east-vs-west':
      return 'EvW'
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

function resolveMajority<T extends string>(values: readonly T[], fallback: T, rng: () => number): T {
  if (values.length === 0) return fallback

  const tallies = new Map<T, number>()
  for (const value of values) {
    tallies.set(value, (tallies.get(value) ?? 0) + 1)
  }

  let highest = 0
  const leaders: T[] = []
  for (const [value, count] of tallies) {
    if (count > highest) {
      highest = count
      leaders.length = 0
      leaders.push(value)
    }
    else if (count === highest) {
      leaders.push(value)
    }
  }

  return pickRandomId(leaders, fallback, rng)
}
