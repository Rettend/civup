// ── Game Modes ──────────────────────────────────────────────

/** Individual game modes */
export type GameMode = 'ffa' | 'duel' | '2v2' | '3v3'

/** Leaderboard tracks (teamers combines 2v2 + 3v3) */
export type LeaderboardMode = 'ffa' | 'duel' | 'teamers'

export const GAME_MODES = ['ffa', 'duel', '2v2', '3v3'] as const satisfies readonly GameMode[]

export const LEADERBOARD_MODES = ['ffa', 'duel', 'teamers'] as const satisfies readonly LeaderboardMode[]

/** Map game mode to its leaderboard track */
export function toLeaderboardMode(mode: GameMode): LeaderboardMode {
  if (mode === '2v2' || mode === '3v3') return 'teamers'
  return mode
}

/** Whether a game mode is team-based */
export function isTeamMode(mode: GameMode): mode is '2v2' | '3v3' {
  return mode === '2v2' || mode === '3v3'
}

/** Number of teams for team modes */
export function teamCount(mode: GameMode): number {
  if (mode === 'duel') return 2
  if (mode === '2v2') return 2
  if (mode === '3v3') return 2
  return 0 // FFA has no teams
}

/** Players per team */
export function playersPerTeam(mode: GameMode): number {
  if (mode === 'duel') return 1
  if (mode === '2v2') return 2
  if (mode === '3v3') return 3
  return 1 // FFA: each player is their own "team" for draft purposes
}

/** Default player count for a mode */
export function defaultPlayerCount(mode: GameMode): number {
  if (mode === 'ffa') return 8
  if (mode === 'duel') return 2
  if (mode === '2v2') return 4
  if (mode === '3v3') return 6
  return 8
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

/**
 * A single step in a draft sequence.
 *
 * For team modes: seats are team indices (0 = Team A, 1 = Team B).
 * For FFA: seats are player indices (0 through N-1).
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
  status: 'waiting' | 'active' | 'complete'
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
    | { type: 'TIMEOUT' }

/** Events emitted during state transitions (for broadcasting to clients) */
export type DraftEvent
  = | { type: 'DRAFT_STARTED' }
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
