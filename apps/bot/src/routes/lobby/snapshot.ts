import type { CompetitiveTier, GameMode } from '@civup/game'
import type { LobbyState } from '../../services/lobby/index.ts'
import type { LobbySnapshot } from '../../services/lobby/live-snapshot.ts'
import type { getRankedRoleConfig } from '../../services/ranked/roles.ts'
import { canStartWithPlayerCount, MAX_LEADER_POOL_SIZE, playerCountOptions, startPlayerCountOptions, toBalanceLeaderboardMode } from '@civup/game'
import { MAX_CONFIG_TIMER_SECONDS } from '../../services/config/index.ts'
import { getStoredLeaderboardModeSnapshot } from '../../services/leaderboard/snapshot.ts'
import { filterQueueEntriesForLobby, getLobbiesByChannel, getLobbiesByMode, normalizeLobbySlots, sameLobbySlots, setLobbySlots } from '../../services/lobby/index.ts'
import { buildLobbyLiveSnapshotFromParts } from '../../services/lobby/live-snapshot.ts'
import { getQueueState } from '../../services/queue/index.ts'
import { normalizeRankedRoleTierId } from '../../services/ranked/roles.ts'

export async function buildOpenLobbySnapshot(
  kv: KVNamespace,
  mode: GameMode,
  lobby: LobbyState,
) {
  const queue = await getQueueState(kv, mode)
  const lobbyQueueEntries = filterQueueEntriesForLobby(lobby, queue.entries)
  const normalizedSlots = normalizeLobbySlots(mode, lobby.slots, lobbyQueueEntries)

  if (sameLobbySlots(normalizedSlots, lobby.slots)) {
    return buildOpenLobbySnapshotFromParts(kv, mode, lobby, lobbyQueueEntries, normalizedSlots)
  }

  const updatedLobby = await setLobbySlots(kv, lobby.id, normalizedSlots)
  const resolvedLobby = updatedLobby ?? {
    ...lobby,
    slots: normalizedSlots,
  }
  return buildOpenLobbySnapshotFromParts(kv, mode, resolvedLobby, lobbyQueueEntries, normalizedSlots)
}

export async function buildOpenLobbySnapshotFromParts(
  kv: KVNamespace,
  mode: GameMode,
  lobby: LobbyState,
  queueEntries: Awaited<ReturnType<typeof getQueueState>>['entries'],
  slots: (string | null)[],
) {
  const snapshot = await buildLobbyLiveSnapshotFromParts(kv, mode, lobby, queueEntries, slots)
  return attachLobbyBalanceRatings(kv, mode, snapshot)
}

async function attachLobbyBalanceRatings(
  kv: KVNamespace,
  mode: GameMode,
  snapshot: LobbySnapshot,
): Promise<LobbySnapshot> {
  const leaderboardMode = toBalanceLeaderboardMode(mode, { redDeath: snapshot.draftConfig.redDeath })
  if (!leaderboardMode) return snapshot

  const leaderboardSnapshot = await getStoredLeaderboardModeSnapshot(kv, leaderboardMode)
  if (!leaderboardSnapshot) return snapshot

  const balanceRatingByPlayerId = new Map(leaderboardSnapshot.rows.map(row => [
    row.playerId,
    {
      mu: row.mu,
      sigma: row.sigma,
      gamesPlayed: row.gamesPlayed,
    },
  ]))

  let hasAttachedRatings = false
  const entries = snapshot.entries.map((entry) => {
    if (!entry) return null

    const balanceRating = balanceRatingByPlayerId.get(entry.playerId)
    if (!balanceRating) return entry

    hasAttachedRatings = true
    return {
      ...entry,
      balanceRating,
    }
  })

  if (!hasAttachedRatings) return snapshot
  return {
    ...snapshot,
    entries,
  }
}

export function lobbyMinPlayerCount(mode: GameMode, targetSize: number, redDeath = false): number {
  return startPlayerCountOptions(mode, targetSize, { redDeath })[0] ?? targetSize
}

export function canStartLobbyWithPlayerCount(mode: GameMode, playerCount: number, targetSize: number, redDeath = false): boolean {
  return canStartWithPlayerCount(mode, playerCount, targetSize, { redDeath })
}

export async function getUniqueOpenLobbyForChannel(
  kv: KVNamespace,
  channelId: string,
): Promise<LobbyState | null> {
  const openLobbies = (await getLobbiesByChannel(kv, channelId))
    .filter(lobby => lobby.channelId === channelId && lobby.status === 'open')
    .sort((left, right) => right.updatedAt - left.updatedAt)

  if (openLobbies.length !== 1) return null
  return openLobbies[0] ?? null
}

export async function resolveOpenLobbyFromBody(
  kv: KVNamespace,
  mode: GameMode,
  body: { lobbyId?: unknown },
): Promise<LobbyState | null> {
  const queue = await getQueueState(kv, mode)
  const openLobbies = (await getLobbiesByMode(kv, mode))
    .filter(lobby => lobby.status === 'open')
    .filter(lobby => isQueueBackedOpenLobby(lobby, filterQueueEntriesForLobby(lobby, queue.entries)))

  if (typeof body.lobbyId === 'string' && body.lobbyId.length > 0) {
    return openLobbies.find(lobby => lobby.id === body.lobbyId) ?? null
  }

  if (openLobbies.length !== 1) return null
  return openLobbies[0] ?? null
}

export function buildLobbyQueueEntries(
  lobby: LobbyState,
  queueEntries: Awaited<ReturnType<typeof getQueueState>>['entries'],
) {
  return filterQueueEntriesForLobby(lobby, queueEntries)
}

export function isQueueBackedOpenLobby(
  lobby: Pick<LobbyState, 'hostId'>,
  queueEntries: Awaited<ReturnType<typeof getQueueState>>['entries'],
): boolean {
  return queueEntries.some(entry => entry.playerId === lobby.hostId)
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
