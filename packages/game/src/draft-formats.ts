import type { DraftFormat, DraftSeat, DraftStep, GameMode } from './types.ts'

const FULL_ROSTER_2V2_PICK_ORDER = [0, 1, 3, 2] as const
const FULL_ROSTER_3V3_PICK_ORDER = [0, 1, 3, 2, 4, 5] as const
const FULL_ROSTER_4V4_PICK_ORDER = [0, 1, 3, 2, 5, 4, 6, 7] as const
const RED_DEATH_2P_4P_PICK_ORDER = [0, 1, 3, 2] as const
const RED_DEATH_2P_8P_PICK_ORDER = [0, 1, 2, 3, 7, 6, 5, 4] as const
const RED_DEATH_4P_8P_PICK_ORDER = [0, 1, 3, 2, 5, 4, 6, 7] as const
const TEAM_BAN_STEP: DraftStep = { action: 'ban', seats: [0, 1], count: 3, timer: 120 }
const FFA_BAN_STEP: DraftStep = { action: 'ban', seats: 'all', count: 2, timer: 120 }

function createSinglePickStep(seat: number): DraftStep {
  return { action: 'pick', seats: [seat], count: 1, timer: 60 }
}

function createTeamFormat(config: {
  id: string
  name: string
  gameMode: Extract<GameMode, '2v2' | '3v3' | '4v4'>
  fullRosterPickOrder: readonly number[]
}): DraftFormat {
  return {
    id: config.id,
    name: config.name,
    gameMode: config.gameMode,
    blindBans: true,
    getSteps(_seatCount: number): DraftStep[] {
      return [TEAM_BAN_STEP, ...config.fullRosterPickOrder.map(createSinglePickStep)]
    },
  }
}

/**
 * 2v2 Format:
 * - 3 blind bans per team (simultaneous)
 * - Captains submit bans (seat 0 = Team A captain, seat 1 = Team B captain)
 * - Pick order: 1221
 */
export const default2v2 = createTeamFormat({
  id: 'default-2v2',
  name: '2v2',
  gameMode: '2v2',
  fullRosterPickOrder: FULL_ROSTER_2V2_PICK_ORDER,
})

/**
 * 3v3 Format:
 * - 3 blind bans per team (simultaneous)
 * - Captains submit bans (seat 0 = Team A captain, seat 1 = Team B captain)
 * - Pick order: 122112
 */
export const default3v3 = createTeamFormat({
  id: 'default-3v3',
  name: '3v3',
  gameMode: '3v3',
  fullRosterPickOrder: FULL_ROSTER_3V3_PICK_ORDER,
})

/**
 * 4v4 Format:
 * - 3 blind bans per team (simultaneous)
 * - Captains submit bans (seat 0 = Team A captain, seat 1 = Team B captain)
 * - Pick order: 12212112
 */
export const default4v4 = createTeamFormat({
  id: 'default-4v4',
  name: '4v4',
  gameMode: '4v4',
  fullRosterPickOrder: FULL_ROSTER_4V4_PICK_ORDER,
})

/**
 * 1v1 Format:
 * - 3 blind bans each (simultaneous)
 * - Pick order: 12
 */
export const default1v1: DraftFormat = {
  id: 'default-1v1',
  name: '1v1',
  gameMode: '1v1',
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
 * FFA Format:
 * - 2 blind bans per player (simultaneous)
 * - Players pick in seat order
 */
export const defaultFfa: DraftFormat = {
  id: 'default-ffa',
  name: 'FFA',
  gameMode: 'ffa',
  blindBans: true,
  getSteps(seatCount: number): DraftStep[] {
    return [
      FFA_BAN_STEP,
      ...Array.from({ length: seatCount }, (_, seatIndex) => createSinglePickStep(seatIndex)),
    ]
  },
}

/**
 * FFA Simultaneous Format:
 * - 2 blind bans per player (simultaneous)
 * - Everyone picks at the same time on a shared timer
 */
export const defaultFfaSimultaneous: DraftFormat = {
  id: 'default-ffa-simultaneous',
  name: 'FFA Simultaneous',
  gameMode: 'ffa',
  blindBans: true,
  getSteps(_seatCount: number): DraftStep[] {
    return [
      FFA_BAN_STEP,
      { action: 'pick', seats: 'all', count: 1, timer: 60 },
    ]
  },
}

export const defaultRd2p: DraftFormat = {
  id: 'default-rd-2p',
  name: 'RD 2p',
  gameMode: 'rd-2p',
  blindBans: false,
  getSteps(seatCount: number): DraftStep[] {
    const pickOrder = seatCount <= 4
      ? RED_DEATH_2P_4P_PICK_ORDER
      : RED_DEATH_2P_8P_PICK_ORDER
    return pickOrder.map(seat => ({ action: 'pick', seats: [seat], count: 1, timer: 30 }))
  },
}

export const defaultRd4p: DraftFormat = {
  id: 'default-rd-4p',
  name: 'RD 4p',
  gameMode: 'rd-4p',
  blindBans: false,
  getSteps(_seatCount: number): DraftStep[] {
    return RED_DEATH_4P_8P_PICK_ORDER.map(seat => ({ action: 'pick', seats: [seat], count: 1, timer: 30 }))
  },
}

// ── Format Registry ──────────────────────────────────────

/** All available draft formats */
export const draftFormats: DraftFormat[] = [
  defaultFfa,
  defaultFfaSimultaneous,
  default1v1,
  default2v2,
  default3v3,
  default4v4,
  defaultRd2p,
  defaultRd4p,
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

export function getDraftFormat(gameMode: string, options: { simultaneousPick?: boolean, randomDraft?: boolean } = {}): DraftFormat {
  if (gameMode === 'ffa' && options.simultaneousPick) return defaultFfaSimultaneous
  return getDefaultFormat(gameMode)
}

export function formatDraftStepLabel(
  step: Pick<DraftStep, 'action' | 'seats'>,
  seats: DraftSeat[],
): string {
  if (step.action === 'ban') return 'BAN'
  if (step.seats === 'all') return 'PICK'

  const actors = Array.from(new Set(step.seats.flatMap((seatIndex) => {
    const seat = seats[seatIndex]
    if (!seat) return []
    if (seat.team != null) return [`T${seat.team + 1}`]
    return [`P${seatIndex + 1}`]
  })))

  return actors.length > 0 ? `PICK ${actors.join(' & ')}` : 'PICK'
}
