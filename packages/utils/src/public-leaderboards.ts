export const PUBLIC_LEADERBOARD_VERSION = 1 as const

export const PUBLIC_PLAYER_LEADERBOARD_MODES = ['duel', 'duo', 'squad', 'ffa', 'red-death'] as const
export const PUBLIC_CIV_LEADERBOARD_SCOPES = ['all', 'duel', 'duo', 'squad'] as const
export const PUBLIC_CIV_LEADERBOARD_METRICS = ['picked', 'winrate', 'banned'] as const

export type PublicPlayerLeaderboardMode = typeof PUBLIC_PLAYER_LEADERBOARD_MODES[number]
export type PublicCivLeaderboardScope = typeof PUBLIC_CIV_LEADERBOARD_SCOPES[number]
export type PublicCivLeaderboardMetric = typeof PUBLIC_CIV_LEADERBOARD_METRICS[number]
export type PublicLeaderboardSeasonPolicy = 'ppl-seasons' | 'all-time'

export interface PublicLeaderboardServer {
  id: string
  displayName?: string
}

export interface PublicPlayerPlacementAdjustment {
  rawRank: number
  places: number
}

export interface PublicPlayerLeaderboardRow {
  rank: number
  displayName: string
  rating: number
  games: number
  wins: number
  winRatePct: number
  placementAdjustment?: PublicPlayerPlacementAdjustment
}

export interface PublicPlayerLeaderboardBoard {
  available: boolean
  rows: PublicPlayerLeaderboardRow[]
}

export interface PublicCivLeaderboardRow {
  civId: string
  name: string
  picks: number
  bans: number
  wins: number
  games: number
  pickRatePct: number | null
  winRatePct: number | null
  banRatePct: number | null
}

export interface PublicCivLeaderboardBoard {
  available: boolean
  historyInitialized: boolean
  label: string | null
  completedGames: number
  rows: PublicCivLeaderboardRow[]
}

export interface PublicLeaderboardResponse {
  version: typeof PUBLIC_LEADERBOARD_VERSION
  generatedAt: number
  server: PublicLeaderboardServer
  servers: PublicLeaderboardServer[]
  seasonPolicy: PublicLeaderboardSeasonPolicy
  sourceSnapshots: {
    players: Record<PublicPlayerLeaderboardMode, number | null>
    civilizations: Record<PublicCivLeaderboardScope, number | null>
  }
  players: Record<PublicPlayerLeaderboardMode, PublicPlayerLeaderboardBoard>
  civilizations: Record<PublicCivLeaderboardScope, PublicCivLeaderboardBoard>
}

/** Canonical ordering shared by Discord and browser civilization leaderboards. */
export function sortPublicCivLeaderboardRows<T extends Pick<PublicCivLeaderboardRow, 'civId' | 'picks' | 'wins' | 'bans' | 'winRatePct'>>(
  metric: PublicCivLeaderboardMetric,
  rows: readonly T[],
): T[] {
  if (metric === 'picked') {
    return [...rows]
      .filter(row => row.picks > 0)
      .sort((left, right) => right.picks - left.picks || right.wins - left.wins || left.civId.localeCompare(right.civId))
  }

  if (metric === 'winrate') {
    return [...rows]
      .filter(row => row.picks > 0 && row.winRatePct != null)
      .sort((left, right) => (right.winRatePct ?? 0) - (left.winRatePct ?? 0) || right.picks - left.picks || left.civId.localeCompare(right.civId))
  }

  return [...rows]
    .filter(row => row.bans > 0)
    .sort((left, right) => right.bans - left.bans || right.picks - left.picks || left.civId.localeCompare(right.civId))
}

export function isPublicLeaderboardResponse(value: unknown): value is PublicLeaderboardResponse {
  if (!isRecord(value) || !hasExactKeys(value, ['version', 'generatedAt', 'server', 'servers', 'seasonPolicy', 'sourceSnapshots', 'players', 'civilizations'])) return false
  if (
    value.version !== PUBLIC_LEADERBOARD_VERSION
    || !isTimestamp(value.generatedAt)
    || !isPublicLeaderboardServer(value.server)
    || !Array.isArray(value.servers)
    || value.servers.length === 0
    || !value.servers.every(isPublicLeaderboardServer)
    || (value.seasonPolicy !== 'ppl-seasons' && value.seasonPolicy !== 'all-time')
    || !isSourceSnapshots(value.sourceSnapshots)
    || !isExactRecord(value.players, PUBLIC_PLAYER_LEADERBOARD_MODES, isPublicPlayerLeaderboardBoard)
    || !isExactRecord(value.civilizations, PUBLIC_CIV_LEADERBOARD_SCOPES, isPublicCivLeaderboardBoard)
  ) return false

  const serverIds = value.servers.map(server => server.id)
  return serverIds.includes(value.server.id) && new Set(serverIds).size === serverIds.length
}

