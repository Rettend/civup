import type { CompetitiveTier, GameMode, QueueEntry } from '@civup/game'
import { COMPETITIVE_TIERS, GAME_MODES, maxPlayerCount } from '@civup/game'
import { nanoid } from 'nanoid'
import { stateStoreMdelete, stateStoreMget, stateStoreMput } from './state-store.ts'

export type LobbyStatus = 'open' | 'drafting' | 'active' | 'completed' | 'cancelled' | 'scrubbed'

export interface LobbyDraftConfig {
  banTimerSeconds: number | null
  pickTimerSeconds: number | null
}

export interface LobbyState {
  id: string
  mode: GameMode
  status: LobbyStatus
  guildId: string | null
  hostId: string
  channelId: string
  messageId: string
  matchId: string | null
  minRole: CompetitiveTier | null
  /** Player IDs currently attached to this lobby (slotted or spectator). */
  memberPlayerIds: string[]
  /** Slot player IDs for open lobby ordering (null = empty slot) */
  slots: (string | null)[]
  draftConfig: LobbyDraftConfig
  createdAt: number
  updatedAt: number
  revision: number
}

interface StoredLobbyState extends Omit<LobbyState, 'draftConfig' | 'slots' | 'revision' | 'memberPlayerIds'> {
  draftConfig?: Partial<LobbyDraftConfig> | null
  slots?: unknown
  revision?: unknown
  memberPlayerIds?: unknown
}

const LOBBY_ID_KEY_PREFIX = 'lobby:id:'
const LOBBY_MODE_KEY_PREFIX = 'lobby:mode:'
const LOBBY_MATCH_KEY_PREFIX = 'lobby:match:'
const LOBBY_TTL = 24 * 60 * 60

const LOBBY_STATUS_TRANSITIONS: Record<LobbyStatus, LobbyStatus[]> = {
  open: ['drafting', 'cancelled'],
  drafting: ['active', 'completed', 'cancelled', 'scrubbed'],
  active: ['completed', 'cancelled', 'scrubbed'],
  completed: [],
  cancelled: [],
  scrubbed: [],
}

const DEFAULT_DRAFT_CONFIG: LobbyDraftConfig = {
  banTimerSeconds: null,
  pickTimerSeconds: null,
}

function idKey(lobbyId: string): string {
  return `${LOBBY_ID_KEY_PREFIX}${lobbyId}`
}

function modeIndexKey(mode: GameMode, lobbyId: string): string {
  return `${LOBBY_MODE_KEY_PREFIX}${mode}:${lobbyId}`
}

function modePrefix(mode: GameMode): string {
  return `${LOBBY_MODE_KEY_PREFIX}${mode}:`
}

function matchKey(matchId: string): string {
  return `${LOBBY_MATCH_KEY_PREFIX}${matchId}`
}

export function canTransitionLobbyStatus(from: LobbyStatus, to: LobbyStatus): boolean {
  if (from === to) return true
  return LOBBY_STATUS_TRANSITIONS[from].includes(to)
}

export async function getLobbiesByMode(kv: KVNamespace, mode: GameMode): Promise<LobbyState[]> {
  const listed = await kv.list({ prefix: modePrefix(mode) })
  const lobbyIds = listed.keys
    .map(entry => entry.name.slice(modePrefix(mode).length))
    .filter((lobbyId): lobbyId is string => lobbyId.length > 0)

  if (lobbyIds.length === 0) return []

  const rawLobbies = await stateStoreMget(
    kv,
    lobbyIds.map(lobbyId => ({ key: idKey(lobbyId), type: 'json' })),
  )

  return rawLobbies
    .map(raw => parseLobbyState(raw))
    .filter((lobby): lobby is LobbyState => lobby != null)
    .filter(lobby => lobby.mode === mode)
    .sort((left, right) => left.createdAt - right.createdAt)
}

