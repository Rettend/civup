import type { Database } from '@civup/db'
import type { LeaderboardMode } from '@civup/game'
import type {
  PublicCivLeaderboardBoard,
  PublicCivLeaderboardScope,
  PublicLeaderboardResponse,
  PublicLeaderboardServer,
  PublicPlayerLeaderboardBoard,
  PublicPlayerLeaderboardMode,
} from '@civup/utils'
import type { StatsContext } from '../stats/context.ts'
import {
  PUBLIC_CIV_LEADERBOARD_SCOPES,
  PUBLIC_LEADERBOARD_VERSION,
  PUBLIC_PLAYER_LEADERBOARD_MODES,
} from '@civup/utils'
import { getStoredCivLeaderboardSnapshots } from './civ-snapshot.ts'
import { buildPlayerLeaderboardProjections } from './player-projection.ts'
import { getStoredLeaderboardModeSnapshots } from './snapshot.ts'

export const PUBLIC_LEADERBOARD_PLAYER_LIMIT = 100
export const PUBLIC_LEADERBOARD_PAYLOAD_MAX_BYTES = 512 * 1024
export const PUBLIC_UNKNOWN_PLAYER_NAME = 'Unknown player'

const DISCORD_SNOWFLAKE_PATTERN = /^\d{17,20}$/
const FORBIDDEN_PUBLIC_KEYS = new Set(['playerId', 'mu', 'sigma', 'lastPlayedAt', 'avatarUrl'])

export class PublicLeaderboardPayloadTooLargeError extends Error {
  constructor(public readonly sizeBytes: number) {
    super(`Public leaderboard payload exceeds ${PUBLIC_LEADERBOARD_PAYLOAD_MAX_BYTES} bytes`)
    this.name = 'PublicLeaderboardPayloadTooLargeError'
  }
}

export function buildPublicLeaderboardServerCatalog(
  primaryGuildId: string,
  guildIds: readonly string[],
  knownServers: readonly { id: string, name?: string | null }[] = [],
): PublicLeaderboardServer[] {
  const namesById = new Map(knownServers.map(server => [server.id, server.name?.trim() || null]))
  return guildIds.map((id, index) => ({
    id,
    displayName: id === primaryGuildId
      ? 'PPL'
      : namesById.get(id) ?? `Community server ${index + 1}`,
  }))
}

