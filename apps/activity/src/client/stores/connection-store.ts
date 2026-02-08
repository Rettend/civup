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

// ── State ──────────────────────────────────────────────────

const [connectionStatus, setConnectionStatus] = createSignal<ConnectionStatus>('disconnected')
const [connectionError, setConnectionError] = createSignal<string | null>(null)

export { connectionError, connectionStatus }

// ── Socket ─────────────────────────────────────────────────

let socket: PartySocket | null = null

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
  setConnectionStatus('disconnected')
}

// ── Send Messages ──────────────────────────────────────────

export function sendMessage(msg: ClientMessage) {
  if (!socket || connectionStatus() !== 'connected') {
    console.warn('Cannot send message: not connected')
    return
  }
  socket.send(JSON.stringify(msg))
}

export function sendStart() {
  sendMessage({ type: 'start' })
}

export function sendBan(civIds: string[]) {
  sendMessage({ type: 'ban', civIds })
}

export function sendPick(civId: string) {
  sendMessage({ type: 'pick', civId })
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
      initDraft(msg.state, msg.seatIndex, msg.timerEndsAt, msg.completedAt)
      break
    case 'update':
      updateDraft(msg.state, msg.events, msg.timerEndsAt, msg.completedAt)
      break
    case 'error':
      console.error('Server error:', msg.message)
      break
  }
}