/** Temporary convenience lookup for the most recently updated lobby in a mode. */
export async function getLobby(kv: KVNamespace, mode: GameMode): Promise<LobbyState | null> {
  const lobbies = await getLobbiesByMode(kv, mode)
  return [...lobbies].sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null
}

export async function getLobbyById(kv: KVNamespace, lobbyId: string): Promise<LobbyState | null> {
  const raw = await kv.get(idKey(lobbyId), 'json') as StoredLobbyState | null
  return parseLobbyState(raw)
}

export async function getLobbyByChannel(kv: KVNamespace, channelId: string): Promise<LobbyState | null> {
  const lobbies = await getAllLobbies(kv)
  const openLobbies = lobbies
    .filter(lobby => lobby.channelId === channelId && lobby.status === 'open')
    .sort((left, right) => right.updatedAt - left.updatedAt)

  return openLobbies[0] ?? null
}

export async function getOpenLobbyForPlayer(
  kv: KVNamespace,
  playerId: string,
  mode?: GameMode,
): Promise<LobbyState | null> {
  const lobbies = mode ? await getLobbiesByMode(kv, mode) : await getAllLobbies(kv)
  return lobbies.find(lobby => lobby.status === 'open' && lobby.memberPlayerIds.includes(playerId)) ?? null
}

export async function getLobbyByMatch(kv: KVNamespace, matchId: string): Promise<LobbyState | null> {
  const lobbyId = await kv.get(matchKey(matchId))
  if (!lobbyId) return null
  const lobby = await getLobbyById(kv, lobbyId)
  if (!lobby || lobby.matchId !== matchId) return null
  return lobby
}

