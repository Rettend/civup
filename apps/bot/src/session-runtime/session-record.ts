import type { GameMode, QueueEntry } from '@civup/game'
import type { LobbyDraftConfig, LobbyState } from '../services/lobby/types.ts'

export type SessionId = string
export type SessionPhase = 'open' | 'draft' | 'active' | 'reported' | 'cancelled'

export interface SessionRosterMember {
  playerId: string
  displayName: string | null
  avatarUrl: string | null
  joinedAt: number
  slotIndex: number | null
}

export interface SessionRoster {
  participants: SessionRosterMember[]
  slots: (string | null)[]
}

export interface SessionProjectionState {
  channelId: string
  messageId: string
  steamLobbyLink: string | null
}

export interface OpenSessionRecord {
  phase: 'open'
  id: SessionId
  version: number
  hostId: string
  guildId: string | null
  channelId: string
  mode: GameMode
  config: LobbyDraftConfig
  roster: SessionRoster
  projectionState: SessionProjectionState
  createdAt: number
  updatedAt: number
  lastActivityAt: number
}

export type SessionRecord = OpenSessionRecord

export function buildOpenSessionRecordFromLobby(
  lobby: LobbyState,
  queueEntries: readonly QueueEntry[] = [],
): OpenSessionRecord {
  return {
    phase: 'open',
    id: lobby.id,
    version: lobby.revision,
    hostId: lobby.hostId,
    guildId: lobby.guildId,
    channelId: lobby.channelId,
    mode: lobby.mode,
    config: lobby.draftConfig,
    roster: buildSessionRoster(lobby, queueEntries),
    projectionState: {
      channelId: lobby.channelId,
      messageId: lobby.messageId,
      steamLobbyLink: lobby.steamLobbyLink,
    },
    createdAt: lobby.createdAt,
    updatedAt: lobby.updatedAt,
    lastActivityAt: lobby.lastActivityAt,
  }
}

export function buildSessionRoster(
  lobby: Pick<LobbyState, 'memberPlayerIds' | 'slots'>,
  queueEntries: readonly QueueEntry[] = [],
): SessionRoster {
  const queueEntryByPlayerId = new Map(queueEntries.map(entry => [entry.playerId, entry]))
  const slotIndexByPlayerId = new Map<string, number>()
  lobby.slots.forEach((playerId, index) => {
    if (playerId && !slotIndexByPlayerId.has(playerId)) slotIndexByPlayerId.set(playerId, index)
  })

  return {
    participants: lobby.memberPlayerIds.map((playerId) => {
      const queueEntry = queueEntryByPlayerId.get(playerId)
      return {
        playerId,
        displayName: queueEntry?.displayName ?? null,
        avatarUrl: queueEntry?.avatarUrl ?? null,
        joinedAt: queueEntry?.joinedAt ?? 0,
        slotIndex: slotIndexByPlayerId.get(playerId) ?? null,
      }
    }),
    slots: [...lobby.slots],
  }
}
