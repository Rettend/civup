import type {
  DraftCancelReason,
  DraftEvent,
  DraftSeat,
  DraftState,
  DraftTimerConfig,
} from './types.ts'

// ── Room Configuration (sent by bot via HTTP POST) ──────────

/** Payload the bot sends to initialize a draft room */
export interface RoomConfig {
  matchId: string
  hostId: string
  formatId: string
  seats: DraftSeat[]
  civPool: string[]
  timerConfig?: DraftTimerConfig
  webhookUrl?: string
  webhookSecret?: string
}

export interface DraftCompleteWebhookPayload {
  outcome: 'complete'
  matchId: string
  hostId?: string
  completedAt: number
  state: DraftState
}

export interface DraftCancelledWebhookPayload {
  outcome: 'cancelled'
  matchId: string
  hostId?: string
  cancelledAt: number
  reason: DraftCancelReason
  state: DraftState
}

export type DraftWebhookPayload = DraftCompleteWebhookPayload | DraftCancelledWebhookPayload

// ── Client → Server Messages ────────────────────────────────

export type ClientMessage
  = | { type: 'start' }
    | { type: 'ban', civIds: string[] }
    | { type: 'pick', civId: string }
    | { type: 'cancel', reason: 'cancel' | 'scrub' }
    | {
      type: 'config'
      banTimerSeconds: number | null
      pickTimerSeconds: number | null
    }

// ── Server → Client Messages ────────────────────────────────

export type ServerMessage
  = | {
    type: 'init'
    state: DraftState
    hostId?: string
    seatIndex: number | null
    timerEndsAt: number | null
    completedAt: number | null
  }
  | {
    type: 'update'
    state: DraftState
    hostId?: string
    events: DraftEvent[]
    timerEndsAt: number | null
    completedAt: number | null
  }
  | { type: 'error', message: string }
