import type { ClientMessage, ServerMessage } from '@civup/game'
import PartySocket from 'partysocket'
import { createSignal } from 'solid-js'
import { api, ApiError } from '~/client/lib/api'
import { relayDevLog } from '../lib/dev-log'
import { initDraft, updateDraft } from './draft-store'

// ── Types ──────────────────────────────────────────────────

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface MatchStateSnapshot {
  match: {
    id: string
    gameMode: string
    status: string
    createdAt: number
    completedAt: number | null
  }
  participants: {
    matchId: string
    playerId: string
    team: number | null
    civId: string | null
    placement: number | null
  }[]
}

export interface LobbySnapshot {
  mode: string
  hostId: string
  status: string
  entries: ({
    playerId: string
    displayName: string
    avatarUrl?: string | null
  } | null)[]
  minPlayers: number
  targetSize: number
  draftConfig: {
    banTimerSeconds: number | null
    pickTimerSeconds: number | null
  }
  serverDefaults: {
    banTimerSeconds: number | null
    pickTimerSeconds: number | null
  }
}

// ── State ──────────────────────────────────────────────────

export const [connectionStatus, setConnectionStatus] = createSignal<ConnectionStatus>('disconnected')
export const [connectionError, setConnectionError] = createSignal<string | null>(null)

// ── Socket ─────────────────────────────────────────────────

let socket: PartySocket | null = null
let pendingConfigAck:
  | {
    resolve: () => void
    reject: (error: Error) => void
    timeout: ReturnType<typeof setTimeout>
  }
  | null = null

/** Connect to PartyKit draft room using host and match ID */
export function connectToRoom(host: string, roomId: string, playerId: string) {
  if (socket) {
    socket.close()
  }

  setConnectionStatus('connecting')
  setConnectionError(null)

  socket = new PartySocket({
    host,
    party: 'main',
    prefix: 'api/parties',
    room: roomId,
    id: playerId,
    query: { playerId },
    maxRetries: 2,
  })

  socket.addEventListener('open', () => {
    setConnectionStatus('connected')
    setConnectionError(null)
  })

  socket.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data as string) as ServerMessage
      handleServerMessage(msg)
    }
    catch (err) {
      relayDevLog('error', 'Failed to parse server message', err)
      console.error('Failed to parse server message:', err)
    }
  })

  socket.addEventListener('close', (event) => {
    const code = typeof event.code === 'number' ? event.code : -1
    const reason = typeof event.reason === 'string' && event.reason.length > 0
      ? event.reason
      : typeof event.type === 'string'
        ? event.type
        : '-'
    if (code !== 1000) {
      relayDevLog('warn', 'Draft socket closed unexpectedly', { code, reason, roomId })
      setConnectionStatus('error')
      setConnectionError(`WebSocket closed (${code}${reason ? `: ${reason}` : ''})`)
      return
    }

    setConnectionStatus('disconnected')
  })

  socket.addEventListener('error', () => {
    relayDevLog('error', 'Draft socket connection failed', { roomId, playerId })
    setConnectionStatus('error')
    setConnectionError('WebSocket connection failed')
  })
}

export function disconnect() {
  socket?.close()
  socket = null
  if (pendingConfigAck) {
    clearTimeout(pendingConfigAck.timeout)
    pendingConfigAck.reject(new Error('Disconnected before config update was acknowledged.'))
    pendingConfigAck = null
  }
  setConnectionStatus('disconnected')
}

// ── Send Messages ──────────────────────────────────────────

export function sendMessage(msg: ClientMessage): boolean {
  if (!socket || connectionStatus() !== 'connected') {
    console.warn('Cannot send message: not connected')
    return false
  }
  socket.send(JSON.stringify(msg))
  return true
}

export function sendStart() {
  return sendMessage({ type: 'start' })
}

export function sendBan(civIds: string[]) {
  sendMessage({ type: 'ban', civIds })
}

export function sendPick(civId: string) {
  sendMessage({ type: 'pick', civId })
}

export function sendCancel(reason: 'cancel' | 'scrub') {
  sendMessage({ type: 'cancel', reason })
}

export function sendScrub() {
  sendCancel('scrub')
}

