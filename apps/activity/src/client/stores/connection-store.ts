import type { ClientMessage, ServerMessage } from '@civup/game'
import PartySocket from 'partysocket'
import { createSignal } from 'solid-js'
import { initDraft, updateDraft } from './draft-store'

// ── Types ──────────────────────────────────────────────────

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

// ── State ──────────────────────────────────────────────────

const [connectionStatus, setConnectionStatus] = createSignal<ConnectionStatus>('disconnected')
const [connectionError, setConnectionError] = createSignal<string | null>(null)
const [connectionLogs, setConnectionLogs] = createSignal<string[]>([])

export { connectionError, connectionLogs, connectionStatus }

function addConnectionLog(message: string) {
  const line = `${new Date().toISOString()} ${message}`
  setConnectionLogs(prev => [...prev.slice(-39), line])
  console.log(`[activity] ${message}`)
}

// ── Socket ─────────────────────────────────────────────────

let socket: PartySocket | null = null

/** Connect to PartyKit draft room using host and match ID */
export function connectToRoom(host: string, roomId: string, playerId: string) {
  if (socket) {
    socket.close()
  }

  addConnectionLog(`connect start host=${host} room=${roomId} user=${playerId}`)
  setConnectionStatus('connecting')
  setConnectionError(null)

  socket = new PartySocket({
    host,
    party: 'main', // default party name when not specified in partykit.json
    room: roomId,
    id: playerId,
    query: { playerId }, // the draft-room reads this from the connection URL
    maxRetries: 2,
  })

  socket.addEventListener('open', () => {
    addConnectionLog('websocket open')
    setConnectionStatus('connected')
    setConnectionError(null)
  })

  socket.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data as string) as ServerMessage
      handleServerMessage(msg)
    }
    catch (err) {
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
    addConnectionLog(`websocket close code=${code} reason=${reason}`)
    if (code !== 1000) {
      setConnectionStatus('error')
      setConnectionError(`WebSocket closed (${code}${reason ? `: ${reason}` : ''})`)
      return
    }
    setConnectionStatus('disconnected')
  })

  socket.addEventListener('error', () => {
    addConnectionLog('websocket error')
    setConnectionStatus('error')
    setConnectionError('WebSocket connection failed')
  })
}

export function disconnect() {
  socket?.close()
  socket = null
  addConnectionLog('disconnect called')
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
    const url = `/api/match/${channelId}`
    addConnectionLog(`lookup channel ${channelId} -> ${url}`)
    const res = await fetch(url)
    addConnectionLog(`lookup channel status=${res.status}`)
    if (!res.ok) return null

    const data = await res.json() as { matchId?: string }
    addConnectionLog(`lookup channel match=${data.matchId ?? 'null'}`)
    return data.matchId ?? null
  }
  catch (err) {
    addConnectionLog('lookup channel failed')
    console.error('Failed to fetch match for channel:', err)
    return null
  }
}

/** Fetch match ID for a user from the bot API */
export async function fetchMatchForUser(
  userId: string,
): Promise<string | null> {
  try {
    const url = `/api/match/user/${userId}`
    addConnectionLog(`lookup user ${userId} -> ${url}`)
    const res = await fetch(url)
    addConnectionLog(`lookup user status=${res.status}`)
    if (!res.ok) return null

    const data = await res.json() as { matchId?: string }
    addConnectionLog(`lookup user match=${data.matchId ?? 'null'}`)
    return data.matchId ?? null
  }
  catch (err) {
    addConnectionLog('lookup user failed')
    console.error('Failed to fetch match for user:', err)
    return null
  }
}

// ── Handle Messages ────────────────────────────────────────

function handleServerMessage(msg: ServerMessage) {
  switch (msg.type) {
    case 'init':
      initDraft(msg.state, msg.seatIndex, msg.timerEndsAt)
      break
    case 'update':
      updateDraft(msg.state, msg.events, msg.timerEndsAt)
      break
    case 'error':
      console.error('Server error:', msg.message)
      break
  }
}
