import type { GameMode } from '@civup/game'

export type LobbyStatus = 'open' | 'drafting' | 'active' | 'completed'

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
  draftConfig: LobbyDraftConfig
  createdAt: number
  updatedAt: number
}

interface StoredLobbyState extends Omit<LobbyState, 'draftConfig'> {
  draftConfig?: Partial<LobbyDraftConfig> | null
}

const LOBBY_MODE_KEY_PREFIX = 'lobby:mode:'
const LOBBY_MATCH_KEY_PREFIX = 'lobby:match:'
const LOBBY_TTL = 24 * 60 * 60

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
  const lobby: LobbyState = {
    mode: input.mode,
    status: 'open',
    hostId: input.hostId,
    channelId: input.channelId,
    messageId: input.messageId,
    matchId: null,
    draftConfig: { ...DEFAULT_DRAFT_CONFIG },
    createdAt: now,
    updatedAt: now,
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
  const updated: LobbyState = {
    ...lobby,
    status: 'drafting',
    matchId,
    updatedAt: Date.now(),
  }
  await putLobby(kv, updated)
  await kv.put(matchKey(matchId), mode, { expirationTtl: LOBBY_TTL })
  return updated
}

export async function setLobbyStatus(
  kv: KVNamespace,
  mode: GameMode,
  status: LobbyStatus,
): Promise<LobbyState | null> {
  const lobby = await getLobby(kv, mode)
  if (!lobby) return null
  const updated: LobbyState = {
    ...lobby,
    status,
    updatedAt: Date.now(),
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
  const updated: LobbyState = {
    ...lobby,
    channelId,
    messageId,
    updatedAt: Date.now(),
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
  const updated: LobbyState = {
    ...lobby,
    draftConfig: normalizeDraftConfig(draftConfig),
    updatedAt: Date.now(),
  }
  await putLobby(kv, updated)
  return updated
}

export async function clearLobby(kv: KVNamespace, mode: GameMode): Promise<void> {
  const lobby = await getLobby(kv, mode)
  await kv.delete(modeKey(mode))
  if (lobby?.matchId) {
    await kv.delete(matchKey(lobby.matchId))
  }
}

export async function clearLobbyByMatch(kv: KVNamespace, matchId: string): Promise<void> {
  const mode = await kv.get(matchKey(matchId)) as GameMode | null
  await kv.delete(matchKey(matchId))
  if (!mode) return
  const lobby = await getLobby(kv, mode)
  if (!lobby || lobby.matchId !== matchId) return
  await kv.delete(modeKey(mode))
}

async function putLobby(kv: KVNamespace, lobby: LobbyState): Promise<void> {
  await kv.put(modeKey(lobby.mode), JSON.stringify(lobby), { expirationTtl: LOBBY_TTL })
  if (lobby.matchId) {
    await kv.put(matchKey(lobby.matchId), lobby.mode, { expirationTtl: LOBBY_TTL })
  }
}

function normalizeLobby(raw: StoredLobbyState): LobbyState {
  return {
    ...raw,
    draftConfig: normalizeDraftConfig(raw.draftConfig),
  }
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
