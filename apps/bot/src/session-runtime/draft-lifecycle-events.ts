import type { AppliedCivLobbySettings, DraftCancelReason, DraftDoublePickMetrics, DraftState, LeaderDataVersion, ResolvedMapVoteResult } from '@civup/game'

export const DRAFT_LIFECYCLE_EVENT_KINDS = [
  'DraftCompleted',
  'DraftFinalized',
  'DraftCancelled',
] as const

export type DraftLifecycleEventKind = (typeof DRAFT_LIFECYCLE_EVENT_KINDS)[number]

export interface DraftLifecycleCompletePayload {
  eventId: string
  eventKind: Exclude<DraftLifecycleEventKind, 'DraftCancelled'>
  eventSequence: number
  outcome: 'complete'
  matchId: string
  hostId?: string
  leaderDataVersion?: LeaderDataVersion
  completedAt: number
  finalized?: boolean
  state: DraftState
  mapVoteResult?: ResolvedMapVoteResult | null
  civBlitz?: boolean
  hiddenDraft?: boolean
  doublePickMetrics?: DraftDoublePickMetrics
  gameSettings?: AppliedCivLobbySettings
}

export interface DraftLifecycleCancelledPayload {
  eventId: string
  eventKind: 'DraftCancelled'
  eventSequence: number
  outcome: 'cancelled'
  matchId: string
  hostId?: string
  leaderDataVersion?: LeaderDataVersion
  cancelledAt: number
  reason: DraftCancelReason
  state: DraftState
  mapVoteResult?: ResolvedMapVoteResult | null
  civBlitz?: boolean
  hiddenDraft?: boolean
  doublePickMetrics?: DraftDoublePickMetrics
  gameSettings?: AppliedCivLobbySettings
}

export type DraftLifecyclePayload = DraftLifecycleCompletePayload | DraftLifecycleCancelledPayload
