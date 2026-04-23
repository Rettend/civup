import type { CompetitiveTier, GameMode, QueueEntry } from '@civup/game'
import type { Database } from '@civup/db'
import type { LobbyArrangeStrategy, LobbyDraftConfig, LobbyState, LobbyStatus } from './types.ts'
import { nanoid } from 'nanoid'
import { createSessionAggregateFromLobby, syncSessionAggregateFromLobby } from '../../session-runtime/session-do-client.ts'
import { buildLobbyStateFromSessionRecord } from '../../session-runtime/session-record.ts'
import { syncActivityOverviewSnapshotForLobby } from '../activity/live-state.ts'
import { getQueueState } from '../queue/index.ts'
import { closeLobbySessionProjection, projectLobbySession } from '../session/directory.ts'
import { stateStoreMdelete } from '../state/store.ts'
import { channelIndexKey, LOBBY_TTL } from './keys.ts'
import { buildLobbyLiveSnapshotFromParts, lobbySnapshotKey } from './live-snapshot.ts'
import { createEmptySlots, DEFAULT_DRAFT_CONFIG, normalizeCompetitiveTier, normalizeDraftConfigForMode, normalizeMemberPlayerIds, normalizeStoredSlots, sameDraftConfig, sameStringArray } from './normalize.ts'
import { getLobbyById, putLobby, putLobbyEntries } from './store.ts'

const LOBBY_STATUS_TRANSITIONS: Record<LobbyStatus, LobbyStatus[]> = {
  open: ['drafting', 'cancelled'],
  drafting: ['active', 'completed', 'cancelled', 'scrubbed'],
  active: ['completed', 'cancelled', 'scrubbed'],
  completed: [],
  cancelled: [],
  scrubbed: [],
}

export interface LobbySessionProjectionOptions {
  db?: Database | null
  sessionNamespace?: DurableObjectNamespace | null
  queueEntries?: readonly QueueEntry[] | null
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
    queueEntries?: QueueEntry[]
    db?: Database | null
    sessionNamespace?: DurableObjectNamespace | null
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
    maxRole: null,
    lastArrange: null,
    lastActivityAt: now,
    memberPlayerIds: [input.hostId],
    slots,
    draftConfig: { ...DEFAULT_DRAFT_CONFIG },
    createdAt: now,
    updatedAt: now,
    revision: 1,
  }
  const queueEntries = input.queueEntries ?? (await getQueueState(kv, lobby.mode)).entries
  await projectLobbySessionIfAvailable(input.db, lobby)

  let visible = false
  let visibleLobby = lobby
  try {
    const record = await createSessionAggregateFromLobby(input.sessionNamespace, lobby, queueEntries)
    if (record) {
      visibleLobby = buildLobbyStateFromSessionRecord(record, lobby)
      await projectLobbySessionIfAvailable(input.db, visibleLobby)
    }

    const snapshot = await buildLobbyLiveSnapshotFromParts(kv, visibleLobby.mode, visibleLobby, queueEntries, visibleLobby.slots)
    await putLobbyEntries(kv, visibleLobby, [{
      key: lobbySnapshotKey(visibleLobby.id),
      value: JSON.stringify(snapshot),
      expirationTtl: LOBBY_TTL,
    }])
    visible = true
  }
  catch (error) {
    if (!visible) await closeLobbySessionProjectionIfAvailable(input.db, lobby.id)
    throw error
  }

  await syncActivityOverviewSnapshotForLobby(kv, visibleLobby)
  return visibleLobby
}

export async function commitLobbyState(
  kv: KVNamespace,
  lobby: LobbyState,
  options?: LobbySessionProjectionOptions,
): Promise<LobbyState> {
  return await commitLobbyMutation(kv, lobby, options)
}

export async function attachLobbyMatch(
  kv: KVNamespace,
  lobbyId: string,
  matchId: string,
  currentLobby?: LobbyState,
  options?: LobbySessionProjectionOptions,
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
  return await commitLobbyMutation(kv, updated, options)
}

export async function setLobbyStatus(
  kv: KVNamespace,
  lobbyId: string,
  status: LobbyStatus,
  currentLobby?: LobbyState,
  options?: LobbySessionProjectionOptions,
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
  return await commitLobbyMutation(kv, updated, options)
}

export async function setLobbyMessage(
  kv: KVNamespace,
  lobbyId: string,
  channelId: string,
  messageId: string,
  options?: LobbySessionProjectionOptions,
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
  return await commitLobbyMutation(kv, updated, options)
}

export async function setLobbyDraftConfig(
  kv: KVNamespace,
  lobbyId: string,
  draftConfig: LobbyDraftConfig,
  currentLobby?: LobbyState,
  options?: LobbySessionProjectionOptions,
): Promise<LobbyState | null> {
  const lobby = currentLobby?.id === lobbyId ? currentLobby : await getLobbyById(kv, lobbyId)
  if (!lobby) return null

  const normalizedDraftConfig = normalizeDraftConfigForMode(lobby.mode, draftConfig, lobby.slots.length)
  if (sameDraftConfig(lobby.draftConfig, normalizedDraftConfig)) return lobby

  const updated: LobbyState = {
    ...lobby,
    draftConfig: normalizedDraftConfig,
    updatedAt: Date.now(),
    revision: lobby.revision + 1,
  }
  return await commitLobbyMutation(kv, updated, options)
}