export function sendConfig(banTimerSeconds: number | null, pickTimerSeconds: number | null): Promise<void> {
  if (pendingConfigAck) {
    clearTimeout(pendingConfigAck.timeout)
    pendingConfigAck.reject(new Error('Previous config update still pending.'))
    pendingConfigAck = null
  }

  return new Promise<void>((resolve, reject) => {
    const sent = sendMessage({ type: 'config', banTimerSeconds, pickTimerSeconds })
    if (!sent) {
      reject(new Error('Not connected to draft room.'))
      return
    }

    const timeout = setTimeout(() => {
      if (!pendingConfigAck || pendingConfigAck.timeout !== timeout) return
      pendingConfigAck = null
      reject(new Error('Config update was not acknowledged by the server.'))
    }, 4000)

    pendingConfigAck = {
      resolve,
      reject,
      timeout,
    }
  })
}

// ── Bot API ────────────────────────────────────────────────

/** Fetch match ID for a channel from the bot API */
export async function fetchMatchForChannel(
  channelId: string,
): Promise<string | null> {
  try {
    const data = await api.get<{ matchId?: string }>(`/api/match/${channelId}`)
    return data.matchId ?? null
  }
  catch (err) {
    console.error('Failed to fetch match for channel:', err)
    if (err instanceof ApiError && err.status === 404) return null // TODO: remove?
    return null
  }
}

/** Fetch open lobby state for a channel from the bot API */
export async function fetchLobbyForChannel(
  channelId: string,
): Promise<LobbySnapshot | null> {
  try {
    return await api.get<LobbySnapshot>(`/api/lobby/${channelId}`)
  }
  catch (err) {
    console.error('Failed to fetch lobby for channel:', err)
    return null
  }
}

/** Fetch open lobby state for a user from the bot API */
export async function fetchLobbyForUser(
  userId: string,
): Promise<LobbySnapshot | null> {
  try {
    return await api.get<LobbySnapshot>(`/api/lobby/user/${userId}`)
  }
  catch (err) {
    console.error('Failed to fetch lobby for user:', err)
    return null
  }
}

/** Update host draft timer config for an open lobby */
export async function updateLobbyDraftConfig(
  mode: string,
  userId: string,
  draftConfig: {
    banTimerSeconds: number | null
    pickTimerSeconds: number | null
  },
): Promise<{ ok: true, lobby: LobbySnapshot } | { ok: false, error: string }> {
  try {
    const lobby = await api.post<LobbySnapshot>(`/api/lobby/${mode}/config`, {
      userId,
      banTimerSeconds: draftConfig.banTimerSeconds,
      pickTimerSeconds: draftConfig.pickTimerSeconds,
    })
    return { ok: true, lobby }
  }
  catch (err) {
    console.error('Failed to update lobby config:', err)
    if (err instanceof ApiError) return { ok: false, error: err.message }
    return { ok: false, error: 'Network error while updating lobby config' }
  }
}

/** Update open lobby game mode (host-only). */
export async function updateLobbyMode(
  mode: string,
  userId: string,
  nextMode: string,
): Promise<{ ok: true, lobby: LobbySnapshot } | { ok: false, error: string }> {
  try {
    const lobby = await api.post<LobbySnapshot>(`/api/lobby/${mode}/mode`, { userId, nextMode })
    return { ok: true, lobby }
  }
  catch (err) {
    console.error('Failed to update lobby mode:', err)
    if (err instanceof ApiError) return { ok: false, error: err.message }
    return { ok: false, error: 'Network error while updating lobby mode' }
  }
}

/** Place a player into a target lobby slot (join/move/swap). */
export async function placeLobbySlot(
  mode: string,
  payload: {
    userId: string
    targetSlot: number
    playerId?: string
    displayName?: string
    avatarUrl?: string | null
  },
): Promise<{ ok: true, lobby: LobbySnapshot } | { ok: false, error: string }> {
  try {
    const lobby = await api.post<LobbySnapshot>(`/api/lobby/${mode}/place`, payload)
    return { ok: true, lobby }
  }
  catch (err) {
    console.error('Failed to place lobby slot:', err)
    if (err instanceof ApiError) return { ok: false, error: err.message }
    return { ok: false, error: 'Network error while updating lobby slot' }
  }
}