export async function buildPublicLeaderboardResponse(
  db: Database,
  kv: KVNamespace,
  statsContext: StatsContext,
  servers: readonly PublicLeaderboardServer[],
  now = Date.now(),
): Promise<PublicLeaderboardResponse> {
  const [playerSnapshots, civSnapshots] = await Promise.all([
    getStoredLeaderboardModeSnapshots(kv, statsContext, PUBLIC_PLAYER_LEADERBOARD_MODES as readonly LeaderboardMode[]),
    getStoredCivLeaderboardSnapshots(kv, statsContext, PUBLIC_CIV_LEADERBOARD_SCOPES),
  ])

  const projections = await buildPlayerLeaderboardProjections(db, PUBLIC_PLAYER_LEADERBOARD_MODES.map(mode => ({
    mode,
    rows: playerSnapshots.get(mode)?.rows ?? [],
    options: { rowLimit: PUBLIC_LEADERBOARD_PLAYER_LIMIT, now },
  })))
  const projectionByMode = new Map(projections.map(projection => [projection.mode, projection]))

  const players = {} as Record<PublicPlayerLeaderboardMode, PublicPlayerLeaderboardBoard>
  const playerSourceTimestamps = {} as Record<PublicPlayerLeaderboardMode, number | null>
  for (const mode of PUBLIC_PLAYER_LEADERBOARD_MODES) {
    const snapshot = playerSnapshots.get(mode)
    const projection = projectionByMode.get(mode)
    playerSourceTimestamps[mode] = snapshot?.updatedAt ?? null
    players[mode] = {
      available: snapshot != null,
      rows: (projection?.rows ?? []).map(row => ({
        rank: row.rank,
        displayName: publicPlayerDisplayName(row.displayName),
        rating: Math.round(row.publicRating),
        games: row.gamesPlayed,
        wins: row.wins,
        winRatePct: roundPercent(row.winRate * 100),
        ...(row.inactivityOffset > 0
          ? { placementAdjustment: { rawRank: row.rawRank, places: row.inactivityOffset } }
          : {}),
      })),
    }
  }

  const civilizations = {} as Record<PublicCivLeaderboardScope, PublicCivLeaderboardBoard>
  const civSourceTimestamps = {} as Record<PublicCivLeaderboardScope, number | null>
  for (const scope of PUBLIC_CIV_LEADERBOARD_SCOPES) {
    const snapshot = civSnapshots.get(scope)
    civSourceTimestamps[scope] = snapshot?.updatedAt ?? null
    civilizations[scope] = snapshot
      ? {
          available: true,
          historyInitialized: snapshot.historyInitialized,
          label: snapshot.label || null,
          completedGames: snapshot.completedMatchCount,
          rows: snapshot.rows.map(row => ({
            civId: row.civId,
            name: row.leaderName || row.civId,
            picks: row.picks,
            bans: row.bans,
            wins: row.wins,
            games: row.poolGames,
            pickRatePct: row.pickRatePct,
            winRatePct: row.winRatePct,
            banRatePct: row.banRatePct,
          })),
        }
      : {
          available: false,
          historyInitialized: false,
          label: null,
          completedGames: 0,
          rows: [],
        }
  }

  const selectedServer = servers.find(server => server.id === statsContext.guildId) ?? { id: statsContext.guildId }
  return {
    version: PUBLIC_LEADERBOARD_VERSION,
    generatedAt: now,
    server: selectedServer,
    servers: [...servers],
    seasonPolicy: statsContext.seasonPolicy,
    sourceSnapshots: {
      players: playerSourceTimestamps,
      civilizations: civSourceTimestamps,
    },
    players,
    civilizations,
  }
}

export function publicPlayerDisplayName(value: string | null | undefined): string {
  const normalized = value?.trim() ?? ''
  return !normalized || DISCORD_SNOWFLAKE_PATTERN.test(normalized) ? PUBLIC_UNKNOWN_PLAYER_NAME : normalized
}

export function serializePublicLeaderboardResponse(payload: PublicLeaderboardResponse): string {
  assertPublicLeaderboardPrivacy(payload)
  const serialized = JSON.stringify(payload)
  const sizeBytes = new TextEncoder().encode(serialized).byteLength
  if (sizeBytes > PUBLIC_LEADERBOARD_PAYLOAD_MAX_BYTES) throw new PublicLeaderboardPayloadTooLargeError(sizeBytes)
  return serialized
}

export function assertPublicLeaderboardPrivacy(value: unknown): void {
  visitPublicValue(value, '$', new Set<object>())
}

function visitPublicValue(value: unknown, path: string, seen: Set<object>): void {
  if (typeof value === 'string') {
    if (/https:\/\/cdn\.discordapp\.com\/avatars\//i.test(value)) {
      throw new Error(`Public leaderboard payload contains a Discord avatar URL at ${path}`)
    }
    return
  }
  if (!value || typeof value !== 'object') return
  if (seen.has(value)) throw new Error(`Public leaderboard payload contains a cycle at ${path}`)
  seen.add(value)

  if (Array.isArray(value)) {
    value.forEach((entry, index) => visitPublicValue(entry, `${path}[${index}]`, seen))
  }
  else {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_PUBLIC_KEYS.has(key)) throw new Error(`Public leaderboard payload contains forbidden key ${path}.${key}`)
      visitPublicValue(entry, `${path}.${key}`, seen)
    }
  }

  seen.delete(value)
}

function roundPercent(value: number): number {
  return Math.round(value * 10) / 10
}
