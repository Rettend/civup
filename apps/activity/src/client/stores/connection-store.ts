import type { ClientMessage, ServerMessage } from '@civup/game'
import PartySocket from 'partysocket'
import { createSignal } from 'solid-js'
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

const [connectionStatus, setConnectionStatus] = createSignal<ConnectionStatus>('disconnected')
const [connectionError, setConnectionError] = createSignal<string | null>(null)

export { connectionError, connectionStatus }

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

  relayDevLog('info', 'Connecting to draft room', { host, roomId, playerId })

  setConnectionStatus('connecting')
  setConnectionError(null)

  socket = new PartySocket({
    host,
    party: 'main', // default party name when not specified in partykit.json
    prefix: 'api/parties',
    room: roomId,
    id: playerId,
    query: { playerId }, // the draft-room reads this from the connection URL
    maxRetries: 2,
  })

  socket.addEventListener('open', () => {
    relayDevLog('info', 'Draft socket connected', { roomId, playerId })
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

    relayDevLog('info', 'Draft socket closed normally', { code, reason, roomId })
    setConnectionStatus('disconnected')
  })

  socket.addEventListener('error', () => {
    relayDevLog('error', 'Draft socket connection failed', { roomId, playerId })
    setConnectionStatus('error')
    setConnectionError('WebSocket connection failed')
  })
}

export function disconnect() {
  relayDevLog('info', 'Draft socket disconnect requested')
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
    const res = await fetch(`/api/match/${channelId}`)
    if (!res.ok) return null

    const data = await res.json() as { matchId?: string }
    return data.matchId ?? null
  }
  catch (err) {
    console.error('Failed to fetch match for channel:', err)
    return null
  }
}

/** Fetch open lobby state for a channel from the bot API */
export async function fetchLobbyForChannel(
  channelId: string,
): Promise<LobbySnapshot | null> {
  try {
    const res = await fetch(`/api/lobby/${channelId}`)
    if (!res.ok) return null

    return await res.json() as LobbySnapshot
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
    const res = await fetch(`/api/lobby/user/${userId}`)
    if (!res.ok) return null

    return await res.json() as LobbySnapshot
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
    const res = await fetch(`/api/lobby/${mode}/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        banTimerSeconds: draftConfig.banTimerSeconds,
        pickTimerSeconds: draftConfig.pickTimerSeconds,
      }),
    })

    const data = await res.json() as LobbySnapshot & { error?: string }
    if (!res.ok) return { ok: false, error: data.error ?? 'Failed to update lobby config' }
    return { ok: true, lobby: data }
  }
  catch (err) {
    console.error('Failed to update lobby config:', err)
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
    const res = await fetch(`/api/lobby/${mode}/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, nextMode }),
    })

    const data = await res.json() as LobbySnapshot & { error?: string }
    if (!res.ok) return { ok: false, error: data.error ?? 'Failed to update lobby mode' }
    return { ok: true, lobby: data }
  }
  catch (err) {
    console.error('Failed to update lobby mode:', err)
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
    const res = await fetch(`/api/lobby/${mode}/place`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    const data = await res.json() as LobbySnapshot & { error?: string }
    if (!res.ok) return { ok: false, error: data.error ?? 'Failed to place lobby slot' }
    return { ok: true, lobby: data }
  }
  catch (err) {
    console.error('Failed to place lobby slot:', err)
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
    const res = await fetch(`/api/lobby/${mode}/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    const data = await res.json() as LobbySnapshot & { error?: string }
    if (!res.ok) return { ok: false, error: data.error ?? 'Failed to remove lobby slot' }
    return { ok: true, lobby: data }
  }
  catch (err) {
    console.error('Failed to remove lobby slot:', err)
    return { ok: false, error: 'Network error while removing lobby slot' }
  }
}

/** Start a draft from an open lobby (host-only). */
export async function startLobbyDraft(
  mode: string,
  userId: string,
): Promise<{ ok: true, matchId: string } | { ok: false, error: string }> {
  try {
    const res = await fetch(`/api/lobby/${mode}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    })

    const data = await res.json() as { matchId?: string, error?: string }
    if (!res.ok) return { ok: false, error: data.error ?? 'Failed to start lobby draft' }
    if (!data.matchId) return { ok: false, error: 'Draft started but no match ID was returned' }
    return { ok: true, matchId: data.matchId }
  }
  catch (err) {
    console.error('Failed to start lobby draft:', err)
    return { ok: false, error: 'Network error while starting lobby draft' }
  }
}

/** Cancel an open lobby before draft room creation */
export async function cancelLobby(
  mode: string,
  userId: string,
): Promise<{ ok: true } | { ok: false, error: string }> {
  try {
    const res = await fetch(`/api/lobby/${mode}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    })

    const data = await res.json() as { error?: string }
    if (!res.ok) return { ok: false, error: data.error ?? 'Failed to cancel lobby' }
    return { ok: true }
  }
  catch (err) {
    console.error('Failed to cancel lobby:', err)
    return { ok: false, error: 'Network error while cancelling lobby' }
  }
}

/** Fetch match ID for a user from the bot API */
export async function fetchMatchForUser(
  userId: string,
): Promise<string | null> {
  try {
    const res = await fetch(`/api/match/user/${userId}`)
    if (!res.ok) return null

    const data = await res.json() as { matchId?: string }
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
    const res = await fetch(`/api/match/state/${matchId}`)
    if (!res.ok) return null
    return await res.json() as MatchStateSnapshot
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
    const res = await fetch(`/api/match/${matchId}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reporterId, placements }),
    })
    const data = await res.json() as { error?: string }
    if (!res.ok) return { ok: false, error: data.error ?? 'Failed to report result' }
    return { ok: true }
  }
  catch (err) {
    console.error('Failed to report match result:', err)
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
