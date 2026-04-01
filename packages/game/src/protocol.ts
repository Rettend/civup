import type {
  DraftAction,
  DraftCancelReason,
  DraftEvent,
  DraftPreviewState,
  DraftSeat,
  DraftSelection,
  DraftState,
  DraftTimerConfig,
  LeaderSwapState,
  LeaderDataVersion,
} from './types.ts'

// ── Room Configuration (sent by bot via HTTP POST) ──────────

/** Payload the bot sends to initialize a draft room */
export interface RoomConfig {
  matchId: string
  hostId: string
  formatId: string
  seats: DraftSeat[]
  civPool: string[]
  dealOptionsSize?: number
  randomDraft?: boolean
  leaderDataVersion?: LeaderDataVersion
  timerConfig?: DraftTimerConfig
  webhookUrl?: string
  webhookSecret?: string
}

export interface DraftCompleteWebhookPayload {
  outcome: 'complete'
  matchId: string
  hostId?: string
  completedAt: number
  finalized?: boolean
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
    | { type: 'preview', action: DraftAction, civIds: string[] }
    | { type: 'cancel', reason: 'cancel' | 'scrub' | 'revert' }
    | { type: 'swap-request', toSeat: number }
    | { type: 'swap-accept' }
    | { type: 'swap-cancel' }
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
    leaderDataVersion?: LeaderDataVersion
    hostId?: string
    seatIndex: number | null
    timerEndsAt: number | null
    completedAt: number | null
    previews: DraftPreviewState
    swapState?: LeaderSwapState | null
  }
  | {
    type: 'update'
    state: DraftState
    leaderDataVersion?: LeaderDataVersion
    hostId?: string
    events: DraftEvent[]
    timerEndsAt: number | null
    completedAt: number | null
    previews: DraftPreviewState
    swapState?: LeaderSwapState | null
  }
  | { type: 'preview', previews: DraftPreviewState }
  | { type: 'swap-update', swapState: LeaderSwapState, picks?: DraftSelection[] }
  | { type: 'error', message: string }
