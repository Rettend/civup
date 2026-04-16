import type { DraftFormat, DraftSeat, DraftStep, GameMode } from './types.ts'

const FULL_ROSTER_3V3_PICK_ORDER = [0, 1, 3, 2, 4, 5] as const
const FULL_ROSTER_4V4_PICK_ORDER = [0, 1, 3, 2, 5, 4, 6, 7] as const
const FULL_ROSTER_5V5_PICK_ORDER = [0, 1, 3, 2, 5, 4, 6, 7, 8, 9] as const
const FULL_ROSTER_6V6_PICK_ORDER = [0, 1, 3, 2, 5, 4, 6, 7, 9, 8, 10, 11] as const
const TEAM_BAN_STEP: DraftStep = { action: 'ban', seats: [0, 1], count: 3, timer: 120 }
const FFA_BAN_STEP: DraftStep = { action: 'ban', seats: 'all', count: 2, timer: 120 }
const SEQUENTIAL_BAN_STEP_TIMER = 45
const VISIBLE_TEAM_BAN_STEPS: DraftStep[] = [
  { action: 'ban', seats: [0], count: 1, timer: SEQUENTIAL_BAN_STEP_TIMER },
  { action: 'ban', seats: [1], count: 2, timer: SEQUENTIAL_BAN_STEP_TIMER },
  { action: 'ban', seats: [0], count: 2, timer: SEQUENTIAL_BAN_STEP_TIMER },
  { action: 'ban', seats: [1], count: 1, timer: SEQUENTIAL_BAN_STEP_TIMER },
]

type VisibleBanGameMode = Extract<GameMode, '1v1' | '2v2' | '3v3' | '4v4' | '5v5' | '6v6'>
type TeamGameMode = Exclude<VisibleBanGameMode, '1v1'>

function createSinglePickStep(seat: number): DraftStep {
  return { action: 'pick', seats: [seat], count: 1, timer: 60 }
}

function createCaptainBanStep(captainCount: number): DraftStep {
  return {
    action: 'ban',
    seats: Array.from({ length: captainCount }, (_, seatIndex) => seatIndex),
    count: 3,
    timer: 120,
  }
}

function supportsVisibleCaptainBans(gameMode: string, seatCount?: number): gameMode is VisibleBanGameMode {
  if (gameMode === '1v1') return true
  if (gameMode === '2v2') return seatCount == null || seatCount === 4
  return gameMode === '3v3' || gameMode === '4v4' || gameMode === '5v5' || gameMode === '6v6'
}

function getTwoVTwoTeamCount(seatCount: number): number {
  return Math.max(2, Math.floor(Math.max(4, seatCount) / 2))
}

function createTwoVTwoPickOrder(seatCount: number): number[] {
  const teams = getTwoVTwoTeamCount(seatCount)
  return [
    ...Array.from({ length: teams }, (_, seatIndex) => seatIndex),
    ...Array.from({ length: teams }, (_, index) => (teams * 2) - 1 - index),
  ]
}

function createTeamFormat(config: {
  id: string
  name: string
  gameMode: TeamGameMode
  getPickOrder: (seatCount: number) => readonly number[]
  getBanStep?: (seatCount: number) => DraftStep
  blindBans?: boolean
}): DraftFormat {
  return {
    id: config.id,
    name: config.name,
    gameMode: config.gameMode,
    redDeath: false,
    blindBans: config.blindBans ?? true,
    getSteps(seatCount: number): DraftStep[] {
      const pickOrder = config.getPickOrder(seatCount)
      return [
        ...(config.blindBans === false
          ? VISIBLE_TEAM_BAN_STEPS
          : [(config.getBanStep ?? (() => TEAM_BAN_STEP))(seatCount)]),
        ...pickOrder.map(createSinglePickStep),
      ]
    },
  }
}

