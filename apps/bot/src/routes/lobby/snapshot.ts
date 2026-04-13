import type { CompetitiveTier, GameMode, QueueState } from '@civup/game'
import type { LobbyState } from '../../services/lobby/index.ts'
import type { LeaderboardModeSnapshot } from '../../services/leaderboard/snapshot.ts'
import type { getRankedRoleConfig } from '../../services/ranked/roles.ts'
import { canStartWithPlayerCount, MAX_LEADER_POOL_SIZE, playerCountOptions, startPlayerCountOptions, toBalanceLeaderboardMode } from '@civup/game'
import { MAX_CONFIG_TIMER_SECONDS } from '../../services/config/index.ts'
import { leaderboardModeSnapshotKey, normalizeLeaderboardModeSnapshot } from '../../services/leaderboard/snapshot.ts'
import { filterQueueEntriesForLobby, getLobbiesByChannel, getLobbiesByMode, normalizeLobbySlots, sameLobbySlots, setLobbySlots } from '../../services/lobby/index.ts'
import { attachLobbyBalanceRatings, buildLobbyLiveSnapshotFromParts } from '../../services/lobby/live-snapshot.ts'
import { getQueueState, parseQueueState, queueKey } from '../../services/queue/index.ts'
import { normalizeRankedRoleTierId } from '../../services/ranked/roles.ts'
import { stateStoreMget } from '../../services/state/store.ts'

export async function buildOpenLobbySnapshot(
  kv: KVNamespace,
  mode: GameMode,
  lobby: LobbyState,
) {
  const { queue, balanceSnapshot } = await getQueueStateWithLobbyBalanceSnapshot(kv, mode, lobby.draftConfig.redDeath)
  const lobbyQueueEntries = filterQueueEntriesForLobby(lobby, queue.entries)
  const normalizedSlots = normalizeLobbySlots(mode, lobby.slots, lobbyQueueEntries)

  if (sameLobbySlots(normalizedSlots, lobby.slots)) {
    return buildOpenLobbySnapshotFromParts(kv, mode, lobby, lobbyQueueEntries, normalizedSlots, balanceSnapshot)
  }

  const updatedLobby = await setLobbySlots(kv, lobby.id, normalizedSlots)
  const resolvedLobby = updatedLobby ?? {
    ...lobby,
    slots: normalizedSlots,
  }
  return buildOpenLobbySnapshotFromParts(kv, mode, resolvedLobby, lobbyQueueEntries, normalizedSlots, balanceSnapshot)
}

export async function buildOpenLobbySnapshotFromParts(
  kv: KVNamespace,
  mode: GameMode,
  lobby: LobbyState,
  queueEntries: Awaited<ReturnType<typeof getQueueState>>['entries'],
  slots: (string | null)[],
  balanceSnapshot?: LeaderboardModeSnapshot | null,
) {
  const snapshot = await buildLobbyLiveSnapshotFromParts(kv, mode, lobby, queueEntries, slots)
  return attachLobbyBalanceRatings(kv, mode, snapshot, balanceSnapshot)
}

export async function getQueueStateWithLobbyBalanceSnapshot(
  kv: KVNamespace,
  mode: GameMode,
  redDeath = false,
): Promise<{
  queue: QueueState
  balanceSnapshot: LeaderboardModeSnapshot | null
}> {
  const leaderboardMode = toBalanceLeaderboardMode(mode, { redDeath })
  if (!leaderboardMode) {
    return {
      queue: await getQueueState(kv, mode),
      balanceSnapshot: null,
    }
  }

  const [rawQueueState, rawBalanceSnapshot] = await stateStoreMget(kv, [
    { key: queueKey(mode), type: 'json' },
    { key: leaderboardModeSnapshotKey(leaderboardMode), type: 'json' },
  ])

  return {
    queue: parseQueueState(mode, rawQueueState),
    balanceSnapshot: normalizeLeaderboardModeSnapshot(leaderboardMode, rawBalanceSnapshot),
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
