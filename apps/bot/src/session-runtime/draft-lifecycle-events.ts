import type { DraftCancelReason, DraftState, ResolvedMapVoteResult } from '@civup/game'

export const DRAFT_LIFECYCLE_EVENT_KINDS = [
  'DraftCompleted',
  'LeaderSwapped',
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
  completedAt: number
  finalized?: boolean
  state: DraftState
  mapVoteResult?: ResolvedMapVoteResult | null
  hiddenDraft?: boolean
}

export interface DraftLifecycleCancelledPayload {
  eventId: string
  eventKind: 'DraftCancelled'
  eventSequence: number
  outcome: 'cancelled'
  matchId: string
  hostId?: string
  cancelledAt: number
  reason: DraftCancelReason
  state: DraftState
  mapVoteResult?: ResolvedMapVoteResult | null
  hiddenDraft?: boolean
}

export type DraftLifecyclePayload = DraftLifecycleCompletePayload | DraftLifecycleCancelledPayload