export async function setLobbyMinRole(
  kv: KVNamespace,
  lobbyId: string,
  minRole: CompetitiveTier | null,
  currentLobby?: LobbyState,
  options?: LobbySessionProjectionOptions,
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
  return await commitLobbyMutation(kv, updated, options)
}

export async function setLobbyMaxRole(
  kv: KVNamespace,
  lobbyId: string,
  maxRole: CompetitiveTier | null,
  currentLobby?: LobbyState,
  options?: LobbySessionProjectionOptions,
): Promise<LobbyState | null> {
  const lobby = currentLobby?.id === lobbyId ? currentLobby : await getLobbyById(kv, lobbyId)
  if (!lobby) return null

  const normalizedMaxRole = normalizeCompetitiveTier(maxRole)
  if (lobby.maxRole === normalizedMaxRole) return lobby

  const updated: LobbyState = {
    ...lobby,
    maxRole: normalizedMaxRole,
    updatedAt: Date.now(),
    revision: lobby.revision + 1,
  }
  return await commitLobbyMutation(kv, updated, options)
}

export async function setLobbySteamLobbyLink(
  kv: KVNamespace,
  lobbyId: string,
  steamLobbyLink: string | null,
  currentLobby?: LobbyState,
  options?: LobbySessionProjectionOptions,
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
  return await commitLobbyMutation(kv, updated, options)
}

export async function setLobbySlots(
  kv: KVNamespace,
  lobbyId: string,
  slots: (string | null)[],
  currentLobby?: LobbyState,
  options?: LobbySessionProjectionOptions,
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
  return await commitLobbyMutation(kv, updated, options)
}

export async function setLobbyArranged(
  kv: KVNamespace,
  lobbyId: string,
  input: {
    slots: (string | null)[]
    strategy: LobbyArrangeStrategy
    at?: number
  },
  currentLobby?: LobbyState,
  options?: LobbySessionProjectionOptions,
): Promise<LobbyState | null> {
  const lobby = currentLobby?.id === lobbyId ? currentLobby : await getLobbyById(kv, lobbyId)
  if (!lobby) return null

  const now = input.at == null ? Date.now() : Math.max(1, Math.round(input.at))
  const normalizedSlots = normalizeStoredSlots(lobby.mode, input.slots)
  const updated: LobbyState = {
    ...lobby,
    slots: normalizedSlots,
    lastArrange: { strategy: input.strategy, at: now },
    lastActivityAt: now,
    updatedAt: now,
    revision: lobby.revision + 1,
  }
  return await commitLobbyMutation(kv, updated, options)
}

export async function setLobbyMemberPlayerIds(
  kv: KVNamespace,
  lobbyId: string,
  memberPlayerIds: string[],
  currentLobby?: LobbyState,
  options?: LobbySessionProjectionOptions,
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
  return await commitLobbyMutation(kv, updated, options, putLobbyEntries)
}

export async function setLobbyLastActivityAt(
  kv: KVNamespace,
  lobbyId: string,
  lastActivityAt: number,
  currentLobby?: LobbyState,
  options?: LobbySessionProjectionOptions,
): Promise<LobbyState | null> {
  const lobby = currentLobby?.id === lobbyId ? currentLobby : await getLobbyById(kv, lobbyId)
  if (!lobby) return null

  const normalizedLastActivityAt = Math.max(1, Math.round(lastActivityAt))
  if (lobby.lastActivityAt === normalizedLastActivityAt) return lobby

  const updated: LobbyState = {
    ...lobby,
    lastActivityAt: normalizedLastActivityAt,
    updatedAt: Date.now(),
    revision: lobby.revision + 1,
  }
  return await commitLobbyMutation(kv, updated, options)
}

async function projectLobbySessionIfAvailable(db: Database | null | undefined, lobby: LobbyState): Promise<void> {
  if (!db) return
  await projectLobbySession(db, lobby)
}

type LobbyWriter = (kv: KVNamespace, lobby: LobbyState) => Promise<void>

async function commitLobbyMutation(
  kv: KVNamespace,
  updated: LobbyState,
  options?: LobbySessionProjectionOptions,
  write: LobbyWriter = putLobby,
): Promise<LobbyState> {
  await projectLobbySessionIfAvailable(options?.db, updated)
  const record = await syncSessionAggregateFromLobby(options?.sessionNamespace, updated, options?.queueEntries ?? [])
  const authoritative = record ? buildLobbyStateFromSessionRecord(record, updated) : updated
  if (record) await projectLobbySessionIfAvailable(options?.db, authoritative)
  await write(kv, authoritative)
  return authoritative
}

async function closeLobbySessionProjectionIfAvailable(db: Database | null | undefined, lobbyId: string): Promise<void> {
  if (!db) return
  await closeLobbySessionProjection(db, lobbyId)
}
