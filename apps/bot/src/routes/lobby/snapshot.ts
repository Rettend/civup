import type { CompetitiveTier, GameMode, QueueEntry } from '@civup/game'
import type { Database } from '@civup/db'
import type { LeaderboardModeSnapshot } from '../../services/leaderboard/snapshot.ts'
import type { LobbyState } from '../../services/lobby/index.ts'
import type { getRankedRoleConfig } from '../../services/ranked/roles.ts'
import { canStartWithPlayerCount, MAX_LEADER_POOL_SIZE, playerCountOptions, startPlayerCountOptions, toBalanceLeaderboardMode } from '@civup/game'
import { MAX_CONFIG_TIMER_SECONDS } from '../../services/config/index.ts'
import { getStoredLeaderboardModeSnapshot } from '../../services/leaderboard/snapshot.ts'
import { filterQueueEntriesForLobby, normalizeLobbySlots } from '../../services/lobby/index.ts'
import { attachLobbyBalanceRatings, buildLobbyLiveSnapshotFromParts } from '../../services/lobby/live-snapshot.ts'
import { normalizeRankedRoleTierId } from '../../services/ranked/roles.ts'
import { getOpenSessionLobbyProjectionsByChannel, getOpenSessionLobbyProjectionsByMode } from '../../services/session/index.ts'

export async function buildOpenLobbySnapshot(
  kv: KVNamespace,
  mode: GameMode,
  lobby: LobbyState,
) {
  const balanceSnapshot = await getLobbyBalanceSnapshot(kv, mode, lobby.draftConfig.redDeath)
  const resolvedQueueEntries = buildLobbyQueueEntries(lobby)
  const resolvedSlots = normalizeLobbySlots(mode, lobby.slots, resolvedQueueEntries)
  return buildOpenLobbySnapshotFromParts(kv, mode, lobby, resolvedQueueEntries, resolvedSlots, balanceSnapshot)
}

export async function buildOpenLobbySnapshotFromParts(
  kv: KVNamespace,
  mode: GameMode,
  lobby: LobbyState,
  queueEntries: QueueEntry[],
  slots: (string | null)[],
  balanceSnapshot?: LeaderboardModeSnapshot | null,
) {
  const snapshot = await buildLobbyLiveSnapshotFromParts(kv, mode, lobby, queueEntries, slots)
  return attachLobbyBalanceRatings(kv, mode, snapshot, balanceSnapshot)
}

export async function getLobbyBalanceSnapshot(
  kv: KVNamespace,
  mode: GameMode,
  redDeath = false,
): Promise<LeaderboardModeSnapshot | null> {
  const leaderboardMode = toBalanceLeaderboardMode(mode, { redDeath })
  return leaderboardMode ? await getStoredLeaderboardModeSnapshot(kv, leaderboardMode) : null
}

export function lobbyMinPlayerCount(mode: GameMode, targetSize: number, redDeath = false): number {
  return startPlayerCountOptions(mode, targetSize, { redDeath })[0] ?? targetSize
}

export function canStartLobbyWithPlayerCount(mode: GameMode, playerCount: number, targetSize: number, redDeath = false): boolean {
  return canStartWithPlayerCount(mode, playerCount, targetSize, { redDeath })
}

export async function getUniqueOpenLobbyForChannel(
  db: Database,
  channelId: string,
): Promise<LobbyState | null> {
  const openLobbies = (await getOpenSessionLobbyProjectionsByChannel(db, channelId))
    .filter(lobby => lobby.channelId === channelId && lobby.status === 'open')
    .sort((left, right) => right.updatedAt - left.updatedAt)

  if (openLobbies.length !== 1) return null
  return openLobbies[0] ?? null
}

export async function resolveOpenLobbyFromBody(
  db: Database,
  mode: GameMode,
  body: { lobbyId?: unknown },
): Promise<LobbyState | null> {
  const openLobbies = (await getOpenSessionLobbyProjectionsByMode(db, mode))
    .filter(lobby => lobby.status === 'open')
    .filter(lobby => lobby.memberPlayerIds.length > 0)

  if (typeof body.lobbyId === 'string' && body.lobbyId.length > 0) {
    return openLobbies.find(lobby => lobby.id === body.lobbyId) ?? null
  }

  if (openLobbies.length !== 1) return null
  return openLobbies[0] ?? null
}

export function buildLobbyQueueEntries(
  lobby: LobbyState,
  queueEntries: QueueEntry[] = [],
) {
  return filterQueueEntriesForLobby(lobby, queueEntries)
}

export function parseSlotIndex(value: unknown): number | null {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(numeric)) return null
  if (numeric < 0) return null
  return numeric
}

export function parseLobbyTimerSeconds(value: unknown): number | null | undefined {
  if (value == null) return null
  if (typeof value === 'string' && value.trim().length === 0) return null

  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return undefined

  const rounded = Math.round(numeric)
  if (rounded < 0 || rounded > MAX_CONFIG_TIMER_SECONDS) return undefined
  return rounded
}

export function parseLobbyLeaderPoolSize(value: unknown): number | null | undefined {
  if (value == null) return null
  if (typeof value === 'string' && value.trim().length === 0) return null

  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return undefined

  const rounded = Math.round(numeric)
  if (rounded < 1 || rounded > MAX_LEADER_POOL_SIZE) return undefined
  return rounded
}

export function parseLobbyTargetSize(mode: GameMode, value: unknown): number | undefined {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return undefined

  const rounded = Math.round(numeric)
  return playerCountOptions(mode).includes(rounded) ? rounded : undefined
}

export function parseLobbyMinRole(value: unknown): CompetitiveTier | null | undefined {
  if (value == null) return null
  if (typeof value === 'string' && value.trim().length === 0) return null
  return normalizeRankedRoleTierId(value) ?? undefined
}

export function parseLobbyMaxRole(value: unknown): CompetitiveTier | null | undefined {
  if (value == null) return null
  if (typeof value === 'string' && value.trim().length === 0) return null
  return normalizeRankedRoleTierId(value) ?? undefined
}

export function emptyRankedRoleConfig(): Awaited<ReturnType<typeof getRankedRoleConfig>> {
  return {
    tiers: Array.from({ length: 5 }, () => ({ roleId: null, label: null, color: null })),
  }
}
