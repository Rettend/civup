import type { GameMode, QueueEntry } from '@civup/game'
import type { LobbyState } from './types.ts'
import { deriveQueueBackedLobbyMemberPlayerIds } from './reconcile.ts'
import { normalizeStoredSlots } from './normalize.ts'

export function normalizeLobbySlots(
  mode: GameMode,
  slots: (string | null)[] | null | undefined,
  queueEntries: QueueEntry[],
): (string | null)[] {
  const normalized = normalizeStoredSlots(mode, slots)
  const queuedIds = new Set(queueEntries.map(entry => entry.playerId))
  const usedIds = new Set<string>()

  for (let i = 0; i < normalized.length; i++) {
    const playerId = normalized[i]
    if (!playerId) continue
    if (!queuedIds.has(playerId) || usedIds.has(playerId)) {
      normalized[i] = null
      continue
    }
    usedIds.add(playerId)
  }

  return normalized
}

export function mapLobbySlotsToEntries(
  slotPlayerIds: (string | null)[],
  queueEntries: QueueEntry[],
): (QueueEntry | null)[] {
  const entryByPlayer = new Map<string, QueueEntry>(queueEntries.map(entry => [entry.playerId, entry]))
  return slotPlayerIds.map((playerId) => {
    if (!playerId) return null
    return entryByPlayer.get(playerId) ?? null
  })
}

export function sameLobbySlots(a: (string | null)[], b: (string | null)[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if ((a[i] ?? null) !== (b[i] ?? null)) return false
  }
  return true
}

export function filterQueueEntriesForLobby(lobby: LobbyState, queueEntries: QueueEntry[]): QueueEntry[] {
  const memberSet = new Set(deriveQueueBackedLobbyMemberPlayerIds(lobby, queueEntries))
  return queueEntries.filter(entry => memberSet.has(entry.playerId))
}
