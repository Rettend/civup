import type { CompetitiveTier, GameMode, QueueEntry } from '@civup/game'
import type { Database } from '@civup/db'
import type { LobbyArrangeStrategy, LobbyDraftConfig, LobbyState, LobbyStatus } from './types.ts'
import type { SessionRecord } from '../../session-runtime/session-record.ts'
import { nanoid } from 'nanoid'
import { createSessionAggregateFromLobby, runSessionOpenLobbyCommand, runSessionProjectionCommand, type SessionOpenLobbyCommand } from '../../session-runtime/session-do-client.ts'
import { buildLobbyStateFromSessionRecord } from '../../session-runtime/session-record.ts'
import { closeLobbySessionProjection } from '../session/directory.ts'
import { kvMdelete } from '../kv/batch.ts'
import { channelIndexKey, modeIndexKey } from './keys.ts'
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

type LobbySessionCommand = SessionOpenLobbyCommand | (() => Promise<SessionRecord>)

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
  const queueEntries = input.queueEntries ?? []
  let visible = false
  let visibleLobby = lobby
  try {
    const record = await createSessionAggregateFromLobby(input.sessionNamespace, lobby, queueEntries)
    visibleLobby = buildLobbyStateFromSessionRecord(record, lobby)
    await putLobbyEntries(kv, visibleLobby)
    visible = true
  }
  catch (error) {
    if (!visible) await closeLobbySessionProjectionIfAvailable(input.db, lobby.id)
    throw error
  }
  return visibleLobby
}

export async function commitLobbyState(
  kv: KVNamespace,
  lobby: LobbyState,
  options?: LobbySessionProjectionOptions,
): Promise<LobbyState> {
  if (lobby.status === 'open') throw new Error(`Open lobby mutation for ${lobby.id} must use an explicit SessionDO command`)
  return await commitLobbyMutation(kv, lobby, options, putLobby)
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
  return await commitLobbyMutation(kv, updated, options, putLobby, lobby.status === 'open' && status === 'cancelled'
    ? {
        type: 'cancel-open-session',
        expectedVersion: lobby.revision,
        now: updated.updatedAt,
      }
    : undefined)
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
    await kvMdelete(kv, [channelIndexKey(lobby.channelId, lobby.id)])
  }
  return await commitLobbyMutation(kv, updated, options, putLobby, lobby.status === 'open'
    ? { type: 'set-message', expectedVersion: lobby.revision, channelId, messageId, now: updated.updatedAt }
    : undefined)
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
  return await commitLobbyMutation(kv, updated, options, putLobby, lobby.status === 'open'
    ? { type: 'set-draft-config', expectedVersion: lobby.revision, draftConfig: normalizedDraftConfig, now: updated.updatedAt }
    : undefined)
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
  return await commitLobbyMutation(kv, updated, options, putLobby, lobby.status === 'open'
    ? { type: 'set-min-role', expectedVersion: lobby.revision, minRole: normalizedMinRole, now: updated.updatedAt }
    : undefined)
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
  return await commitLobbyMutation(kv, updated, options, putLobby, lobby.status === 'open'
    ? { type: 'set-max-role', expectedVersion: lobby.revision, maxRole: normalizedMaxRole, now: updated.updatedAt }
    : undefined)
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
  return await commitLobbyMutation(kv, updated, options, putLobby, lobby.status === 'open'
    ? { type: 'set-steam-lobby-link', expectedVersion: lobby.revision, steamLobbyLink, now: updated.updatedAt }
    : () => runSessionProjectionCommand(options?.sessionNamespace, updated.id, { type: 'set-steam-lobby-link', expectedVersion: lobby.revision, steamLobbyLink, now: updated.updatedAt }))
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
  return await commitLobbyMutation(kv, updated, options, putLobby, lobby.status === 'open'
    ? { type: 'set-slots', expectedVersion: lobby.revision, slots: normalizedSlots, queueEntries: options?.queueEntries ? [...options.queueEntries] : undefined, now: updated.updatedAt }
    : undefined)
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
  return await commitLobbyMutation(kv, updated, options, putLobby, lobby.status === 'open'
    ? { type: 'arrange-roster', expectedVersion: lobby.revision, slots: normalizedSlots, strategy: input.strategy, at: now, queueEntries: options?.queueEntries ? [...options.queueEntries] : undefined }
    : undefined)
}

export async function setLobbyRoster(
  kv: KVNamespace,
  lobbyId: string,
  input: {
    memberPlayerIds: string[]
    slots: (string | null)[]
    lastActivityAt?: number
    now?: number
  },
  currentLobby?: LobbyState,
  options?: LobbySessionProjectionOptions,
): Promise<LobbyState | null> {
  const lobby = currentLobby?.id === lobbyId ? currentLobby : await getLobbyById(kv, lobbyId)
  if (!lobby) return null

  const normalizedMemberIds = normalizeMemberPlayerIds(input.memberPlayerIds)
  const normalizedSlots = normalizeStoredSlots(lobby.mode, input.slots)
  const lastActivityAt = input.lastActivityAt !== undefined ? normalizeTimestamp(input.lastActivityAt) : lobby.lastActivityAt
  if (sameStringArray(lobby.memberPlayerIds, normalizedMemberIds) && sameStringArray(lobby.slots.map(value => value ?? ''), normalizedSlots.map(value => value ?? '')) && lobby.lastActivityAt === lastActivityAt) return lobby

  const updatedAt = normalizeTimestamp(input.now ?? Date.now())
  const updated: LobbyState = {
    ...lobby,
    memberPlayerIds: normalizedMemberIds,
    slots: normalizedSlots,
    lastActivityAt,
    updatedAt,
    revision: lobby.revision + 1,
  }
  return await commitLobbyMutation(kv, updated, options, putLobbyEntries, lobby.status === 'open'
    ? {
        type: 'set-roster',
        expectedVersion: lobby.revision,
        memberPlayerIds: normalizedMemberIds,
        slots: normalizedSlots,
        lastActivityAt,
        now: updatedAt,
        queueEntries: options?.queueEntries ? [...options.queueEntries] : undefined,
      }
    : undefined)
}

