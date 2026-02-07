import type { DraftFormat, DraftStep } from './types.ts'

/**
 * PPL 2v2 Format:
 * - 3 blind bans per team (simultaneous)
 * - Team A picks 1
 * - Team B picks 2
 * - Team A picks 1
 */
export const ppl2v2: DraftFormat = {
  id: 'ppl-2v2',
  name: 'PPL 2v2',
  gameMode: '2v2',
  blindBans: true,
  getSteps(_seatCount: number): DraftStep[] {
    // Seats: 0 = Team A, 1 = Team B
    return [
      // Phase 1: Both teams ban 3 simultaneously (blind)
      { action: 'ban', seats: 'all', count: 3, timer: 120 },
      // Phase 2: Team A picks 1
      { action: 'pick', seats: [0], count: 1, timer: 60 },
      // Phase 3: Team B picks 2
      { action: 'pick', seats: [1], count: 2, timer: 90 },
      // Phase 4: Team A picks 1
      { action: 'pick', seats: [0], count: 1, timer: 60 },
    ]
  },
}

/**
 * PPL 3v3 Format:
 * - 3 blind bans per team (simultaneous)
 * - Snake pick: T1-T2-T2-T1-T1-T2
 */
export const ppl3v3: DraftFormat = {
  id: 'ppl-3v3',
  name: 'PPL 3v3',
  gameMode: '3v3',
  blindBans: true,
  getSteps(_seatCount: number): DraftStep[] {
    return [
      { action: 'ban', seats: 'all', count: 3, timer: 120 },
      { action: 'pick', seats: [0], count: 1, timer: 60 },
      { action: 'pick', seats: [1], count: 2, timer: 90 },
      { action: 'pick', seats: [0], count: 2, timer: 90 },
      { action: 'pick', seats: [1], count: 1, timer: 60 },
    ]
  },
}

/**
 * PPL Duel Format:
 * - 3 blind bans each (simultaneous)
 * - Player 1 picks 1
 * - Player 2 picks 1
 */
export const pplDuel: DraftFormat = {
  id: 'ppl-duel',
  name: 'PPL Duel',
  gameMode: 'duel',
  blindBans: true,
  getSteps(_seatCount: number): DraftStep[] {
    return [
      { action: 'ban', seats: 'all', count: 3, timer: 120 },
      { action: 'pick', seats: [0], count: 1, timer: 60 },
      { action: 'pick', seats: [1], count: 1, timer: 60 },
    ]
  },
}

/**
 * PPL FFA Format:
 * - 2 blind bans per player (simultaneous)
 * - Snake pick order (by rating, handled externally):
 *   P1, P2, ..., Pn (one pick each — each player picks 1 civ)
 */
export const pplFfa: DraftFormat = {
  id: 'ppl-ffa',
  name: 'PPL FFA',
  gameMode: 'ffa',
  blindBans: true,
  getSteps(seatCount: number): DraftStep[] {
    const steps: DraftStep[] = [
      // Everyone bans 2 simultaneously (blind)
      { action: 'ban', seats: 'all', count: 2, timer: 120 },
    ]
    // Each player picks 1 in order (seat 0, 1, 2, ..., n-1)
    for (let i = 0; i < seatCount; i++) {
      steps.push({ action: 'pick', seats: [i], count: 1, timer: 60 })
    }
    return steps
  },
}

// ── Format Registry ──────────────────────────────────────

/** All available draft formats */
export const draftFormats: DraftFormat[] = [
  pplFfa,
  pplDuel,
  ppl2v2,
  ppl3v3,
]

/** Map of format ID to format */
export const draftFormatMap = new Map<string, DraftFormat>(
  draftFormats.map(f => [f.id, f]),
)

/** Get default format for a game mode */
export function getDefaultFormat(gameMode: string): DraftFormat {
  const format = draftFormats.find(f => f.gameMode === gameMode)
  if (!format) throw new Error(`No format found for game mode: ${gameMode}`)
  return format
}
