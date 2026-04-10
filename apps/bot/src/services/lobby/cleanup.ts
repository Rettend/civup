import type { GameMode, QueueState } from '@civup/game'
import type { LobbyState } from './types.ts'
import { GAME_MODES, slotToTeamIndex } from '@civup/game'
import { buildLobbyImageMessage } from '../discord/lobby-card.ts'
import { clearLobbyMappingsIfMatchingLobby } from '../activity/index.ts'
import { clearQueue, getQueueState } from '../queue/index.ts'
import { upsertLobbyMessage } from './message.ts'
import { setLobbyStatus } from './mutations.ts'
import { filterQueueEntriesForLobby, normalizeLobbySlots } from './slots.ts'
import { clearLobbyById, getLobbiesByMode } from './store.ts'

export const LOBBY_TIMEOUT_MESSAGE = 'This lobby timed out due to inactivity.'
export const LOBBY_INACTIVITY_TIMEOUT_MS = 60 * 60 * 1000 // 1 hour

export interface PrunedInactiveLobby {
  lobbyId: string
  mode: GameMode
  removedPlayerIds: string[]
}

export function isLobbyInactive(
  lobby: Pick<LobbyState, 'status' | 'lastActivityAt'>,
  now: number = Date.now(),
): boolean {
  return lobby.status === 'open' && now - lobby.lastActivityAt >= LOBBY_INACTIVITY_TIMEOUT_MS
}

export async function pruneInactiveOpenLobbies(
  kv: KVNamespace,
  token: string | undefined,
  options: {
    now?: number
  } = {},
): Promise<PrunedInactiveLobby[]> {
  const now = options.now ?? Date.now()
  const pruned: PrunedInactiveLobby[] = []

  for (const mode of GAME_MODES) {
    let queue = await getQueueState(kv, mode)
    const lobbies = await getLobbiesByMode(kv, mode)

    for (const lobby of lobbies) {
      if (!isLobbyInactive(lobby, now)) continue
      const expired = await expireOpenLobby(kv, token, lobby, {
        currentQueue: queue,
      })
      pruned.push(expired)
      queue = {
        ...queue,
        entries: queue.entries.filter(entry => !expired.removedPlayerIds.includes(entry.playerId)),
      }
    }
  }

  return pruned
}

async function expireOpenLobby(
  kv: KVNamespace,
  token: string | undefined,
  lobby: LobbyState,
  options: {
    currentQueue?: QueueState
  } = {},
): Promise<PrunedInactiveLobby> {
  const queue = options.currentQueue ?? await getQueueState(kv, lobby.mode)
  const lobbyQueueEntries = filterQueueEntriesForLobby(lobby, queue.entries)
  const removedPlayerIds = lobbyQueueEntries.map(entry => entry.playerId)
  const slots = normalizeLobbySlots(lobby.mode, lobby.slots, lobbyQueueEntries)
  const cancelledLobby = await setLobbyStatus(kv, lobby.id, 'cancelled', lobby) ?? lobby

  if (token) {
    try {
      const renderPayload = await buildLobbyImageMessage({
        mode: lobby.mode,
        stage: 'timeout',
        participants: buildInactiveLobbyParticipants(lobby.mode, slots, lobbyQueueEntries),
        leaderDataVersion: lobby.draftConfig.leaderDataVersion,
        redDeath: lobby.draftConfig.redDeath,
      })
      await upsertLobbyMessage(kv, token, cancelledLobby, {
        ...renderPayload,
        components: [],
      })
    }
    catch (error) {
      console.error(`Failed to update inactivity-cancelled lobby embed for lobby ${lobby.id}:`, error)
    }
  }

  if (removedPlayerIds.length > 0) {
    await clearQueue(kv, lobby.mode, removedPlayerIds, {
      currentState: queue,
    })
    await clearLobbyMappingsIfMatchingLobby(kv, removedPlayerIds, lobby.id, lobby.channelId)
  }

  await clearLobbyById(kv, lobby.id, cancelledLobby)

  return {
    lobbyId: lobby.id,
    mode: lobby.mode,
    removedPlayerIds,
  }
}

function buildInactiveLobbyParticipants(mode: GameMode, slots: (string | null)[], entries: QueueState['entries']) {
  const entryByPlayerId = new Map(entries.map(entry => [entry.playerId, entry]))
  return slots
    .map((playerId, slot) => {
      if (!playerId) return null
      const entry = entryByPlayerId.get(playerId)
      return {
        playerId,
        team: slotToTeamIndex(mode, slot),
        civId: null,
        placement: null,
        ratingBeforeMu: null,
        ratingBeforeSigma: null,
        ratingAfterMu: null,
        ratingAfterSigma: null,
        displayName: entry?.displayName ?? playerId,
        avatarUrl: entry?.avatarUrl ?? null,
      }
    })
    .filter((participant): participant is NonNullable<typeof participant> => participant != null)
}