export async function setLobbyModeAndLayout(
  kv: KVNamespace,
  lobbyId: string,
  input: {
    mode: GameMode
    draftConfig: LobbyDraftConfig
    slots: (string | null)[]
    minRole: CompetitiveTier | null
    maxRole: CompetitiveTier | null
    lastActivityAt?: number
    now?: number
  },
  currentLobby?: LobbyState,
  options?: LobbySessionProjectionOptions,
): Promise<LobbyState | null> {
  const lobby = currentLobby?.id === lobbyId ? currentLobby : await getLobbyById(kv, lobbyId)
  if (!lobby) return null

  const normalizedSlots = normalizeStoredSlots(input.mode, input.slots)
  const normalizedDraftConfig = normalizeDraftConfigForMode(input.mode, input.draftConfig, normalizedSlots.length)
  const normalizedMinRole = normalizeCompetitiveTier(input.minRole)
  const normalizedMaxRole = normalizeCompetitiveTier(input.maxRole)
  const lastActivityAt = input.lastActivityAt !== undefined ? normalizeTimestamp(input.lastActivityAt) : lobby.lastActivityAt
  const modeChanged = lobby.mode !== input.mode
  const slotsChanged = !sameStringArray(lobby.slots.map(value => value ?? ''), normalizedSlots.map(value => value ?? ''))
  const configChanged = !sameDraftConfig(lobby.draftConfig, normalizedDraftConfig)
  const roleChanged = lobby.minRole !== normalizedMinRole || lobby.maxRole !== normalizedMaxRole
  if (!modeChanged && !slotsChanged && !configChanged && !roleChanged && lobby.lastActivityAt === lastActivityAt) return lobby

  const updatedAt = normalizeTimestamp(input.now ?? Date.now())
  const updated: LobbyState = {
    ...lobby,
    mode: input.mode,
    draftConfig: normalizedDraftConfig,
    minRole: normalizedMinRole,
    maxRole: normalizedMaxRole,
    slots: normalizedSlots,
    lastActivityAt,
    updatedAt,
    revision: lobby.revision + 1,
  }
  const writeWithModeIndexCleanup: LobbyWriter = async (targetKv, authoritative) => {
    if (lobby.mode !== authoritative.mode) await kvMdelete(targetKv, [modeIndexKey(lobby.mode, lobby.id)])
    await putLobby(targetKv, authoritative)
  }
  return await commitLobbyMutation(kv, updated, options, writeWithModeIndexCleanup, lobby.status === 'open'
    ? {
        type: 'change-mode',
        expectedVersion: lobby.revision,
        mode: input.mode,
        draftConfig: normalizedDraftConfig,
        slots: normalizedSlots,
        minRole: normalizedMinRole,
        maxRole: normalizedMaxRole,
        lastActivityAt,
        now: updatedAt,
        queueEntries: options?.queueEntries ? [...options.queueEntries] : undefined,
      }
    : undefined)
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
  return await commitLobbyMutation(kv, updated, options, putLobbyEntries, lobby.status === 'open'
    ? { type: 'set-member-player-ids', expectedVersion: lobby.revision, memberPlayerIds: normalizedMemberIds, queueEntries: options?.queueEntries ? [...options.queueEntries] : undefined, now: updated.updatedAt }
    : undefined)
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
  return await commitLobbyMutation(kv, updated, options, putLobby, lobby.status === 'open'
    ? { type: 'set-last-activity-at', expectedVersion: lobby.revision, lastActivityAt: normalizedLastActivityAt, now: updated.updatedAt }
    : undefined)
}

type LobbyWriter = (kv: KVNamespace, lobby: LobbyState) => Promise<void>

async function commitLobbyMutation(
  kv: KVNamespace,
  updated: LobbyState,
  options?: LobbySessionProjectionOptions,
  write: LobbyWriter = putLobby,
  command?: LobbySessionCommand,
): Promise<LobbyState> {
  if (updated.status === 'open' && !command) throw new Error(`Open lobby mutation for ${updated.id} must go through SessionDO`)
  const commandRecord = typeof command === 'function'
    ? await command()
    : command
    ? await runSessionOpenLobbyCommand(options?.sessionNamespace, updated.id, command)
    : null
  if (commandRecord) {
    const authoritative = buildLobbyStateFromSessionRecord(commandRecord, updated)
    await write(kv, authoritative)
    return authoritative
  }

  await write(kv, updated)
  return updated
}

async function closeLobbySessionProjectionIfAvailable(db: Database | null | undefined, lobbyId: string): Promise<void> {
  if (!db) return
  await closeLobbySessionProjection(db, lobbyId)
}

function normalizeTimestamp(value: number): number {
  return Math.max(1, Math.round(value))
}
