import type { ClientMessage, ServerMessage } from '@civup/game'
import PartySocket from 'partysocket'
import { createSignal } from 'solid-js'
import { initDraft, updateDraft } from './draft-store'

// ── Types ──────────────────────────────────────────────────

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

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

  setConnectionStatus('connecting')
  setConnectionError(null)

  socket = new PartySocket({
    host,
    room: roomId,
    id: playerId,
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
      console.error('Failed to parse server message:', err)
    }
  })

  socket.addEventListener('close', () => {
    setConnectionStatus('disconnected')
  })

  socket.addEventListener('error', () => {
    setConnectionStatus('error')
    setConnectionError('WebSocket connection failed')
  })
}

export function disconnect() {
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