/** Remove a player from a lobby slot (self-leave or host kick). */
export async function removeLobbySlot(
  mode: string,
  payload: {
    userId: string
    slot: number
  },
): Promise<{ ok: true, lobby: LobbySnapshot } | { ok: false, error: string }> {
  try {
    const lobby = await api.post<LobbySnapshot>(`/api/lobby/${mode}/remove`, payload)
    return { ok: true, lobby }
  }
  catch (err) {
    console.error('Failed to remove lobby slot:', err)
    if (err instanceof ApiError) return { ok: false, error: err.message }
    return { ok: false, error: 'Network error while removing lobby slot' }
  }
}

/** Start a draft from an open lobby (host-only). */
export async function startLobbyDraft(
  mode: string,
  userId: string,
): Promise<{ ok: true, matchId: string } | { ok: false, error: string }> {
  try {
    const data = await api.post<{ matchId?: string }>(`/api/lobby/${mode}/start`, { userId })
    if (!data.matchId) return { ok: false, error: 'Draft started but no match ID was returned' }
    return { ok: true, matchId: data.matchId }
  }
  catch (err) {
    console.error('Failed to start lobby draft:', err)
    if (err instanceof ApiError) return { ok: false, error: err.message }
    return { ok: false, error: 'Network error while starting lobby draft' }
  }
}

/** Cancel an open lobby before draft room creation */
export async function cancelLobby(
  mode: string,
  userId: string,
): Promise<{ ok: true } | { ok: false, error: string }> {
  try {
    await api.post(`/api/lobby/${mode}/cancel`, { userId })
    return { ok: true }
  }
  catch (err) {
    console.error('Failed to cancel lobby:', err)
    if (err instanceof ApiError) return { ok: false, error: err.message }
    return { ok: false, error: 'Network error while cancelling lobby' }
  }
}

/** Fetch match ID for a user from the bot API */
export async function fetchMatchForUser(
  userId: string,
): Promise<string | null> {
  try {
    const data = await api.get<{ matchId?: string }>(`/api/match/user/${userId}`)
    return data.matchId ?? null
  }
  catch (err) {
    console.error('Failed to fetch match for user:', err)
    return null
  }
}

/** Fetch full match state snapshot from bot API */
export async function fetchMatchState(matchId: string): Promise<MatchStateSnapshot | null> {
  try {
    return await api.get<MatchStateSnapshot>(`/api/match/state/${matchId}`)
  }
  catch (err) {
    console.error('Failed to fetch match state:', err)
    return null
  }
}

/** Report result from the activity (team games use "A" or "B") */
export async function reportMatchResult(
  matchId: string,
  reporterId: string,
  placements: string,
): Promise<{ ok: true } | { ok: false, error: string }> {
  try {
    await api.post(`/api/match/${matchId}/report`, { reporterId, placements })
    return { ok: true }
  }
  catch (err) {
    console.error('Failed to report match result:', err)
    if (err instanceof ApiError) return { ok: false, error: err.message }
    return { ok: false, error: 'Network error while reporting result' }
  }
}

// ── Handle Messages ────────────────────────────────────────

function handleServerMessage(msg: ServerMessage) {
  switch (msg.type) {
    case 'init':
      initDraft(msg.state, msg.hostId ?? msg.state.seats[0]?.playerId ?? '', msg.seatIndex, msg.timerEndsAt, msg.completedAt)
      break
    case 'update':
      updateDraft(msg.state, msg.hostId ?? msg.state.seats[0]?.playerId ?? '', msg.events, msg.timerEndsAt, msg.completedAt)
      if (pendingConfigAck) {
        clearTimeout(pendingConfigAck.timeout)
        pendingConfigAck.resolve()
        pendingConfigAck = null
      }
      break
    case 'error':
      if (pendingConfigAck) {
        clearTimeout(pendingConfigAck.timeout)
        pendingConfigAck.reject(formatConfigAckError(msg.message))
        pendingConfigAck = null
      }
      console.error('Server error:', msg.message)
      break
  }
}

function formatConfigAckError(message: string): Error {
  if (message === 'Unknown message type') {
    return new Error('Draft room server is outdated (missing config support). Redeploy/restart party server and create a new lobby.')
  }
  return new Error(message)
}
