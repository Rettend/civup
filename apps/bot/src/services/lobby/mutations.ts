import type { CompetitiveTier, GameMode } from '@civup/game'
import type { LobbyDraftConfig, LobbyState, LobbyStatus } from './types.ts'
import { nanoid } from 'nanoid'
import { stateStoreMdelete } from '../state/store.ts'
import { channelIndexKey } from './keys.ts'
import { createEmptySlots, DEFAULT_DRAFT_CONFIG, normalizeCompetitiveTier, normalizeDraftConfig, normalizeMemberPlayerIds, normalizeStoredSlots, sameDraftConfig, sameStringArray } from './normalize.ts'
import { getLobbyById, putLobby } from './store.ts'

const LOBBY_STATUS_TRANSITIONS: Record<LobbyStatus, LobbyStatus[]> = {
  open: ['drafting', 'cancelled'],
  drafting: ['active', 'completed', 'cancelled', 'scrubbed'],
  active: ['completed', 'cancelled', 'scrubbed'],
  completed: [],
  cancelled: [],
  scrubbed: [],
}

export function canTransitionLobbyStatus(from: LobbyStatus, to: LobbyStatus): boolean {
  if (from === to) return true
  return LOBBY_STATUS_TRANSITIONS[from].includes(to)
}

export async function createLobby(
  kv: KVNamespace,
  input: {
    mode: GameMode
    guildId?: string | null
    hostId: string
    channelId: string
    messageId: string
    steamLobbyLink?: string | null
  },
): Promise<LobbyState> {
  const now = Date.now()
  const slots = createEmptySlots(input.mode)
  slots[0] = input.hostId

  const lobby: LobbyState = {
    id: nanoid(10),
    mode: input.mode,
    status: 'open',
    guildId: input.guildId?.trim() || null,
    hostId: input.hostId,
    channelId: input.channelId,
    messageId: input.messageId,
    matchId: null,
    steamLobbyLink: input.steamLobbyLink ?? null,
    minRole: null,
    memberPlayerIds: [input.hostId],
    slots,
    draftConfig: { ...DEFAULT_DRAFT_CONFIG },
    createdAt: now,
    updatedAt: now,
    revision: 1,
  }
  await putLobby(kv, lobby)
  return lobby
}

export async function attachLobbyMatch(
  kv: KVNamespace,
  lobbyId: string,
  matchId: string,
  currentLobby?: LobbyState,
): Promise<LobbyState | null> {
  const lobby = currentLobby?.id === lobbyId ? currentLobby : await getLobbyById(kv, lobbyId)
  if (!lobby) return null

  if (lobby.status === 'drafting' && lobby.matchId === matchId) return lobby
  if (!canTransitionLobbyStatus(lobby.status, 'drafting')) {
    console.warn('[lobby-transition] attachLobbyMatch rejected', {
      lobbyId,
      mode: lobby.mode,
      matchId,
      from: lobby.status,
      to: 'drafting',
      revision: lobby.revision,
    })
    return null
  }

  const updated: LobbyState = {
    ...lobby,
    status: 'drafting',
    matchId,
    updatedAt: Date.now(),
    revision: lobby.revision + 1,
  }
  await putLobby(kv, updated)
  return updated
}

export async function setLobbyStatus(
  kv: KVNamespace,
  lobbyId: string,
  status: LobbyStatus,
  currentLobby?: LobbyState,
): Promise<LobbyState | null> {
  const lobby = currentLobby?.id === lobbyId ? currentLobby : await getLobbyById(kv, lobbyId)
  if (!lobby) return null

  if (lobby.status === status) return lobby
  if (!canTransitionLobbyStatus(lobby.status, status)) {
    console.warn('[lobby-transition] setLobbyStatus rejected', {
      lobbyId,
      mode: lobby.mode,
      matchId: lobby.matchId,
      from: lobby.status,
      to: status,
      revision: lobby.revision,
    })
    return null
  }

  const updated: LobbyState = {
    ...lobby,
    status,
    updatedAt: Date.now(),
    revision: lobby.revision + 1,
  }
  await putLobby(kv, updated)
  return updated
}

export async function setLobbyMessage(
  kv: KVNamespace,
  lobbyId: string,
  channelId: string,
  messageId: string,
): Promise<LobbyState | null> {
  const lobby = await getLobbyById(kv, lobbyId)
  if (!lobby) return null

  if (lobby.channelId === channelId && lobby.messageId === messageId) return lobby

  const updated: LobbyState = {
    ...lobby,
    channelId,
    messageId,
    updatedAt: Date.now(),
    revision: lobby.revision + 1,
  }
  if (lobby.channelId !== channelId) {
    await stateStoreMdelete(kv, [channelIndexKey(lobby.channelId, lobby.id)])
  }
  await putLobby(kv, updated)
  return updated
}

