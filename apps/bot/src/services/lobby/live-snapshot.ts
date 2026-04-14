import type { GameMode, QueueEntry } from '@civup/game'
import type { LobbyState } from './types.ts'
import type { LeaderboardModeSnapshot } from '../leaderboard/snapshot.ts'
import { startPlayerCountOptions, toBalanceLeaderboardMode } from '@civup/game'
import { syncActivityOverviewSnapshotForLobby } from '../activity/live-state.ts'
import { getServerDraftTimerDefaults } from '../config/index.ts'
import { getStoredLeaderboardModeSnapshot } from '../leaderboard/snapshot.ts'
import { getQueueState } from '../queue/index.ts'
import { stateStoreMdelete, stateStoreMput } from '../state/store.ts'
import { LOBBY_TTL } from './keys.ts'
import { normalizeDraftConfigForMode } from './normalize.ts'
import { filterQueueEntriesForLobby, mapLobbySlotsToEntries, normalizeLobbySlots } from './slots.ts'

const LOBBY_SNAPSHOT_KEY_PREFIX = 'lobby:snapshot:'

export interface LobbySnapshot {
  id: string
  revision: number
  mode: string
  hostId: string
  status: string
  steamLobbyLink: string | null
  minRole: LobbyState['minRole']
  maxRole: LobbyState['maxRole']
  entries: ({
    playerId: string
    displayName: string
    avatarUrl?: string | null
    partyIds?: string[]
    balanceRating?: {
      mu: number
      sigma: number
      gamesPlayed: number
    }
  } | null)[]
  minPlayers: number
  targetSize: number
  draftConfig: LobbyState['draftConfig']
  serverDefaults: {
    banTimerSeconds: number | null
    pickTimerSeconds: number | null
  }
}

export function lobbySnapshotKey(lobbyId: string): string {
  return `${LOBBY_SNAPSHOT_KEY_PREFIX}${lobbyId}`
}

export async function buildLobbyLiveSnapshot(
  kv: KVNamespace,
  mode: GameMode,
  lobby: LobbyState,
  queueEntries: QueueEntry[],
): Promise<LobbySnapshot> {
  const slots = normalizeLobbySlots(mode, lobby.slots, queueEntries)
  return buildLobbyLiveSnapshotFromParts(kv, mode, lobby, queueEntries, slots)
}

export async function buildLobbyLiveSnapshotFromParts(
  kv: KVNamespace,
  mode: GameMode,
  lobby: LobbyState,
  queueEntries: QueueEntry[],
  slots: (string | null)[],
): Promise<LobbySnapshot> {
  const slotEntries = mapLobbySlotsToEntries(slots, queueEntries)
  const serverDefaults = await getServerDraftTimerDefaults(kv)
  const normalizedDraftConfig = normalizeDraftConfigForMode(mode, lobby.draftConfig)
  const minPlayers = startPlayerCountOptions(mode, slots.length, { redDeath: normalizedDraftConfig.redDeath })[0] ?? slots.length

  return {
    id: lobby.id,
    revision: lobby.revision,
    mode,
    hostId: lobby.hostId,
    status: lobby.status,
    steamLobbyLink: lobby.steamLobbyLink,
    minRole: lobby.minRole,
    maxRole: lobby.maxRole,
    entries: slotEntries.map((entry) => {
      if (!entry) return null
      return {
        playerId: entry.playerId,
        displayName: entry.displayName,
        avatarUrl: entry.avatarUrl ?? null,
        partyIds: entry.partyIds ?? [],
      }
    }),
    minPlayers,
    targetSize: slots.length,
    draftConfig: normalizedDraftConfig,
    serverDefaults,
  }
}

export async function storeLobbyLiveSnapshot(
  kv: KVNamespace,
  mode: GameMode,
  lobby: LobbyState,
  queueEntries?: QueueEntry[],
  slots?: (string | null)[],
  balanceSnapshot?: LeaderboardModeSnapshot | null,
): Promise<LobbySnapshot | null> {
  if (lobby.status !== 'open') {
    await clearLobbyLiveSnapshot(kv, lobby.id)
    return null
  }

  const resolvedQueueEntries = queueEntries ?? []
  const resolvedSlots = slots ?? normalizeLobbySlots(mode, lobby.slots, resolvedQueueEntries)
  const snapshot = await attachLobbyBalanceRatings(
    kv,
    mode,
    await buildLobbyLiveSnapshotFromParts(kv, mode, lobby, resolvedQueueEntries, resolvedSlots),
    balanceSnapshot,
  )

  await stateStoreMput(kv, [{
    key: lobbySnapshotKey(lobby.id),
    value: JSON.stringify(snapshot),
    expirationTtl: LOBBY_TTL,
  }])

  return snapshot
}

export async function attachLobbyBalanceRatings(
  kv: KVNamespace,
  mode: GameMode,
  snapshot: LobbySnapshot,
  balanceSnapshot?: LeaderboardModeSnapshot | null,
): Promise<LobbySnapshot> {
  const leaderboardMode = toBalanceLeaderboardMode(mode, { redDeath: snapshot.draftConfig.redDeath })
  if (!leaderboardMode) return snapshot

  const leaderboardSnapshot = balanceSnapshot === undefined
    ? await getStoredLeaderboardModeSnapshot(kv, leaderboardMode)
    : balanceSnapshot
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

export async function clearLobbyLiveSnapshot(kv: KVNamespace, lobbyId: string): Promise<void> {
  await stateStoreMdelete(kv, [lobbySnapshotKey(lobbyId)])
}

export async function syncLobbyDerivedState(
  kv: KVNamespace,
  lobby: LobbyState,
  options?: {
    queueEntries?: QueueEntry[]
    slots?: (string | null)[]
    balanceSnapshot?: LeaderboardModeSnapshot | null
  },
): Promise<LobbySnapshot | null> {
  let queueEntries = options?.queueEntries
  if (lobby.status === 'open' && !queueEntries) {
    const queue = await getQueueState(kv, lobby.mode)
    queueEntries = filterLobbySnapshotQueueEntries(lobby, queue.entries)
  }

  let snapshot: LobbySnapshot | null = null
  if (lobby.status === 'open') {
    snapshot = await storeLobbyLiveSnapshot(
      kv,
      lobby.mode,
      lobby,
      queueEntries,
      options?.slots ?? normalizeLobbySlots(lobby.mode, lobby.slots, queueEntries ?? []),
      options?.balanceSnapshot,
    )
  }
  else {
    await clearLobbyLiveSnapshot(kv, lobby.id)
  }

  await syncActivityOverviewSnapshotForLobby(kv, lobby)
  return snapshot
}

export function filterLobbySnapshotQueueEntries(lobby: LobbyState, queueEntries: QueueEntry[]): QueueEntry[] {
  return filterQueueEntriesForLobby(lobby, queueEntries)
}
