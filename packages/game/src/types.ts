// ── Game Modes ──────────────────────────────────────────────

/** Individual game modes */
export type GameMode = 'ffa' | '1v1' | '2v2' | '3v3'

/** Leaderboard tracks (teamers combines 2v2 + 3v3) */
export type LeaderboardMode = 'ffa' | 'duel' | 'teamers'

/** Live competitive rank tiers used for role gates and ranked roles. */
export type CompetitiveTier = 'pleb' | 'squire' | 'gladiator' | 'legion' | 'champion'

export const GAME_MODES = ['ffa', '1v1', '2v2', '3v3'] as const satisfies readonly GameMode[]

export const LEADERBOARD_MODES = ['ffa', 'duel', 'teamers'] as const satisfies readonly LeaderboardMode[]

export const COMPETITIVE_TIERS = ['pleb', 'squire', 'gladiator', 'legion', 'champion'] as const satisfies readonly CompetitiveTier[]

/** Whether one competitive tier satisfies another tier's minimum gate. */
export function competitiveTierMeetsMinimum(current: CompetitiveTier | null, minimum: CompetitiveTier | null): boolean {
  if (minimum == null) return true
  if (current == null) return false
  return competitiveTierRank(current) >= competitiveTierRank(minimum)
}

/** Numeric order for comparing competitive tier prestige. */
export function competitiveTierRank(tier: CompetitiveTier): number {
  if (tier === 'pleb') return 0
  if (tier === 'squire') return 1
  if (tier === 'gladiator') return 2
  if (tier === 'legion') return 3
  return 4
}

// ── Leaders ─────────────────────────────────────────────────

export interface LeaderAbility {
  name: string
  description: string
}

export interface LeaderUnique {
  name: string
  description: string
  replaces?: string
  iconUrl?: string
}

export interface Leader {
  /** Stable identifier, e.g. "alexander" */
  id: string
  /** Display name, e.g. "Alexander" */
  name: string
  /** Civilization name, e.g. "Macedon" */
  civilization: string
  /** URL to leader portrait image */
  portraitUrl?: string
  /** Leader/civ unique ability */
  ability: LeaderAbility
  /** Unique unit(s) */
  uniqueUnits: LeaderUnique[]
  /** Unique building/district */
  uniqueBuilding?: LeaderUnique
  /** Unique improvement */
  uniqueImprovement?: LeaderUnique
  /** Namespaced filter tags, e.g. "econ:gold", "win:science", "role:frontline" */
  tags: string[]
}

// ── Draft Types ─────────────────────────────────────────────

export type DraftAction = 'ban' | 'pick'

export type DraftCancelReason = 'cancel' | 'scrub' | 'timeout'

/**
 * A single step in a draft sequence.
 *
 * Seats are always player slot indices (0 through N-1).
 * Team formats can target captain slots only (default: Team A captain = 0, Team B captain = 1).
 */
export interface DraftStep {
  action: DraftAction
  /**
   * Which seats act in this step.
   * `'all'` means all seats act simultaneously.
   * An array of seat indices means those specific seats act.
   */
  seats: number[] | 'all'
  /** How many selections each acting seat makes */
  count: number
  /** Timer in seconds (0 = no timer / unlimited) */
  timer: number
}

export interface DraftFormat {
  id: string
  name: string
  gameMode: GameMode
  /** Whether simultaneous bans are hidden until all submitted */
  blindBans: boolean
  /** Generate concrete steps for a given number of seats */
  getSteps: (seatCount: number) => DraftStep[]
}

export interface DraftTimerConfig {
  banTimerSeconds: number | null
  pickTimerSeconds: number | null
}

// ── Draft State Machine Types ───────────────────────────────

export interface DraftSeat {
  /** Discord user ID */
  playerId: string
  /** Display name */
  displayName: string
  /** Discord avatar URL */
  avatarUrl?: string | null
  /** Team index (for team modes), undefined for FFA */
  team?: number
}

export interface DraftSelection {
  civId: string
  seatIndex: number
  stepIndex: number
}

export interface DraftState {
  matchId: string
  formatId: string
  seats: DraftSeat[]
  /** Concrete steps expanded from the format */
  steps: DraftStep[]
  /** Current step index (-1 = waiting to start) */
  currentStepIndex: number
  /**
   * Pending submissions for the current step.
   * Key: seat index. Value: array of selected civ IDs.
   */
  submissions: Record<number, string[]>
  /** All completed bans */
  bans: DraftSelection[]
  /** All picks (assigned to seats) */
  picks: DraftSelection[]
  /** Civ IDs still available (not banned or picked) */
  availableCivIds: string[]
  status: 'waiting' | 'active' | 'complete' | 'cancelled'
  /** Why the draft was cancelled/scrubbed (null unless status is cancelled) */
  cancelReason: DraftCancelReason | null
  /**
   * For blind bans: accumulated bans that haven't been revealed yet.
   * Revealed when the simultaneous ban step completes.
   */
  pendingBlindBans: DraftSelection[]
}

/** Actions that can be applied to a draft */
export type DraftInput
  = | { type: 'START' }
    | { type: 'BAN', seatIndex: number, civIds: string[] }
    | { type: 'PICK', seatIndex: number, civId: string }
    | { type: 'CANCEL', reason: DraftCancelReason }
    | { type: 'TIMEOUT' }

/** Events emitted during state transitions (for broadcasting to clients) */
export type DraftEvent
  = | { type: 'DRAFT_STARTED' }
    | { type: 'DRAFT_CANCELLED', reason: DraftCancelReason }
    | { type: 'BAN_SUBMITTED', seatIndex: number, civIds: string[], blind: boolean }
    | { type: 'PICK_SUBMITTED', seatIndex: number, civId: string }
    | { type: 'BLIND_BANS_REVEALED', bans: DraftSelection[] }
    | { type: 'STEP_ADVANCED', stepIndex: number }
    | { type: 'DRAFT_COMPLETE' }
    | { type: 'TIMEOUT_APPLIED', seatIndex: number, selections: string[] }

export interface DraftResult {
  state: DraftState
  events: DraftEvent[]
}

export interface DraftError {
  error: string
}

// ── Match Types ─────────────────────────────────────────────

export type MatchStatus = 'drafting' | 'active' | 'completed' | 'cancelled'

// ── Queue Types ─────────────────────────────────────────────

export interface QueueEntry {
  playerId: string
  displayName: string
  avatarUrl?: string | null
  joinedAt: number
  /** For team modes: partner player IDs */
  partyIds?: string[]
}

export interface QueueState {
  mode: GameMode
  entries: QueueEntry[]
  /** How many players needed to start */
  targetSize: number
}