export async function setLobbyDraftConfig(
  kv: KVNamespace,
  lobbyId: string,
  draftConfig: LobbyDraftConfig,
  currentLobby?: LobbyState,
): Promise<LobbyState | null> {
  const lobby = currentLobby?.id === lobbyId ? currentLobby : await getLobbyById(kv, lobbyId)
  if (!lobby) return null

  const normalizedDraftConfig = normalizeDraftConfig(draftConfig)
  if (sameDraftConfig(lobby.draftConfig, normalizedDraftConfig)) return lobby

  const updated: LobbyState = {
    ...lobby,
    draftConfig: normalizedDraftConfig,
    updatedAt: Date.now(),
    revision: lobby.revision + 1,
  }
  await putLobby(kv, updated)
  return updated
}

export async function setLobbyMinRole(
  kv: KVNamespace,
  lobbyId: string,
  minRole: CompetitiveTier | null,
  currentLobby?: LobbyState,
): Promise<LobbyState | null> {
  const lobby = currentLobby?.id === lobbyId ? currentLobby : await getLobbyById(kv, lobbyId)
  if (!lobby) return null

  const normalizedMinRole = normalizeCompetitiveTier(minRole)
  if (lobby.minRole === normalizedMinRole) return lobby

  const updated: LobbyState = {
    ...lobby,
    minRole: normalizedMinRole,
    updatedAt: Date.now(),
    revision: lobby.revision + 1,
  }
  await putLobby(kv, updated)
  return updated
}

export async function setLobbySteamLobbyLink(
  kv: KVNamespace,
  lobbyId: string,
  steamLobbyLink: string | null,
  currentLobby?: LobbyState,
): Promise<LobbyState | null> {
  const lobby = currentLobby?.id === lobbyId ? currentLobby : await getLobbyById(kv, lobbyId)
  if (!lobby) return null

  if (lobby.steamLobbyLink === steamLobbyLink) return lobby

  const updated: LobbyState = {
    ...lobby,
    steamLobbyLink,
    updatedAt: Date.now(),
    revision: lobby.revision + 1,
  }
  await putLobby(kv, updated)
  return updated
}

export async function setLobbySlots(
  kv: KVNamespace,
  lobbyId: string,
  slots: (string | null)[],
  currentLobby?: LobbyState,
): Promise<LobbyState | null> {
  const lobby = currentLobby?.id === lobbyId ? currentLobby : await getLobbyById(kv, lobbyId)
  if (!lobby) return null

  const normalizedSlots = normalizeStoredSlots(lobby.mode, slots)
  if (lobby.slots.length === normalizedSlots.length && lobby.slots.every((value, index) => value === normalizedSlots[index])) return lobby

  const updated: LobbyState = {
    ...lobby,
    slots: normalizedSlots,
    updatedAt: Date.now(),
    revision: lobby.revision + 1,
  }
  await putLobby(kv, updated)
  return updated
}

export async function setLobbyMemberPlayerIds(
  kv: KVNamespace,
  lobbyId: string,
  memberPlayerIds: string[],
  currentLobby?: LobbyState,
): Promise<LobbyState | null> {
  const lobby = currentLobby?.id === lobbyId ? currentLobby : await getLobbyById(kv, lobbyId)
  if (!lobby) return null

  const normalizedMemberIds = normalizeMemberPlayerIds(memberPlayerIds)
  if (sameStringArray(lobby.memberPlayerIds, normalizedMemberIds)) return lobby

  const updated: LobbyState = {
    ...lobby,
    memberPlayerIds: normalizedMemberIds,
    updatedAt: Date.now(),
    revision: lobby.revision + 1,
  }
  await putLobby(kv, updated)
  return updated
}

export async function touchLobby(
  kv: KVNamespace,
  lobbyId: string,
  currentLobby?: LobbyState,
): Promise<LobbyState | null> {
  const lobby = currentLobby?.id === lobbyId ? currentLobby : await getLobbyById(kv, lobbyId)
  if (!lobby) return null

  const updated: LobbyState = {
    ...lobby,
    updatedAt: Date.now(),
    revision: lobby.revision + 1,
  }
  await putLobby(kv, updated)
  return updated
}
