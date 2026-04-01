import type { GameMode, QueueEntry } from '@civup/game'
import type { LobbyState } from './types.ts'
import { syncActivityOverviewSnapshotForLobby } from '../activity/live-state.ts'
import { getServerDraftTimerDefaults } from '../config/index.ts'
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
    minPlayers: slots.length,
    targetSize: slots.length,
    draftConfig: normalizeDraftConfigForMode(mode, lobby.draftConfig),
    serverDefaults,
  }
}

export async function storeLobbyLiveSnapshot(
  kv: KVNamespace,
  mode: GameMode,
  lobby: LobbyState,
  queueEntries?: QueueEntry[],
  slots?: (string | null)[],
): Promise<LobbySnapshot | null> {
  if (lobby.status !== 'open') {
    await clearLobbyLiveSnapshot(kv, lobby.id)
    return null
  }

  const resolvedQueueEntries = queueEntries ?? []
  const resolvedSlots = slots ?? normalizeLobbySlots(mode, lobby.slots, resolvedQueueEntries)
  const snapshot = await buildLobbyLiveSnapshotFromParts(kv, mode, lobby, resolvedQueueEntries, resolvedSlots)

  await stateStoreMput(kv, [{
    key: lobbySnapshotKey(lobby.id),
    value: JSON.stringify(snapshot),
    expirationTtl: LOBBY_TTL,
  }])

  return snapshot
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
