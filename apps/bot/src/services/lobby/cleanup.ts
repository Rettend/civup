import type { GameMode } from '@civup/game'
import type { LobbySessionProjectionOptions } from './mutations.ts'
import type { LobbyState } from './types.ts'
import { GAME_MODES, slotToTeamIndex } from '@civup/game'
import { lobbyTimeoutEmbed } from '../../embeds/match.ts'
import { upsertLobbyMessage } from './message.ts'
import { setLobbyStatus } from './mutations.ts'
import { filterQueueEntriesForLobby, normalizeLobbySlots } from './slots.ts'
import { getOpenSessionLobbyProjectionsByMode } from '../session/index.ts'

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
  } & LobbySessionProjectionOptions = {},
): Promise<PrunedInactiveLobby[]> {
  const now = options.now ?? Date.now()
  const pruned: PrunedInactiveLobby[] = []
  if (!options.db) return pruned

  const currentLobbies = (await Promise.all(GAME_MODES.map(mode => getOpenSessionLobbyProjectionsByMode(options.db!, mode, { includeStale: true })))).flat()
  for (const lobby of currentLobbies) {
    if (!isLobbyInactive(lobby, now)) continue
    pruned.push(await expireOpenLobby(kv, token, lobby, {
      db: options.db,
      sessionNamespace: options.sessionNamespace,
    }))
  }

  return pruned
}

async function expireOpenLobby(
  kv: KVNamespace,
  token: string | undefined,
  lobby: LobbyState,
  options: LobbySessionProjectionOptions = {},
): Promise<PrunedInactiveLobby> {
  const lobbyQueueEntries = filterQueueEntriesForLobby(lobby, options.queueEntries ? [...options.queueEntries] : [])
  const removedPlayerIds = lobbyQueueEntries.map(entry => entry.playerId)
  const slots = normalizeLobbySlots(lobby.mode, lobby.slots, lobbyQueueEntries)
  const cancelledLobby = await setLobbyStatus(kv, lobby.id, 'cancelled', lobby, {
    ...options,
    queueEntries: lobbyQueueEntries,
  }) ?? lobby

  if (token) {
    try {
      await upsertLobbyMessage(kv, token, cancelledLobby, {
        embeds: [lobbyTimeoutEmbed(lobby.mode, buildInactiveLobbyParticipants(lobby.mode, slots), undefined, lobby.draftConfig.redDeath)],
        components: [],
      }, options)
    }
    catch (error) {
      console.error(`Failed to update inactivity-cancelled lobby embed for lobby ${lobby.id}:`, error)
    }
  }

  return {
    lobbyId: lobby.id,
    mode: lobby.mode,
    removedPlayerIds,
  }
}

function buildInactiveLobbyParticipants(mode: GameMode, slots: (string | null)[]) {
  return slots
    .map((playerId, slot) => {
      if (!playerId) return null
      return {
        playerId,
        team: slotToTeamIndex(mode, slot, slots.length),
        civId: null,
        placement: null,
        ratingBeforeMu: null,
        ratingBeforeSigma: null,
        ratingAfterMu: null,
        ratingAfterSigma: null,
      }
    })
    .filter((participant): participant is NonNullable<typeof participant> => participant != null)
}