function isPublicLeaderboardServer(value: unknown): value is PublicLeaderboardServer {
  if (!isRecord(value)) return false
  const keys = value.displayName === undefined ? ['id'] : ['id', 'displayName']
  return hasExactKeys(value, keys)
    && typeof value.id === 'string'
    && /^\d{17,20}$/.test(value.id)
    && (value.displayName === undefined || (typeof value.displayName === 'string' && value.displayName.length > 0))
}

function isSourceSnapshots(value: unknown): value is PublicLeaderboardResponse['sourceSnapshots'] {
  return isRecord(value)
    && hasExactKeys(value, ['players', 'civilizations'])
    && isExactRecord(value.players, PUBLIC_PLAYER_LEADERBOARD_MODES, isNullableTimestamp)
    && isExactRecord(value.civilizations, PUBLIC_CIV_LEADERBOARD_SCOPES, isNullableTimestamp)
}

function isPublicPlayerLeaderboardBoard(value: unknown): value is PublicPlayerLeaderboardBoard {
  return isRecord(value)
    && hasExactKeys(value, ['available', 'rows'])
    && typeof value.available === 'boolean'
    && Array.isArray(value.rows)
    && value.rows.every(isPublicPlayerLeaderboardRow)
}

function isPublicPlayerLeaderboardRow(value: unknown): value is PublicPlayerLeaderboardRow {
  if (!isRecord(value)) return false
  const keys = value.placementAdjustment === undefined
    ? ['rank', 'displayName', 'rating', 'games', 'wins', 'winRatePct']
    : ['rank', 'displayName', 'rating', 'games', 'wins', 'winRatePct', 'placementAdjustment']
  return hasExactKeys(value, keys)
    && isPositiveInteger(value.rank)
    && typeof value.displayName === 'string'
    && value.displayName.length > 0
    && isFiniteNumber(value.rating)
    && isNonNegativeInteger(value.games)
    && isNonNegativeInteger(value.wins)
    && isFiniteNumber(value.winRatePct)
    && (value.placementAdjustment === undefined || isPublicPlayerPlacementAdjustment(value.placementAdjustment))
}

function isPublicPlayerPlacementAdjustment(value: unknown): value is PublicPlayerPlacementAdjustment {
  return isRecord(value)
    && hasExactKeys(value, ['rawRank', 'places'])
    && isPositiveInteger(value.rawRank)
    && isPositiveInteger(value.places)
}

function isPublicCivLeaderboardBoard(value: unknown): value is PublicCivLeaderboardBoard {
  return isRecord(value)
    && hasExactKeys(value, ['available', 'historyInitialized', 'label', 'completedGames', 'rows'])
    && typeof value.available === 'boolean'
    && typeof value.historyInitialized === 'boolean'
    && (value.label === null || typeof value.label === 'string')
    && isNonNegativeInteger(value.completedGames)
    && Array.isArray(value.rows)
    && value.rows.every(isPublicCivLeaderboardRow)
}

function isPublicCivLeaderboardRow(value: unknown): value is PublicCivLeaderboardRow {
  return isRecord(value)
    && hasExactKeys(value, ['civId', 'name', 'picks', 'bans', 'wins', 'games', 'pickRatePct', 'winRatePct', 'banRatePct'])
    && typeof value.civId === 'string'
    && value.civId.length > 0
    && typeof value.name === 'string'
    && value.name.length > 0
    && isNonNegativeInteger(value.picks)
    && isNonNegativeInteger(value.bans)
    && isNonNegativeInteger(value.wins)
    && isNonNegativeInteger(value.games)
    && isNullableFiniteNumber(value.pickRatePct)
    && isNullableFiniteNumber(value.winRatePct)
    && isNullableFiniteNumber(value.banRatePct)
}

function isExactRecord<K extends string, T>(
  value: unknown,
  keys: readonly K[],
  validate: (entry: unknown) => entry is T,
): value is Record<K, T> {
  return isRecord(value)
    && hasExactKeys(value, keys)
    && keys.every(key => validate(value[key]))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && keys.every(key => expected.includes(key))
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0
}

function isTimestamp(value: unknown): value is number {
  return isNonNegativeInteger(value)
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || isTimestamp(value)
}
