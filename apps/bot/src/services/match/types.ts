import type { DraftCancelReason, DraftSeat, DraftState, GameMode } from '@civup/game'

export interface MatchRow {
  id: string
  gameMode: string
  status: string
  createdAt: number
  completedAt: number | null
  draftData: string | null
}

export interface ParticipantRow {
  matchId: string
  playerId: string
  team: number | null
  civId: string | null
  placement: number | null
  ratingBeforeMu: number | null
  ratingBeforeSigma: number | null
  ratingAfterMu: number | null
  ratingAfterSigma: number | null
  leaderboardBeforeRank?: number | null
  leaderboardAfterRank?: number | null
  leaderboardEligibleCount?: number | null
}

export interface ReportInput {
  matchId: string
  reporterId: string
  /** For team and 1v1 games: "A" or "B". For FFA: player IDs in placement order, newline-separated. */
  placements: string
}

export type ReportResult = { match: MatchRow, participants: ParticipantRow[], idempotent?: boolean } | { error: string }

export interface ResolveMatchInput {
  matchId: string
  placements: string
  resolvedAt: number
}

export interface CancelMatchInput {
  matchId: string
  cancelledAt: number
}

export interface ModeratedMatchResult {
  match: MatchRow
  participants: ParticipantRow[]
  previousStatus: string
  recalculatedMatchIds: string[]
}

export type ResolveMatchResult = ModeratedMatchResult | { error: string }
export type CancelMatchResult = ModeratedMatchResult | { error: string }

export interface CreateDraftMatchInput {
  matchId: string
  mode: GameMode
  seats: DraftSeat[]
}

export interface ActivateDraftInput {
  state: DraftState
  completedAt: number
  hostId: string
}

export type ActivateDraftResult = { match: MatchRow, participants: ParticipantRow[], alreadyActive: boolean } | { error: string }

export interface CancelDraftInput {
  state: DraftState
  cancelledAt: number
  reason: DraftCancelReason
  hostId: string
}

export type CancelDraftResult = { match: MatchRow, participants: ParticipantRow[] } | { error: string }

export interface PruneMatchesOptions {
  staleDraftingMs?: number
  staleActiveMs?: number
  staleCancelledMs?: number
}

export interface PruneMatchesResult {
  removedMatchIds: string[]
}
