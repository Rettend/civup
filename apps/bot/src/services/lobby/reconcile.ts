import type { QueueEntry, QueueState } from '@civup/game'
import type { LobbyState } from './types.ts'
import { getQueueState } from '../queue/index.ts'
import { sameStringArray } from './normalize.ts'
import { getLobbyById, upsertLobby } from './store.ts'
import { normalizeLobbySlots, sameLobbySlots } from './slots.ts'

/** Build the best queue-backed roster for an open lobby. */
export function deriveQueueBackedLobbyMemberPlayerIds(
  lobby: Pick<LobbyState, 'hostId' | 'memberPlayerIds' | 'slots'>,
  queueEntries: QueueEntry[],
): string[] {
  const queueByPlayerId = new Map(queueEntries.map(entry => [entry.playerId, entry]))
  const memberIds: string[] = []
  const memberIdSet = new Set<string>()
  const append = (playerId: string | null | undefined) => {
    if (!playerId || memberIdSet.has(playerId) || !queueByPlayerId.has(playerId)) return
    memberIdSet.add(playerId)
    memberIds.push(playerId)
  }

  for (const playerId of lobby.memberPlayerIds) append(playerId)
  for (const playerId of lobby.slots) append(playerId)
  append(lobby.hostId)

  return memberIds
}

export function isQueueBackedOpenLobbyState(
  lobby: Pick<LobbyState, 'hostId' | 'memberPlayerIds' | 'slots'>,
  queueEntries: QueueEntry[],
): boolean {
  return deriveQueueBackedLobbyMemberPlayerIds(lobby, queueEntries).length > 0
}

export async function reconcileOpenLobbyState(
  kv: KVNamespace,
  lobbyOrId: string | LobbyState,
  options?: {
    currentQueue?: QueueState
  },
): Promise<{
  lobby: LobbyState
  queue: QueueState
  lobbyQueueEntries: QueueEntry[]
  slots: (string | null)[]
} | null> {
  const loadedLobby = typeof lobbyOrId === 'string'
    ? await getLobbyById(kv, lobbyOrId)
    : await getLobbyById(kv, lobbyOrId.id) ?? lobbyOrId
  if (!loadedLobby || loadedLobby.status !== 'open') return null

  const queue = options?.currentQueue ?? await getQueueState(kv, loadedLobby.mode)
  const reconciledMemberPlayerIds = deriveQueueBackedLobbyMemberPlayerIds(loadedLobby, queue.entries)
  const reconciledMemberSet = new Set(reconciledMemberPlayerIds)
  const reconciledLobbyQueueEntries = queue.entries.filter(entry => reconciledMemberSet.has(entry.playerId))
  const reconciledSlots = normalizeLobbySlots(loadedLobby.mode, loadedLobby.slots, reconciledLobbyQueueEntries)

  let lobby = loadedLobby
  if (!sameStringArray(loadedLobby.memberPlayerIds, reconciledMemberPlayerIds) || !sameLobbySlots(loadedLobby.slots, reconciledSlots)) {
    lobby = {
      ...loadedLobby,
      memberPlayerIds: reconciledMemberPlayerIds,
      slots: reconciledSlots,
      updatedAt: Date.now(),
      revision: loadedLobby.revision + 1,
    }
    await upsertLobby(kv, lobby)
  }

  return {
    lobby,
    queue,
    lobbyQueueEntries: reconciledLobbyQueueEntries,
    slots: reconciledSlots,
  }
}
