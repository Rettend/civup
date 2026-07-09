import type { CivReplayMapTileSnapshot } from './map.ts'
import type { CivReplayCitySnapshot, CivReplayPlayerSnapshot } from './players.ts'
import type { CivReplayTurnSnapshot } from './snapshot.ts'

export interface CivReplayCityRef {
  player: CivReplayPlayerSnapshot
  city: CivReplayCitySnapshot
}

export interface CivReplayCityAttributionContext {
  cityRefs: readonly CivReplayCityRef[]
  tileByCoordinate: ReadonlyMap<string, CivReplayMapTileSnapshot>
}

export function createCivReplayCityAttributionContext(snapshot: CivReplayTurnSnapshot): CivReplayCityAttributionContext {
  return {
    cityRefs: snapshot.players.players.flatMap(player => player.cities.map(city => ({ player, city }))),
    tileByCoordinate: new Map(snapshot.map.tiles.map(tile => [coordinateKey(tile.x, tile.y), tile])),
  }
}

export function inferUnitCreatedCity(
  context: CivReplayCityAttributionContext,
  player: CivReplayPlayerSnapshot,
  x: number,
  y: number,
): CivReplayCityRef | null {
  const cityCenterMatches = player.cities.filter(city => city.x === x && city.y === y)
  if (cityCenterMatches.length === 1) return { player, city: cityCenterMatches[0]! }

  const tile = context.tileByCoordinate.get(coordinateKey(x, y))
  if (!tile) return null

  const owningCity = inferTileOwningCity(context, tile)
  return owningCity?.player.id === player.id ? owningCity : null
}

export function inferTileOwningCity(
  context: CivReplayCityAttributionContext,
  tile: CivReplayMapTileSnapshot,
): CivReplayCityRef | null {
  if (tile.cityId == null) return null
  return uniqueNearestCityRef(
    tile.x,
    tile.y,
    context.cityRefs.filter(ref => ref.city.id === tile.cityId),
  )
}

function uniqueNearestCityRef(x: number, y: number, cityRefs: readonly CivReplayCityRef[]): CivReplayCityRef | null {
  let nearest: CivReplayCityRef | null = null
  let nearestDistance = Number.POSITIVE_INFINITY
  let tied = false
  for (const ref of cityRefs) {
    const distance = hexDistance(x, y, ref.city.x, ref.city.y)
    if (distance < nearestDistance) {
      nearest = ref
      nearestDistance = distance
      tied = false
      continue
    }
    if (distance === nearestDistance) tied = true
  }
  return tied ? null : nearest
}

function hexDistance(leftX: number, leftY: number, rightX: number, rightY: number): number {
  const left = offsetToCube(leftX, leftY)
  const right = offsetToCube(rightX, rightY)
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y), Math.abs(left.z - right.z))
}

function offsetToCube(x: number, y: number): { x: number, y: number, z: number } {
  const cubeX = x - ((y - (y & 1)) / 2)
  const cubeZ = y
  return { x: cubeX, y: -cubeX - cubeZ, z: cubeZ }
}

function coordinateKey(x: number, y: number): string {
  return `${x}:${y}`
}