function createRedDeathFormat(config: {
  id: string
  name: string
  gameMode: GameMode
  getPickOrder: (seatCount: number) => readonly number[]
}): DraftFormat {
  return {
    id: config.id,
    name: config.name,
    gameMode: config.gameMode,
    redDeath: true,
    blindBans: false,
    getSteps(seatCount: number): DraftStep[] {
      return config.getPickOrder(seatCount).map(seat => ({ action: 'pick', seats: [seat], count: 1, timer: 30 }))
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
  getPickOrder(seatCount) {
    return createTwoVTwoPickOrder(seatCount)
  },
  getBanStep(seatCount) {
    return seatCount <= 4 ? TEAM_BAN_STEP : createCaptainBanStep(getTwoVTwoTeamCount(seatCount))
  },
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
  getPickOrder() {
    return FULL_ROSTER_3V3_PICK_ORDER
  },
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
  getPickOrder() {
    return FULL_ROSTER_4V4_PICK_ORDER
  },
})

/**
 * 5v5 Format:
 * - 3 blind bans per team (simultaneous)
 * - Captains submit bans (seat 0 = Team A captain, seat 1 = Team B captain)
 * - Pick order: 1221211212
 */
export const default5v5 = createTeamFormat({
  id: 'default-5v5',
  name: '5v5',
  gameMode: '5v5',
  getPickOrder() {
    return FULL_ROSTER_5V5_PICK_ORDER
  },
})

/**
 * 6v6 Format:
 * - 3 blind bans per team (simultaneous)
 * - Captains submit bans (seat 0 = Team A captain, seat 1 = Team B captain)
 * - Pick order: 122121122112
 */
export const default6v6 = createTeamFormat({
  id: 'default-6v6',
  name: '6v6',
  gameMode: '6v6',
  getPickOrder() {
    return FULL_ROSTER_6V6_PICK_ORDER
  },
})

const visibleBan2v2 = createTeamFormat({
  id: 'default-2v2-visible-bans',
  name: '2v2',
  gameMode: '2v2',
  blindBans: false,
  getPickOrder(seatCount) {
    return createTwoVTwoPickOrder(seatCount)
  },
})

const visibleBan3v3 = createTeamFormat({
  id: 'default-3v3-visible-bans',
  name: '3v3',
  gameMode: '3v3',
  blindBans: false,
  getPickOrder() {
    return FULL_ROSTER_3V3_PICK_ORDER
  },
})

const visibleBan4v4 = createTeamFormat({
  id: 'default-4v4-visible-bans',
  name: '4v4',
  gameMode: '4v4',
  blindBans: false,
  getPickOrder() {
    return FULL_ROSTER_4V4_PICK_ORDER
  },
})

const visibleBan5v5 = createTeamFormat({
  id: 'default-5v5-visible-bans',
  name: '5v5',
  gameMode: '5v5',
  blindBans: false,
  getPickOrder() {
    return FULL_ROSTER_5V5_PICK_ORDER
  },
})

const visibleBan6v6 = createTeamFormat({
  id: 'default-6v6-visible-bans',
  name: '6v6',
  gameMode: '6v6',
  blindBans: false,
  getPickOrder() {
    return FULL_ROSTER_6V6_PICK_ORDER
  },
})

const visibleBan1v1: DraftFormat = {
  id: 'default-1v1-visible-bans',
  name: '1v1',
  gameMode: '1v1',
  redDeath: false,
  blindBans: false,
  getSteps(_seatCount: number): DraftStep[] {
    return [
      { action: 'ban', seats: [0], count: 1, timer: SEQUENTIAL_BAN_STEP_TIMER },
      { action: 'ban', seats: [1], count: 1, timer: SEQUENTIAL_BAN_STEP_TIMER },
      { action: 'ban', seats: [0], count: 1, timer: SEQUENTIAL_BAN_STEP_TIMER },
      { action: 'ban', seats: [1], count: 1, timer: SEQUENTIAL_BAN_STEP_TIMER },
      { action: 'ban', seats: [0], count: 1, timer: SEQUENTIAL_BAN_STEP_TIMER },
      { action: 'ban', seats: [1], count: 1, timer: SEQUENTIAL_BAN_STEP_TIMER },
      { action: 'pick', seats: [0], count: 1, timer: 60 },
      { action: 'pick', seats: [1], count: 1, timer: 60 },
    ]
  },
}

const visibleBanFormats: Record<VisibleBanGameMode, DraftFormat> = {
  '1v1': visibleBan1v1,
  '2v2': visibleBan2v2,
  '3v3': visibleBan3v3,
  '4v4': visibleBan4v4,
  '5v5': visibleBan5v5,
  '6v6': visibleBan6v6,
}

/**
 * 1v1 Format:
 * - 3 blind bans each (simultaneous)
 * - Pick order: 12
 */
export const default1v1: DraftFormat = {
  id: 'default-1v1',
  name: '1v1',
  gameMode: '1v1',
  redDeath: false,
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
  redDeath: false,
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
  redDeath: false,
  blindBans: true,
  getSteps(_seatCount: number): DraftStep[] {
    return [
      FFA_BAN_STEP,
      { action: 'pick', seats: 'all', count: 1, timer: 60 },
    ]
  },
}

export const redDeath1v1 = createRedDeathFormat({
  id: 'red-death-1v1',
  name: 'Red Death 1v1',
  gameMode: '1v1',
  getPickOrder() {
    return [0, 1]
  },
})

export const redDeath2v2 = createRedDeathFormat({
  id: 'red-death-2v2',
  name: 'Red Death 2v2',
  gameMode: '2v2',
  getPickOrder(seatCount) {
    return createTwoVTwoPickOrder(seatCount)
  },
})

export const redDeath3v3 = createRedDeathFormat({
  id: 'red-death-3v3',
  name: 'Red Death 3v3',
  gameMode: '3v3',
  getPickOrder() {
    return FULL_ROSTER_3V3_PICK_ORDER
  },
})

export const redDeath4v4 = createRedDeathFormat({
  id: 'red-death-4v4',
  name: 'Red Death 4v4',
  gameMode: '4v4',
  getPickOrder() {
    return FULL_ROSTER_4V4_PICK_ORDER
  },
})

export const redDeath5v5 = createRedDeathFormat({
  id: 'red-death-5v5',
  name: 'Red Death 5v5',
  gameMode: '5v5',
  getPickOrder() {
    return FULL_ROSTER_5V5_PICK_ORDER
  },
})

export const redDeath6v6 = createRedDeathFormat({
  id: 'red-death-6v6',
  name: 'Red Death 6v6',
  gameMode: '6v6',
  getPickOrder() {
    return FULL_ROSTER_6V6_PICK_ORDER
  },
})

export const redDeathFfa = createRedDeathFormat({
  id: 'red-death-ffa',
  name: 'Red Death FFA',
  gameMode: 'ffa',
  getPickOrder(seatCount) {
    return Array.from({ length: seatCount }, (_, seatIndex) => seatIndex)
  },
})

// ── Format Registry ──────────────────────────────────────

/** All available draft formats */
export const draftFormats: DraftFormat[] = [
  defaultFfa,
  defaultFfaSimultaneous,
  default1v1,
  visibleBan1v1,
  default2v2,
  default3v3,
  default4v4,
  default5v5,
  default6v6,
  visibleBan2v2,
  visibleBan3v3,
  visibleBan4v4,
  visibleBan5v5,
  visibleBan6v6,
  redDeathFfa,
  redDeath1v1,
  redDeath2v2,
  redDeath3v3,
  redDeath4v4,
  redDeath5v5,
  redDeath6v6,
]

/** Map of format ID to format */
export const draftFormatMap = new Map<string, DraftFormat>(
  draftFormats.map(f => [f.id, f]),
)

/** Get default format for a game mode */
export function getDefaultFormat(gameMode: string): DraftFormat {
  const format = draftFormats.find(f => f.gameMode === gameMode && !f.redDeath)
  if (!format) throw new Error(`No format found for game mode: ${gameMode}`)
  return format
}

export function getDraftFormat(gameMode: string, options: { simultaneousPick?: boolean, randomDraft?: boolean, redDeath?: boolean, blindBans?: boolean, seatCount?: number } = {}): DraftFormat {
  if (options.redDeath) {
    const format = draftFormats.find(candidate => candidate.gameMode === gameMode && candidate.redDeath)
    if (!format) throw new Error(`No Red Death format found for game mode: ${gameMode}`)
    return format
  }
  if (options.blindBans === false && supportsVisibleCaptainBans(gameMode, options.seatCount)) return visibleBanFormats[gameMode]
  if (gameMode === 'ffa' && options.simultaneousPick) return defaultFfaSimultaneous
  return getDefaultFormat(gameMode)
}

export function isRedDeathFormatId(formatId: string | null | undefined): boolean {
  if (!formatId) return false
  return draftFormatMap.get(formatId)?.redDeath === true
}

export function formatDraftStepLabel(
  step: Pick<DraftStep, 'action' | 'seats'>,
  seats: DraftSeat[],
): string {
  const actionLabel = step.action.toUpperCase()
  if (step.seats === 'all') return actionLabel

  const actors = Array.from(new Set(step.seats.flatMap((seatIndex) => {
    const seat = seats[seatIndex]
    if (!seat) return []
    if (seat.team != null) return [`T${seat.team + 1}`]
    return [`P${seatIndex + 1}`]
  })))

  return actors.length > 0 ? `${actionLabel} ${actors.join(' & ')}` : actionLabel
}