export async function createLobby(
  kv: KVNamespace,
  input: {
    mode: GameMode
    guildId?: string | null
    hostId: string
    channelId: string
    messageId: string
  },
): Promise<LobbyState> {
  const now = Date.now()
  const slots = createEmptySlots(input.mode)
  slots[0] = input.hostId

  const lobby: LobbyState = {
    id: nanoid(10),
    mode: input.mode,
    status: 'open',
    guildId: normalizeGuildId(input.guildId),
    hostId: input.hostId,
    channelId: input.channelId,
    messageId: input.messageId,
    matchId: null,
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

export async function setLobbySlots(
  kv: KVNamespace,
  lobbyId: string,
  slots: (string | null)[],
  currentLobby?: LobbyState,
): Promise<LobbyState | null> {
  const lobby = currentLobby?.id === lobbyId ? currentLobby : await getLobbyById(kv, lobbyId)
  if (!lobby) return null

  const normalizedSlots = normalizeStoredSlots(lobby.mode, slots)
  if (sameLobbySlots(lobby.slots, normalizedSlots)) return lobby

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

export async function upsertLobby(kv: KVNamespace, lobby: LobbyState): Promise<void> {
  const normalizedLobby = normalizeLobby(lobby)
  await putLobby(kv, normalizedLobby)
}

export async function clearLobbyById(kv: KVNamespace, lobbyId: string): Promise<void> {
  const lobby = await getLobbyById(kv, lobbyId)
  const keys = [idKey(lobbyId)]
  if (lobby) {
    keys.push(modeIndexKey(lobby.mode, lobby.id))
    if (lobby.matchId) keys.push(matchKey(lobby.matchId))
  }
  await stateStoreMdelete(kv, keys)
}

export async function clearLobbiesByMode(kv: KVNamespace, mode: GameMode): Promise<void> {
  const lobbies = await getLobbiesByMode(kv, mode)
  if (lobbies.length === 0) return
  await stateStoreMdelete(kv, lobbies.flatMap((lobby) => {
    const keys = [idKey(lobby.id), modeIndexKey(mode, lobby.id)]
    if (lobby.matchId) keys.push(matchKey(lobby.matchId))
    return keys
  }))
}

export async function clearLobbyByMatch(kv: KVNamespace, matchId: string): Promise<void> {
  const lobbyId = await kv.get(matchKey(matchId))
  if (!lobbyId) {
    await stateStoreMdelete(kv, [matchKey(matchId)])
    return
  }
  await clearLobbyById(kv, lobbyId)
}

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

export function parseLobbyState(raw: unknown): LobbyState | null {
  if (!raw || typeof raw !== 'object') return null
  return normalizeLobby(raw as StoredLobbyState)
}

export function filterQueueEntriesForLobby(lobby: LobbyState, queueEntries: QueueEntry[]): QueueEntry[] {
  const memberSet = new Set(lobby.memberPlayerIds)
  return queueEntries.filter(entry => memberSet.has(entry.playerId))
}

async function getAllLobbies(kv: KVNamespace): Promise<LobbyState[]> {
  const all = await Promise.all(GAME_MODES.map(mode => getLobbiesByMode(kv, mode)))
  return all.flat().sort((left, right) => left.createdAt - right.createdAt)
}

function createEmptySlots(mode: GameMode): (string | null)[] {
  return Array.from({ length: maxPlayerCount(mode) }, () => null)
}

async function putLobby(kv: KVNamespace, lobby: LobbyState): Promise<void> {
  const entries = [
    {
      key: idKey(lobby.id),
      value: JSON.stringify(lobby),
      expirationTtl: LOBBY_TTL,
    },
    {
      key: modeIndexKey(lobby.mode, lobby.id),
      value: lobby.id,
      expirationTtl: LOBBY_TTL,
    },
  ]
  if (lobby.matchId) {
    entries.push({
      key: matchKey(lobby.matchId),
      value: lobby.id,
      expirationTtl: LOBBY_TTL,
    })
  }
  await stateStoreMput(kv, entries)
}

function normalizeLobby(raw: StoredLobbyState | LobbyState): LobbyState {
  return {
    ...raw,
    id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : nanoid(10),
    guildId: normalizeGuildId(raw.guildId),
    slots: normalizeStoredSlots(raw.mode, raw.slots),
    draftConfig: normalizeDraftConfig(raw.draftConfig),
    minRole: normalizeCompetitiveTier(raw.minRole),
    memberPlayerIds: normalizeMemberPlayerIds(raw.memberPlayerIds),
    revision: normalizeLobbyRevision(raw.revision),
  }
}

function normalizeGuildId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function normalizeStoredSlots(mode: GameMode, value: unknown): (string | null)[] {
  const targetSize = maxPlayerCount(mode)
  const normalized = Array.from({ length: targetSize }, () => null as string | null)

  if (!Array.isArray(value)) return normalized

  const seen = new Set<string>()
  for (let i = 0; i < targetSize; i++) {
    const raw = value[i]
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (!trimmed || seen.has(trimmed)) continue
    normalized[i] = trimmed
    seen.add(trimmed)
  }

  return normalized
}

function normalizeDraftConfig(config: Partial<LobbyDraftConfig> | LobbyDraftConfig | null | undefined): LobbyDraftConfig {
  return {
    banTimerSeconds: normalizeTimerSeconds(config?.banTimerSeconds),
    pickTimerSeconds: normalizeTimerSeconds(config?.pickTimerSeconds),
  }
}

function normalizeMemberPlayerIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const normalized: string[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue
    const trimmed = candidate.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    normalized.push(trimmed)
  }
  return normalized
}

function normalizeTimerSeconds(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.round(value)
  return rounded >= 0 ? rounded : null
}

function normalizeCompetitiveTier(value: unknown): CompetitiveTier | null {
  if (typeof value !== 'string') return null
  return COMPETITIVE_TIERS.includes(value as CompetitiveTier) ? value as CompetitiveTier : null
}

function normalizeLobbyRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  const rounded = Math.round(value)
  return rounded > 0 ? rounded : 1
}

function sameDraftConfig(a: LobbyDraftConfig, b: LobbyDraftConfig): boolean {
  return a.banTimerSeconds === b.banTimerSeconds
    && a.pickTimerSeconds === b.pickTimerSeconds
}

function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return false
  }
  return true
}
