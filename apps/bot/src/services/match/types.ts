import type { DraftCancelReason, DraftDoublePickMetrics, DraftSeat, DraftState, GameMode, ResolvedMapVoteResult } from '@civup/game'

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

export interface MatchReporterIdentity {
  userId: string
  displayName?: string | null
  avatarUrl?: string | null
}

export interface ReportInput {
  matchId: string
  reporterId: string
  /** For team and 1v1 games: "A" or "B". For FFA: player IDs in placement order, newline-separated. */
  placements: string
  /** Hidden draft reports provide final in-game leader IDs keyed by player ID. */
  leaderAssignments?: Record<string, string>
}

export interface ReportProcessingClaim {
  matchId: string
  claimId: string
}

export type ReportResult = { match: MatchRow, participants: ParticipantRow[], idempotent?: boolean, reportProcessing?: boolean, reportClaim?: ReportProcessingClaim } | { error: string }

export interface ResolveMatchInput {
  matchId: string
  placements: string
  resolvedAt: number
}

export interface CancelMatchInput {
  matchId: string
  cancelledAt: number
}

export interface CorrectMatchLeadersInput {
  matchId: string
  playerId: string
  leaderId?: string | null
  swapWithPlayerId?: string | null
  correctedAt: number
}

export interface MatchLeaderCorrection {
  playerId: string
  previousCivId: string | null
  nextCivId: string | null
}

export interface ModeratedMatchResult {
  match: MatchRow
  participants: ParticipantRow[]
  previousStatus: string
  recalculatedMatchIds: string[]
}

export interface MatchLeaderCorrectionResult extends ModeratedMatchResult {
  corrections: MatchLeaderCorrection[]
}

export type ResolveMatchResult = ModeratedMatchResult | { error: string }
export type CancelMatchResult = ModeratedMatchResult | { error: string }
export type CorrectMatchLeadersResult = MatchLeaderCorrectionResult | { error: string }

export interface ManualReportedMatchPlayerInput {
  playerId: string
  displayName: string
  avatarUrl?: string | null
  civId: string
}

export interface CreateManualReportedMatchInput {
  matchId?: string
  mode: GameMode
  permanentAlly?: boolean
  players: ManualReportedMatchPlayerInput[]
  reporterId: string
  reportedAt: number
}

export type CreateManualReportedMatchResult = ModeratedMatchResult | { error: string }

export interface CreateDraftMatchInput {
  matchId: string
  mode: GameMode
  seats: DraftSeat[]
}

export interface ActivateDraftInput {
  state: DraftState
  completedAt: number
  hostId: string
  mapVoteResult?: ResolvedMapVoteResult | null
  hiddenDraft?: boolean
  permanentAlly?: boolean
  doublePickMetrics?: DraftDoublePickMetrics
}

export type ActivateDraftResult = { match: MatchRow, participants: ParticipantRow[], alreadyActive: boolean } | { error: string }

export interface CancelDraftInput {
  state: DraftState
  cancelledAt: number
  reason: DraftCancelReason
  hostId: string
  mapVoteResult?: ResolvedMapVoteResult | null
  hiddenDraft?: boolean
  permanentAlly?: boolean
  doublePickMetrics?: DraftDoublePickMetrics
  allowActive?: boolean
}

export type CancelDraftResult = { match: MatchRow, participants: ParticipantRow[] } | { error: string }

export interface PruneMatchesOptions {
  staleDraftingMs?: number
  staleActiveMs?: number
  staleCancelledMs?: number
  sessionNamespace?: DurableObjectNamespace | null
  allowDirectTerminalWriteForTests?: boolean
}

export interface PruneMatchesResult {
  removedMatchIds: string[]
  clearedLiveLobbyMatchIds: string[]
}
