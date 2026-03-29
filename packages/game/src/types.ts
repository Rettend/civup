// ── Game Modes ──────────────────────────────────────────────

/** Individual game modes */
export type GameMode = 'ffa' | '1v1' | '2v2' | '3v3' | '4v4'

/** Leaderboard tracks: duel (1v1), duo (2v2), squad (3v3 + 4v4), ffa, red death */
export type LeaderboardMode = 'duel' | 'duo' | 'squad' | 'ffa' | 'red-death'

/** Live competitive rank tiers used for role gates and ranked roles. */
export type CompetitiveTier = string

export const GAME_MODES = ['ffa', '1v1', '2v2', '3v3', '4v4'] as const satisfies readonly GameMode[]

export const LEADERBOARD_MODES = ['duel', 'duo', 'squad', 'ffa', 'red-death'] as const satisfies readonly LeaderboardMode[]

export const COMPETITIVE_TIERS = ['tier1', 'tier2', 'tier3', 'tier4', 'tier5'] as const satisfies readonly CompetitiveTier[]

/** Whether a value is a normalized ranked tier id like `tier1`. */
export function isCompetitiveTier(value: unknown): value is CompetitiveTier {
  return typeof value === 'string' && /^tier\d+$/i.test(value.trim())
}

/** Extract the numeric position from a ranked tier id. */
export function competitiveTierNumber(tier: CompetitiveTier): number | null {
  const match = /^tier(\d+)$/i.exec(tier.trim())
  if (!match) return null
  const parsed = Number(match[1])
  if (!Number.isFinite(parsed) || parsed < 1) return null
  return Math.round(parsed)
}

/** Whether one competitive tier satisfies another tier's minimum gate. */
export function competitiveTierMeetsMinimum(current: CompetitiveTier | null, minimum: CompetitiveTier | null): boolean {
  if (minimum == null) return true
  if (current == null) return false
  return competitiveTierRank(current) >= competitiveTierRank(minimum)
}

/** Whether one competitive tier stays within another tier's maximum gate. */
export function competitiveTierMeetsMaximum(current: CompetitiveTier | null, maximum: CompetitiveTier | null): boolean {
  if (maximum == null) return true
  if (current == null) return true
  return competitiveTierRank(current) <= competitiveTierRank(maximum)
}

/** Normalize min/max tier bounds, swapping them when they are inverted. */
export function normalizeCompetitiveTierBounds(
  minimum: CompetitiveTier | null,
  maximum: CompetitiveTier | null,
): {
  minimum: CompetitiveTier | null
  maximum: CompetitiveTier | null
  swapped: boolean
} {
  if (minimum && maximum && competitiveTierRank(minimum) > competitiveTierRank(maximum)) {
    return {
      minimum: maximum,
      maximum: minimum,
      swapped: true,
    }
  }

  return {
    minimum,
    maximum,
    swapped: false,
  }
}

/** Numeric order for comparing competitive tier prestige. */
export function competitiveTierRank(tier: CompetitiveTier): number {
  const number = competitiveTierNumber(tier)
  return number == null ? 0 : 1_000_000 - number
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

export type LeaderDataVersion = 'live' | 'beta'

export const LEADER_DATA_VERSIONS = ['live', 'beta'] as const satisfies readonly LeaderDataVersion[]

export function isLeaderDataVersion(value: unknown): value is LeaderDataVersion {
  return value === 'live' || value === 'beta'
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
  /** URL to full draft slot portrait image */
  fullPortraitUrl?: string
  /** Civilization ability */
  civilizationAbility: LeaderAbility
  /** Leader ability */
  ability: LeaderAbility
  /** Optional secondary ability; for Red Death */
  secondaryAbility?: LeaderAbility
  /** Unique unit(s) */
  uniqueUnits: LeaderUnique[]
  /** Unique building(s) and district(s) */
  uniqueBuildings: LeaderUnique[]
  /** Unique improvement(s) */
  uniqueImprovements: LeaderUnique[]
  /** Namespaced filter tags, e.g. "econ:gold", "win:science", "role:frontline" */
  tags: string[]
}

// ── Draft Types ─────────────────────────────────────────────

export type DraftAction = 'ban' | 'pick'

export type DraftCancelReason = 'cancel' | 'scrub' | 'timeout' | 'revert'

/**
 * A single step in a draft sequence.
 *
 * Seats are always player slot indices (0 through N-1).
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
  redDeath: boolean
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
  /** Factions dealt to the active picker this turn (rd modes only). */
  dealtCivIds?: string[] | null
  /** How many factions to deal per turn (rd modes only). */
  dealOptionsSize?: number
  status: 'waiting' | 'active' | 'complete' | 'cancelled'
  /** Why the draft was cancelled, scrubbed, timed out, or reverted (null unless status is cancelled) */
  cancelReason: DraftCancelReason | null
  /**
   * For blind bans: accumulated bans that haven't been revealed yet.
   * Revealed when the simultaneous ban step completes.
   */
  pendingBlindBans: DraftSelection[]
}

/** Server-authoritative tentative selections used for timeout fallback and teammate previews. */
export interface DraftPreviewState {
  bans: Record<number, string[]>
  picks: Record<number, string[]>
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
