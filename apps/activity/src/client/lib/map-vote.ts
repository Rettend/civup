/**
 * Map voting constants and types.
 *
 * Frontend-only dummy data while the map vote phase is being designed.
 * No backend wiring yet: all state is local per-client.
 */

export type MapTypeId = 'standard' | 'east-vs-west' | 'random'
export type MapScriptId =
  | 'pangaea-ultima'
  | 'pangaea-ultima-no-wrap'
  | 'seven-seas'
  | 'rich-highlands'
  | 'lakes'
  | 'tilted-axis'
  | 'primordial'
  | 'inland-sea'
  | 'random'

export interface MapTypeOption {
  id: MapTypeId
  name: string
  description: string
}

export interface MapScriptOption {
  id: MapScriptId
  name: string
  /** Optional hint for the map feel — shown under the name, kept short. */
  hint?: string
  /** Optional image URL; empty while artworks are being produced. */
  imageUrl?: string
  /** Phosphor icon class used until the art is ready. */
  icon?: string
}

export const MAP_TYPES: readonly MapTypeOption[] = [
  {
    id: 'standard',
    name: 'Standard',
    description: 'Teams scattered across the map',
  },
  {
    id: 'east-vs-west',
    name: 'East vs West',
    description: 'Teams on opposite sides',
  },
  {
    id: 'random',
    name: 'Random',
    description: 'Picks one at random',
  },
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

export interface MapVote {
  mapType: MapTypeId
  mapScript: MapScriptId
}

export interface SeatMapVote extends MapVote {
  seatIndex: number
}

export function formatMapVoteResultLabel(mapType: MapTypeId | null | undefined, mapScript: MapScriptId | null | undefined): string {
  const scriptOption = mapScript ? MAP_SCRIPT_BY_ID[mapScript] : null
  const typePrefix = mapTypePrefix(mapType)
  const scriptName = scriptOption?.name ?? ''
  if (!scriptName) return typePrefix
  const scriptLabel = scriptOption?.hint ? `${scriptName} (${scriptOption.hint})` : scriptName
  return typePrefix ? `${typePrefix} ${scriptLabel}` : scriptLabel
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

/**
 * Pick one id from `options` at random, excluding the special `random` option.
 * Used to resolve a user's `random` choice into a concrete map.
 */
export function resolveRandomMapType(exclude: readonly MapTypeId[] = []): MapTypeId {
  const pool = MAP_TYPES
    .map(option => option.id)
    .filter(id => id !== 'random' && !exclude.includes(id))
  if (pool.length === 0) return 'standard'
  return pool[Math.floor(Math.random() * pool.length)]!
}

export function resolveRandomMapScript(exclude: readonly MapScriptId[] = []): MapScriptId {
  const pool = MAP_SCRIPTS
    .map(option => option.id)
    .filter(id => id !== 'random' && !exclude.includes(id))
  if (pool.length === 0) return 'pangaea-ultima'
  return pool[Math.floor(Math.random() * pool.length)]!
}

interface Tally<T extends string> {
  id: T
  count: number
}

/**
 * Count votes and return the winner. `random` votes are resolved into concrete
 * picks before counting. Ties are broken randomly, per the product design.
 */
export function pickWinningMapType(votes: readonly MapTypeId[]): MapTypeId {
  const resolved = votes.map(id => id === 'random' ? resolveRandomMapType() : id)
  return resolveMajority(resolved, 'standard')
}

export function pickWinningMapScript(votes: readonly MapScriptId[]): MapScriptId {
  const resolved = votes.map(id => id === 'random' ? resolveRandomMapScript() : id)
  return resolveMajority(resolved, 'pangaea-ultima')
}

function resolveMajority<T extends string>(values: readonly T[], fallback: T): T {
  if (values.length === 0) return fallback
  const tallies = new Map<T, number>()
  for (const value of values) tallies.set(value, (tallies.get(value) ?? 0) + 1)
  let highest = 0
  const leaders: Array<Tally<T>> = []
  for (const [id, count] of tallies) {
    if (count > highest) {
      highest = count
      leaders.length = 0
      leaders.push({ id, count })
    }
    else if (count === highest) {
      leaders.push({ id, count })
    }
  }
  if (leaders.length === 0) return fallback
  return leaders[Math.floor(Math.random() * leaders.length)]!.id
}
