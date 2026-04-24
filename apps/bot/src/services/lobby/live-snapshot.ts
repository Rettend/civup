import type { GameMode, QueueEntry } from '@civup/game'
import type { LeaderboardModeSnapshot } from '../leaderboard/snapshot.ts'
import type { LobbyState } from './types.ts'
import { buildOpenSessionRecordFromLobby } from '../../session-runtime/session-record.ts'
import { attachLobbyBalanceRatingsToSnapshot, buildLobbySnapshotFromSessionRecord, type LobbySnapshot } from '../activity/session-state.ts'
import { filterQueueEntriesForLobby, normalizeLobbySlots } from './slots.ts'

export type { LobbySnapshot }

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
  _mode: GameMode,
  lobby: LobbyState,
  queueEntries: QueueEntry[],
  slots: (string | null)[],
): Promise<LobbySnapshot> {
  return buildLobbySnapshotFromSessionRecord(kv, buildOpenSessionRecordFromLobby({ ...lobby, slots }, queueEntries))
}

export function attachLobbyBalanceRatings(
  kv: KVNamespace,
  mode: GameMode,
  snapshot: LobbySnapshot,
  balanceSnapshot?: LeaderboardModeSnapshot | null,
): Promise<LobbySnapshot> {
  return attachLobbyBalanceRatingsToSnapshot(kv, mode, snapshot, balanceSnapshot)
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
  if (lobby.status !== 'open') return null

  const queueEntries = options?.queueEntries ?? filterLobbySnapshotQueueEntries(lobby, [])

  const slots = options?.slots ?? normalizeLobbySlots(lobby.mode, lobby.slots, queueEntries)
  const snapshot = await buildLobbyLiveSnapshotFromParts(kv, lobby.mode, lobby, queueEntries, slots)
  return attachLobbyBalanceRatings(kv, lobby.mode, snapshot, options?.balanceSnapshot)
}

export function filterLobbySnapshotQueueEntries(lobby: LobbyState, queueEntries: QueueEntry[]): QueueEntry[] {
  return filterQueueEntriesForLobby(lobby, queueEntries)
}
