import type { GameMode, QueueEntry } from '@civup/game'
import { GAME_MODES, maxPlayerCount } from '@civup/game'
import { stateStoreMdelete, stateStoreMget, stateStoreMput } from './state-store.ts'

export type LobbyStatus = 'open' | 'drafting' | 'active' | 'completed' | 'cancelled' | 'scrubbed'

export interface LobbyDraftConfig {
  banTimerSeconds: number | null
  pickTimerSeconds: number | null
}

export interface LobbyState {
  mode: GameMode
  status: LobbyStatus
  hostId: string
  channelId: string
  messageId: string
  matchId: string | null
  /** Slot player IDs for open lobby ordering (null = empty slot) */
  slots: (string | null)[]
  draftConfig: LobbyDraftConfig
  createdAt: number
  updatedAt: number
  revision: number
}

interface StoredLobbyState extends Omit<LobbyState, 'draftConfig' | 'slots' | 'revision'> {
  draftConfig?: Partial<LobbyDraftConfig> | null
  slots?: unknown
  revision?: unknown
}

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

function modeKey(mode: GameMode): string {
  return `${LOBBY_MODE_KEY_PREFIX}${mode}`
}

function matchKey(matchId: string): string {
  return `${LOBBY_MATCH_KEY_PREFIX}${matchId}`
}

export function canTransitionLobbyStatus(from: LobbyStatus, to: LobbyStatus): boolean {
  if (from === to) return true
  return LOBBY_STATUS_TRANSITIONS[from].includes(to)
}

export async function getLobbyByChannel(kv: KVNamespace, channelId: string): Promise<LobbyState | null> {
  const lobbies = await stateStoreMget(
    kv,
    GAME_MODES.map(mode => ({ key: modeKey(mode), type: 'json' })),
  )

  for (let index = 0; index < GAME_MODES.length; index++) {
    const mode = GAME_MODES[index]
    if (!mode) continue

    const raw = lobbies[index] as StoredLobbyState | null | undefined
    const lobby = raw ? normalizeLobby(raw) : null
    if (!lobby || lobby.channelId !== channelId) continue
    return lobby
  }

  return null
}

export async function createLobby(
  kv: KVNamespace,
  input: {
    mode: GameMode
    hostId: string
    channelId: string
    messageId: string
  },
): Promise<LobbyState> {
  const now = Date.now()
  const slots = createEmptySlots(input.mode)
  slots[0] = input.hostId

  const lobby: LobbyState = {
    mode: input.mode,
    status: 'open',
    hostId: input.hostId,
    channelId: input.channelId,
    messageId: input.messageId,
    matchId: null,
    slots,
    draftConfig: { ...DEFAULT_DRAFT_CONFIG },
    createdAt: now,
    updatedAt: now,
    revision: 1,
  }
  await putLobby(kv, lobby)
  return lobby
}

export async function getLobby(kv: KVNamespace, mode: GameMode): Promise<LobbyState | null> {
  const raw = await kv.get(modeKey(mode), 'json') as StoredLobbyState | null
  if (!raw) return null
  return normalizeLobby(raw)
}

export async function getLobbyByMatch(kv: KVNamespace, matchId: string): Promise<LobbyState | null> {
  const mode = await kv.get(matchKey(matchId)) as GameMode | null
  if (!mode) return null
  const lobby = await getLobby(kv, mode)
  if (!lobby || lobby.matchId !== matchId) return null
  return lobby
}

export async function attachLobbyMatch(
  kv: KVNamespace,
  mode: GameMode,
  matchId: string,
): Promise<LobbyState | null> {
  const lobby = await getLobby(kv, mode)
  if (!lobby) return null

  if (lobby.status === 'drafting' && lobby.matchId === matchId) return lobby
  if (!canTransitionLobbyStatus(lobby.status, 'drafting')) {
    console.warn('[lobby-transition] attachLobbyMatch rejected', {
      mode,
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
  mode: GameMode,
  status: LobbyStatus,
  currentLobby?: LobbyState,
): Promise<LobbyState | null> {
  const lobby = currentLobby?.mode === mode ? currentLobby : await getLobby(kv, mode)
  if (!lobby) return null

  if (lobby.status === status) return lobby
  if (!canTransitionLobbyStatus(lobby.status, status)) {
    console.warn('[lobby-transition] setLobbyStatus rejected', {
      mode,
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
  mode: GameMode,
  channelId: string,
  messageId: string,
): Promise<LobbyState | null> {
  const lobby = await getLobby(kv, mode)
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
  mode: GameMode,
  draftConfig: LobbyDraftConfig,
): Promise<LobbyState | null> {
  const lobby = await getLobby(kv, mode)
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

export async function setLobbySlots(
  kv: KVNamespace,
  mode: GameMode,
  slots: (string | null)[],
  currentLobby?: LobbyState,
): Promise<LobbyState | null> {
  const lobby = currentLobby?.mode === mode ? currentLobby : await getLobby(kv, mode)
  if (!lobby) return null
  const normalizedSlots = normalizeStoredSlots(mode, slots)
  if (sameLobbySlots(lobby.slots, normalizedSlots)) {
    return lobby
  }

  const updated: LobbyState = {
    ...lobby,
    slots: normalizedSlots,
    updatedAt: Date.now(),
    revision: lobby.revision + 1,
  }
  await putLobby(kv, updated)
  return updated
}

export async function upsertLobby(kv: KVNamespace, lobby: LobbyState): Promise<void> {
  const normalizedLobby = {
    ...lobby,
    slots: normalizeStoredSlots(lobby.mode, lobby.slots),
    draftConfig: normalizeDraftConfig(lobby.draftConfig),
    revision: normalizeLobbyRevision(lobby.revision),
  }
  await putLobby(kv, normalizedLobby)
}

export async function clearLobby(kv: KVNamespace, mode: GameMode): Promise<void> {
  const lobby = await getLobby(kv, mode)
  const keys = [modeKey(mode)]
  if (lobby?.matchId) keys.push(matchKey(lobby.matchId))
  await stateStoreMdelete(kv, keys)
}

export async function clearLobbyByMatch(kv: KVNamespace, matchId: string): Promise<void> {
  const mode = await kv.get(matchKey(matchId)) as GameMode | null
  await stateStoreMdelete(kv, [matchKey(matchId)])
  if (!mode) return
  const lobby = await getLobby(kv, mode)
  if (!lobby || lobby.matchId !== matchId) return
  await stateStoreMdelete(kv, [modeKey(mode)])
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

function createEmptySlots(mode: GameMode): (string | null)[] {
  return Array.from({ length: maxPlayerCount(mode) }, () => null)
}

async function putLobby(kv: KVNamespace, lobby: LobbyState): Promise<void> {
  const entries = [
    {
      key: modeKey(lobby.mode),
      value: JSON.stringify(lobby),
      expirationTtl: LOBBY_TTL,
    },
  ]
  if (lobby.matchId) {
    entries.push({
      key: matchKey(lobby.matchId),
      value: lobby.mode,
      expirationTtl: LOBBY_TTL,
    })
  }
  await stateStoreMput(kv, entries)
}

function normalizeLobby(raw: StoredLobbyState): LobbyState {
  return {
    ...raw,
    slots: normalizeStoredSlots(raw.mode, raw.slots),
    draftConfig: normalizeDraftConfig(raw.draftConfig),
    revision: normalizeLobbyRevision(raw.revision),
  }
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

function normalizeTimerSeconds(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.round(value)
  return rounded >= 0 ? rounded : null
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
