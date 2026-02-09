import type { DraftEvent, DraftSeat, DraftState, DraftTimerConfig } from './types.ts'

// ── Room Configuration (sent by bot via HTTP POST) ──────────

/** Payload the bot sends to initialize a draft room */
export interface RoomConfig {
  matchId: string
  formatId: string
  seats: DraftSeat[]
  civPool: string[]
  timerConfig?: DraftTimerConfig
  webhookUrl?: string
  webhookSecret?: string
}

export interface DraftCompleteWebhookPayload {
  matchId: string
  completedAt: number
  state: DraftState
}

// ── Client → Server Messages ────────────────────────────────

export type ClientMessage
  = | { type: 'start' }
    | { type: 'ban', civIds: string[] }
    | { type: 'pick', civId: string }
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
    seatIndex: number | null
    timerEndsAt: number | null
    completedAt: number | null
  }
  | {
    type: 'update'
    state: DraftState
    events: DraftEvent[]
    timerEndsAt: number | null
    completedAt: number | null
  }
  | { type: 'error', message: string }
