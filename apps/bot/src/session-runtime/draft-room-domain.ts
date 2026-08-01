import type {
  DraftDoublePickMetrics,
  DraftEvent,
  DraftPreviewState,
  DraftState,
  LeaderSwapRequest,
  LeaderSwapState,
  MapVoteSelection,
  RandomSource,
  RevealedMapVoteSeatBallot,
  TeamFormationState,
} from '@civup/game'
import type { DraftRuntimeConfig } from '@civup/session'
import type { DraftLifecyclePayload } from './draft-lifecycle-events.ts'
import type { MapVoteSelectionUpdateResult, StoredMapVoteState } from './map-vote-room-state.ts'
import {
  createMapVoteRng,
  DEFAULT_MAP_VOTE_SELECTION,
  draftFormatMap,
  getCurrentStep,
  isCaptainPickSupported,
  isDoublePickStep,
  isRedDeathFormatId,
  MAP_VOTE_REVEAL_DURATION_MS,
  MAP_VOTE_VOTING_DURATION_MS,
  normalizeMapVoteSelection,
  resolveMapVoteWinner,
  createTeamFormationState,
  EMPTY_TEAM_FORMATION_STATE,
} from '@civup/game'
import { createEmptyDraftPreviews, sanitizeDraftPreviews } from './draft-previews.ts'
import {
  applyMapVoteSelectionUpdate,
  EMPTY_STORED_MAP_VOTE_STATE,
  isMapVoteSelectionConfirmable,
} from './map-vote-room-state.ts'
import { pickRandomDistinct } from './random-draft.ts'
import { canOpenSwapWindowForState } from './swap-window.ts'

const ROOM_RECORD_VERSION = 1
const SWAP_WINDOW_TIMEOUT_MS = 5 * 60_000

export const ROOM_RECORD_KEY = 'room'

export interface RoomRecord {
  version: number
  config: DraftRuntimeConfig
  state: DraftState
  timerEndsAt: number | null
  alarmStepIndex: number
  completedAt: number | null
  cancelledAt: number | null
  previews: DraftPreviewState
  swapWindowOpen: boolean
  swapState: LeaderSwapState | null
  swapDisconnectFinalizeAt: number | null
  swapSafetyEndsAt: number | null
  mapVote: StoredMapVoteState
  teamFormation: TeamFormationState
  lifecycleEventSequence: number
  repeatDraft: RepeatDraftRoomSnapshot | null
  doublePickMetrics: DraftDoublePickMetrics
}

export interface RepeatDraftRoomSnapshot {
  reason: 'timeout' | 'revert'
  state: DraftState
  mapVote: StoredMapVoteState
  previews: DraftPreviewState
  doublePickMetrics: DraftDoublePickMetrics
  teamFormation: TeamFormationState
}

export type RoomEffect
  = | { type: 'set-alarm', at: number }
    | { type: 'delete-alarm' }
    | { type: 'schedule-swap-alarm' }
    | { type: 'broadcast-update', events: DraftEvent[] }
    | { type: 'sync-draft-lifecycle', payload: DraftLifecyclePayload, delivery: 'await' | 'background' }
    | { type: 'schedule-debug-active-bots', blindBans: boolean }
    | { type: 'schedule-debug-map-vote-bots' }
    | { type: 'close-connections', reason: string }

export type RoomCommand
  = | ApplyDraftResultCommand
    | UpdatePreviewsCommand
    | UpdateConfigCommand
    | ApplyLeaderSwapCommand
    | SetSwapDisconnectFinalizeAtCommand
    | ClearSwapDisconnectFinalizeAtCommand
    | FinalizeCompletedDraftCommand
    | StartMapVoteCommand
    | UpdateMapVoteSelectionCommand
    | ConfirmMapVoteCommand
    | FinishMapVoteVotingCommand
    | FinishMapVoteRevealCommand

export interface RoomTransition<TResponse = void> {
  room: RoomRecord
  effects: RoomEffect[]
  response: TResponse
}

export interface ApplyDraftResultCommand {
  type: 'apply-draft-result'
  nextState: DraftState
  events: DraftEvent[]
  now: number
  random?: RandomSource
}

export interface UpdatePreviewsCommand {
  type: 'update-previews'
  previews: DraftPreviewState
}

export interface UpdateConfigCommand {
  type: 'update-config'
  nextState: DraftState
  nextConfig: DraftRuntimeConfig
}

export interface ApplyLeaderSwapCommand {
  type: 'apply-leader-swap'
  nextState: DraftState
  swapState: LeaderSwapState
}

export interface SetSwapDisconnectFinalizeAtCommand {
  type: 'set-swap-disconnect-finalize-at'
  disconnectFinalizeAt: number
}

export interface ClearSwapDisconnectFinalizeAtCommand {
  type: 'clear-swap-disconnect-finalize-at'
}

export interface FinalizeCompletedDraftCommand {
  type: 'finalize-completed-draft'
  now: number
}

export interface StartMapVoteCommand {
  type: 'start-map-vote'
  now: number
}

export interface UpdateMapVoteSelectionCommand {
  type: 'update-map-vote-selection'
  seatIndex: number
  selection: MapVoteSelection
}

export interface ConfirmMapVoteCommand {
  type: 'confirm-map-vote'
  state: DraftState
  seatIndex: number
  now: number
}

export interface FinishMapVoteVotingCommand {
  type: 'finish-map-vote-voting'
  state: DraftState
  now: number
}

export interface FinishMapVoteRevealCommand {
  type: 'finish-map-vote-reveal'
}

export function createRoomRecord(
  config: DraftRuntimeConfig,
  state: DraftState,
  mapVote: StoredMapVoteState,
  overrides: Partial<Omit<RoomRecord, 'version' | 'config' | 'state' | 'mapVote'>> = {},
): RoomRecord {
  const format = draftFormatMap.get(config.formatId)
  const normalizedConfig = {
    ...config,
    teamFormationEnabled: config.teamFormationEnabled === true
      && !!format
      && isCaptainPickSupported(format.gameMode, state.seats.length),
  }
  return {
    version: ROOM_RECORD_VERSION,
    config: normalizedConfig,
    state,
    timerEndsAt: overrides.timerEndsAt ?? null,
    alarmStepIndex: overrides.alarmStepIndex ?? -1,
    completedAt: overrides.completedAt ?? null,
    cancelledAt: overrides.cancelledAt ?? null,
    previews: overrides.previews ?? createEmptyDraftPreviews(),
    swapWindowOpen: overrides.swapWindowOpen ?? false,
    swapState: overrides.swapState ?? null,
    swapDisconnectFinalizeAt: overrides.swapDisconnectFinalizeAt ?? null,
    swapSafetyEndsAt: overrides.swapSafetyEndsAt ?? null,
    mapVote,
    teamFormation: normalizeStoredTeamFormationState(overrides.teamFormation, normalizedConfig, state),
    lifecycleEventSequence: typeof overrides.lifecycleEventSequence === 'number' && Number.isFinite(overrides.lifecycleEventSequence)
      ? overrides.lifecycleEventSequence
      : 0,
    repeatDraft: overrides.repeatDraft ?? null,
    doublePickMetrics: normalizeDoublePickMetrics(overrides.doublePickMetrics, state),
  }
}

export function normalizeStoredRoomRecord(value: unknown): RoomRecord | null {
  if (!value || typeof value !== 'object') return null

  const raw = value as Partial<RoomRecord>
  if (!raw.config || !raw.state) return null

  return createRoomRecord(
    raw.config,
    raw.state,
    raw.mapVote && typeof raw.mapVote === 'object'
      ? raw.mapVote
      : { ...EMPTY_STORED_MAP_VOTE_STATE },
    {
      timerEndsAt: typeof raw.timerEndsAt === 'number' && Number.isFinite(raw.timerEndsAt) ? raw.timerEndsAt : null,
      alarmStepIndex: typeof raw.alarmStepIndex === 'number' && Number.isFinite(raw.alarmStepIndex) ? raw.alarmStepIndex : -1,
      completedAt: typeof raw.completedAt === 'number' && Number.isFinite(raw.completedAt) ? raw.completedAt : null,
      cancelledAt: typeof raw.cancelledAt === 'number' && Number.isFinite(raw.cancelledAt) ? raw.cancelledAt : null,
      previews: sanitizeDraftPreviews(
        raw.state,
        raw.previews ?? createEmptyDraftPreviews(),
      ),
      swapWindowOpen: raw.swapWindowOpen === true,
      swapState: raw.swapState ?? null,
      swapDisconnectFinalizeAt: typeof raw.swapDisconnectFinalizeAt === 'number' && Number.isFinite(raw.swapDisconnectFinalizeAt) ? raw.swapDisconnectFinalizeAt : null,
      swapSafetyEndsAt: typeof raw.swapSafetyEndsAt === 'number' && Number.isFinite(raw.swapSafetyEndsAt) ? raw.swapSafetyEndsAt : null,
      lifecycleEventSequence: typeof raw.lifecycleEventSequence === 'number' && Number.isFinite(raw.lifecycleEventSequence)
        ? raw.lifecycleEventSequence
        : 0,
      repeatDraft: normalizeRepeatDraftRoomSnapshot(raw.repeatDraft, raw.doublePickMetrics),
      teamFormation: normalizeStoredTeamFormationState(raw.teamFormation, raw.config, raw.state),
      doublePickMetrics: normalizeDoublePickMetrics(raw.doublePickMetrics, raw.state),
    },
  )
}

function normalizeRepeatDraftRoomSnapshot(value: unknown, fallbackMetrics?: unknown): RepeatDraftRoomSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Partial<RepeatDraftRoomSnapshot>
  if (raw.reason !== 'timeout' && raw.reason !== 'revert') return null
  if (!raw.state || typeof raw.state !== 'object') return null

  return {
    reason: raw.reason,
    state: raw.state,
    mapVote: raw.mapVote && typeof raw.mapVote === 'object'
      ? raw.mapVote
      : { ...EMPTY_STORED_MAP_VOTE_STATE },
    previews: sanitizeDraftPreviews(
      raw.state,
      raw.previews ?? createEmptyDraftPreviews(),
    ),
    doublePickMetrics: normalizeDoublePickMetrics(raw.doublePickMetrics ?? fallbackMetrics, raw.state),
    teamFormation: normalizeStoredTeamFormationState(raw.teamFormation, undefined, raw.state),
  }
}

function normalizeStoredTeamFormationState(
  value: unknown,
  config: DraftRuntimeConfig | undefined,
  state: DraftState,
): TeamFormationState {
  if (value && typeof value === 'object') {
    const raw = value as Partial<TeamFormationState>
    if (raw.enabled === true && (raw.phase === 'idle' || raw.phase === 'active' || raw.phase === 'done')) {
      const teamSeatIndices = Array.isArray(raw.teamSeatIndices) && raw.teamSeatIndices.length === 2
        ? raw.teamSeatIndices.map(team => Array.isArray(team) ? team.filter(isSeatIndex) : []) as [number[], number[]]
        : [[0], [1]] as [number[], number[]]
      const groups = Array.isArray(raw.groups)
        ? raw.groups.flatMap((group) => {
            if (!group || typeof group !== 'object' || typeof group.id !== 'string' || !Array.isArray(group.seatIndices)) return []
            return [{ id: group.id, seatIndices: group.seatIndices.filter(isSeatIndex) }]
          })
        : []
      const consumed = Array.isArray(raw.consumedByTeam) ? raw.consumedByTeam : []
      return {
        enabled: true,
        phase: raw.phase,
        revision: normalizeFormationCount(raw.revision),
        firstTeam: raw.firstTeam === 0 || raw.firstTeam === 1 ? raw.firstTeam : null,
        currentTeam: raw.currentTeam === 0 || raw.currentTeam === 1 ? raw.currentTeam : null,
        captainSeatIndices: [0, 1],
        teamSeatIndices,
        unassignedSeatIndices: Array.isArray(raw.unassignedSeatIndices) ? raw.unassignedSeatIndices.filter(isSeatIndex) : [],
        groups,
        legalGroupIds: Array.isArray(raw.legalGroupIds) ? raw.legalGroupIds.filter((id): id is string => typeof id === 'string') : [],
        consumedByTeam: [normalizeFormationCount(consumed[0]), normalizeFormationCount(consumed[1])],
        timerSeconds: normalizeFormationCount(raw.timerSeconds),
        endsAt: typeof raw.endsAt === 'number' && Number.isFinite(raw.endsAt) ? raw.endsAt : null,
        statsBySeat: raw.statsBySeat && typeof raw.statsBySeat === 'object' ? raw.statsBySeat : {},
      }
    }
  }

  if (!config?.teamFormationEnabled) return { ...EMPTY_TEAM_FORMATION_STATE }
  const format = draftFormatMap.get(config.formatId)
  if (!format || !isCaptainPickSupported(format.gameMode, state.seats.length)) return { ...EMPTY_TEAM_FORMATION_STATE }
  const timerSeconds = state.steps.find(step => step.action === 'pick')?.timer ?? 0
  const created = createTeamFormationState({
    mode: format.gameMode,
    seats: state.seats,
    partySeatIndices: config.teamFormationPartySeatIndices,
    timerSeconds,
    statsBySeat: config.teamFormationStatsBySeat,
  })
  return 'error' in created ? { ...EMPTY_TEAM_FORMATION_STATE } : created.state
}

function isSeatIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function normalizeFormationCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
}

export function applyDraftResultCommand(
  room: RoomRecord,
  command: ApplyDraftResultCommand,
): RoomTransition {
  const format = draftFormatMap.get(room.config.formatId)
  const stepAdvanced = command.events.some(
    event => event.type === 'STEP_ADVANCED' || event.type === 'DRAFT_STARTED',
  )
  const nextState = assignDealtCivIds(command.nextState, room.config, command.random)
  let nextRoom: RoomRecord = {
    ...room,
    state: nextState,
    previews: sanitizeDraftPreviews(nextState, room.previews),
  }
  nextRoom = {
    ...nextRoom,
    doublePickMetrics: applyDoublePickMetricUpdate(room.state, nextState, command.events, room.doublePickMetrics),
  }

  let alarmEffect: RoomEffect | null = null
  const effects: RoomEffect[] = []

  if (stepAdvanced && nextState.status === 'active') {
    const step = getCurrentStep(nextState)
    if (step && step.timer > 0) {
      nextRoom = {
        ...nextRoom,
        alarmStepIndex: nextState.currentStepIndex,
        timerEndsAt: command.now + step.timer * 1000,
      }
      alarmEffect = { type: 'set-alarm', at: nextRoom.timerEndsAt! }
    }
    else {
      nextRoom = {
        ...nextRoom,
        alarmStepIndex: -1,
        timerEndsAt: null,
      }
      alarmEffect = { type: 'delete-alarm' }
    }
  }

  if (nextState.status === 'complete') {
    const completedAt = nextRoom.completedAt ?? command.now
    nextRoom = {
      ...nextRoom,
      alarmStepIndex: -1,
      timerEndsAt: null,
      completedAt,
      repeatDraft: null,
    }

    if (canOpenSwapWindowForState(nextState)) {
      nextRoom = {
        ...nextRoom,
        swapWindowOpen: true,
        swapState: createEmptySwapState(),
        swapDisconnectFinalizeAt: null,
        swapSafetyEndsAt: completedAt + SWAP_WINDOW_TIMEOUT_MS,
      }
      alarmEffect = { type: 'schedule-swap-alarm' }
      const lifecycleSync = createCompleteLifecycleSync(nextRoom, {
        completedAt,
        delivery: 'await',
        kind: 'DraftCompleted',
      })
      nextRoom = lifecycleSync.room
      effects.push(
        lifecycleSync.effect,
        { type: 'broadcast-update', events: command.events },
      )
    }
    else {
      nextRoom = clearSwapWindowState(nextRoom)
      alarmEffect = { type: 'delete-alarm' }
      const lifecycleSync = createCompleteLifecycleSync(nextRoom, {
        completedAt,
        delivery: 'await',
        kind: 'DraftCompleted',
      })
      nextRoom = lifecycleSync.room
      effects.push(
        lifecycleSync.effect,
        { type: 'broadcast-update', events: command.events },
        { type: 'close-connections', reason: 'Draft closed' },
      )
    }
  }
  else if (nextState.status === 'cancelled') {
    const cancelledAt = nextRoom.cancelledAt ?? command.now
    const repeatDraft = nextState.cancelReason === 'timeout' || nextState.cancelReason === 'revert'
      ? {
          reason: nextState.cancelReason,
          state: room.state,
          mapVote: room.mapVote,
          previews: sanitizeDraftPreviews(room.state, room.previews),
          doublePickMetrics: nextRoom.doublePickMetrics,
          teamFormation: room.teamFormation,
        } satisfies RepeatDraftRoomSnapshot
      : null
    nextRoom = {
      ...clearSwapWindowState(nextRoom),
      alarmStepIndex: -1,
      timerEndsAt: null,
      cancelledAt,
      mapVote: { ...EMPTY_STORED_MAP_VOTE_STATE },
      repeatDraft,
    }
    alarmEffect = { type: 'delete-alarm' }
    const shouldReopenLobby = nextState.cancelReason === 'timeout' || nextState.cancelReason === 'revert'
    const lifecycleSync = createCancelledLifecycleSync(nextRoom, {
      cancelledAt,
      delivery: shouldReopenLobby ? 'await' : 'background',
    })
    nextRoom = lifecycleSync.room
    if (shouldReopenLobby) {
      effects.push(
        lifecycleSync.effect,
        { type: 'broadcast-update', events: command.events },
        { type: 'close-connections', reason: 'Draft closed' },
      )
    }
    else {
      effects.push(
        { type: 'broadcast-update', events: command.events },
        { type: 'close-connections', reason: 'Draft closed' },
        lifecycleSync.effect,
      )
    }
  }
  else {
    nextRoom = { ...clearSwapWindowState(nextRoom), repeatDraft: null }
    effects.push({ type: 'broadcast-update', events: command.events })
  }

  if (alarmEffect) {
    effects.unshift(alarmEffect)
  }
  if (stepAdvanced && format) {
    effects.push({ type: 'schedule-debug-active-bots', blindBans: format.blindBans })
  }

  return createTransition(nextRoom, effects)
}

export function updatePreviewsCommand(
  room: RoomRecord,
  command: UpdatePreviewsCommand,
): RoomTransition {
  return createTransition({
    ...room,
    previews: command.previews,
  }, [
    { type: 'broadcast-update', events: [] },
  ])
}

export function updateConfigCommand(
  room: RoomRecord,
  command: UpdateConfigCommand,
): RoomTransition {
  return createTransition({
    ...room,
    state: command.nextState,
    config: command.nextConfig,
    previews: sanitizeDraftPreviews(command.nextState, room.previews),
  }, [
    { type: 'broadcast-update', events: [] },
  ])
}

export function applyLeaderSwapCommand(
  room: RoomRecord,
  command: ApplyLeaderSwapCommand,
): RoomTransition {
  const nextRoom: RoomRecord = {
    ...room,
    state: command.nextState,
    swapState: command.swapState,
  }
  const effects: RoomEffect[] = [
    { type: 'schedule-swap-alarm' },
    { type: 'broadcast-update', events: [] },
  ]

  return createTransition(nextRoom, effects)
}

export function setSwapDisconnectFinalizeAtCommand(
  room: RoomRecord,
  command: SetSwapDisconnectFinalizeAtCommand,
): RoomTransition {
  return createTransition({
    ...room,
    swapDisconnectFinalizeAt: command.disconnectFinalizeAt,
  }, [
    { type: 'schedule-swap-alarm' },
  ])
}

export function clearSwapDisconnectFinalizeAtCommand(
  room: RoomRecord,
  _command: ClearSwapDisconnectFinalizeAtCommand,
): RoomTransition {
  return createTransition({
    ...room,
    swapDisconnectFinalizeAt: null,
  }, [
    { type: 'schedule-swap-alarm' },
  ])
}

export function finalizeCompletedDraftCommand(
  room: RoomRecord,
  command: FinalizeCompletedDraftCommand,
): RoomTransition<boolean> {
  if (!room.swapWindowOpen) {
    return createTransition(room, [], false)
  }

  const completedAt = room.completedAt ?? command.now
  let nextRoom: RoomRecord = {
    ...clearSwapWindowState(room),
    alarmStepIndex: -1,
    timerEndsAt: null,
    completedAt,
  }
  const lifecycleSync = createCompleteLifecycleSync(nextRoom, {
    completedAt,
    delivery: 'await',
    finalized: true,
    kind: 'DraftFinalized',
  })
  nextRoom = lifecycleSync.room

  return createTransition(nextRoom, [
    { type: 'delete-alarm' },
    lifecycleSync.effect,
    { type: 'broadcast-update', events: [] },
    { type: 'close-connections', reason: 'Draft closed' },
  ], true)
}

export function startMapVoteCommand(
  room: RoomRecord,
  command: StartMapVoteCommand,
): RoomTransition {
  const endsAt = command.now + MAP_VOTE_VOTING_DURATION_MS
  return createTransition({
    ...room,
    mapVote: {
      ...room.mapVote,
      phase: 'voting',
      endsAt,
    },
    timerEndsAt: null,
    alarmStepIndex: -1,
  }, [
    { type: 'set-alarm', at: endsAt },
    { type: 'broadcast-update', events: [] },
    { type: 'schedule-debug-map-vote-bots' },
  ])
}

export function updateMapVoteSelectionCommand(
  room: RoomRecord,
  command: UpdateMapVoteSelectionCommand,
): RoomTransition<MapVoteSelectionUpdateResult> {
  const nextMapVote = applyMapVoteSelectionUpdate(room.mapVote, command.seatIndex, command.selection)
  if (typeof nextMapVote === 'string') {
    return createTransition(room, [], nextMapVote)
  }

  return createTransition({
    ...room,
    mapVote: nextMapVote,
  }, [], nextMapVote)
}

export function confirmMapVoteCommand(
  room: RoomRecord,
  command: ConfirmMapVoteCommand,
): RoomTransition<'inactive' | 'invalid-selection' | 'ok'> {
  const mapVoteState = room.mapVote
  if (!mapVoteState.enabled || mapVoteState.phase !== 'voting') {
    return createTransition(room, [], 'inactive')
  }

  const selection = mapVoteState.selections[command.seatIndex]
  if (!isMapVoteSelectionConfirmable(selection)) {
    return createTransition(room, [], 'invalid-selection')
  }

  const nextRoom = {
    ...room,
    mapVote: {
      ...mapVoteState,
      confirmations: {
        ...mapVoteState.confirmations,
        [command.seatIndex]: true,
      },
    },
  }

  if (!command.state.seats.every((_, index) => nextRoom.mapVote.confirmations[index] === true)) {
    return createTransition(nextRoom, [
      { type: 'broadcast-update', events: [] },
    ], 'ok')
  }

  const revealTransition = buildMapVoteRevealTransition(nextRoom, command.state, command.now)
  return createTransition(revealTransition.room, revealTransition.effects, 'ok')
}

export function finishMapVoteVotingCommand(
  room: RoomRecord,
  command: FinishMapVoteVotingCommand,
): RoomTransition<boolean> {
  if (!room.mapVote.enabled || room.mapVote.phase !== 'voting') {
    return createTransition(room, [], false)
  }

  const transition = buildMapVoteRevealTransition(room, command.state, command.now)
  return createTransition(transition.room, transition.effects, true)
}

export function finishMapVoteRevealCommand(
  room: RoomRecord,
  _command: FinishMapVoteRevealCommand,
): RoomTransition<boolean> {
  if (!room.mapVote.enabled || room.mapVote.phase !== 'reveal') {
    return createTransition(room, [], false)
  }

  return createTransition({
    ...room,
    mapVote: {
      ...room.mapVote,
      phase: 'done',
      endsAt: null,
    },
  }, [], true)
}

export function createEmptySwapState(): LeaderSwapState {
  return {
    completedSwaps: [],
  }
}

export function normalizeStoredSwapState(
  value: unknown,
): LeaderSwapState {
  if (!value || typeof value !== 'object') return createEmptySwapState()

  const raw = value as {
    completedSwaps?: unknown
  }

  return {
    completedSwaps: Array.isArray(raw.completedSwaps)
      ? raw.completedSwaps.flatMap(normalizeCompletedSwapRequest)
      : [],
  }
}

export function normalizeRoomSwapState(
  room: Pick<RoomRecord, 'swapState'>,
): LeaderSwapState {
  return normalizeStoredSwapState(room.swapState)
}

function createTransition<TResponse = void>(
  room: RoomRecord,
  effects: RoomEffect[],
  response?: TResponse,
): RoomTransition<TResponse> {
  return {
    room,
    effects,
    response: response as TResponse,
  }
}

function buildMapVoteRevealTransition(room: RoomRecord, state: DraftState, now: number): RoomTransition {
  const revealedVotes = state.seats.map((_, seatIndex) => {
    const selection = room.mapVote.selections[seatIndex] ?? DEFAULT_MAP_VOTE_SELECTION
    const normalizedSelection = normalizeMapVoteSelection(selection)
    return {
      seatIndex,
      confirmed: room.mapVote.confirmations[seatIndex] === true,
      maps: [...normalizedSelection.maps],
    } satisfies RevealedMapVoteSeatBallot
  })
  const seed = buildMapVoteSeed(state.matchId, revealedVotes)
  const rng = createMapVoteRng(seed)
  const endsAt = now + MAP_VOTE_REVEAL_DURATION_MS

  return createTransition({
    ...room,
    mapVote: {
      ...room.mapVote,
      phase: 'reveal',
      endsAt,
      revealedVotes,
      result: resolveMapVoteWinner(revealedVotes, rng, seed),
    },
  }, [
    { type: 'set-alarm', at: endsAt },
    { type: 'broadcast-update', events: [] },
  ])
}

function createCompleteLifecycleSync(
  room: RoomRecord,
  options: {
    completedAt: number
    delivery: 'await' | 'background'
    finalized?: boolean
    kind: 'DraftCompleted' | 'DraftFinalized'
  },
): { room: RoomRecord, effect: RoomEffect } {
  const eventSequence = room.lifecycleEventSequence + 1
  const payload: DraftLifecyclePayload = {
    eventId: createDraftLifecycleEventId(room.state.matchId, eventSequence),
    eventKind: options.kind,
    eventSequence,
    outcome: 'complete',
    matchId: room.state.matchId,
    hostId: room.config.hostId || room.state.seats[0]?.playerId || undefined,
    leaderDataVersion: room.config.leaderDataVersion ?? 'live',
    completedAt: options.completedAt,
    finalized: options.finalized === true ? true : undefined,
    state: room.state,
    mapVoteResult: room.mapVote.result ?? null,
    civBlitz: room.config.civBlitz === true ? true : undefined,
    hiddenDraft: room.config.hiddenDraft === true ? true : undefined,
    doublePickMetrics: room.doublePickMetrics.groups > 0 ? room.doublePickMetrics : undefined,
    gameSettings: room.config.gameSettings,
  }
  return createLifecycleSyncEffect(room, payload, options.delivery)
}

function createCancelledLifecycleSync(
  room: RoomRecord,
  options: {
    cancelledAt: number
    delivery: 'await' | 'background'
  },
): { room: RoomRecord, effect: RoomEffect } {
  const eventSequence = room.lifecycleEventSequence + 1
  const payload: DraftLifecyclePayload = {
    eventId: createDraftLifecycleEventId(room.state.matchId, eventSequence),
    eventKind: 'DraftCancelled',
    eventSequence,
    outcome: 'cancelled',
    matchId: room.state.matchId,
    hostId: room.config.hostId || room.state.seats[0]?.playerId || undefined,
    leaderDataVersion: room.config.leaderDataVersion ?? 'live',
    cancelledAt: options.cancelledAt,
    reason: room.state.cancelReason ?? 'scrub',
    state: room.state,
    mapVoteResult: room.mapVote.result ?? null,
    civBlitz: room.config.civBlitz === true ? true : undefined,
    hiddenDraft: room.config.hiddenDraft === true ? true : undefined,
    doublePickMetrics: room.doublePickMetrics.groups > 0 ? room.doublePickMetrics : undefined,
    gameSettings: room.config.gameSettings,
  }
  return createLifecycleSyncEffect(room, payload, options.delivery)
}

function createLifecycleSyncEffect(
  room: RoomRecord,
  payload: DraftLifecyclePayload,
  delivery: 'await' | 'background',
): { room: RoomRecord, effect: RoomEffect } {
  return {
    room: {
      ...room,
      lifecycleEventSequence: payload.eventSequence,
    },
    effect: {
      type: 'sync-draft-lifecycle',
      payload,
      delivery,
    },
  }
}

function createDraftLifecycleEventId(matchId: string, eventSequence: number): string {
  return `${matchId}:lifecycle:${eventSequence}`
}

function applyDoublePickMetricUpdate(
  previousState: DraftState,
  nextState: DraftState,
  events: DraftEvent[],
  metrics: DraftDoublePickMetrics,
): DraftDoublePickMetrics {
  const previousStep = previousState.status === 'active'
    ? previousState.steps[previousState.currentStepIndex]
    : null
  if (!previousStep) return metrics

  let nextMetrics = metrics
  const timeoutCancelled = nextState.status === 'cancelled' && nextState.cancelReason === 'timeout'

  if (isDoublePickStep(previousState, previousStep)) {
    const nextStep = nextState.status === 'active'
      ? nextState.steps[nextState.currentStepIndex]
      : null
    if (nextStep?.fallbackForStepIndex === previousState.currentStepIndex) {
      nextMetrics = incrementDoublePickMetric(nextMetrics, 'fallbackStarted')
    }
    else if (timeoutCancelled && getPendingSeats(previousState, previousStep).length === 2) {
      nextMetrics = incrementDoublePickMetric(nextMetrics, 'bothMissedTimeouts')
    }
  }

  if (isDoublePickFallbackStep(previousStep)) {
    const resolved = nextState.status !== 'cancelled' && events.some(event => event.type === 'PICK_SUBMITTED')
    if (resolved) nextMetrics = incrementDoublePickMetric(nextMetrics, 'fallbackResolved')
    if (timeoutCancelled) nextMetrics = incrementDoublePickMetric(nextMetrics, 'fallbackTimeouts')
  }

  return nextMetrics
}

function incrementDoublePickMetric(
  metrics: DraftDoublePickMetrics,
  key: Exclude<keyof DraftDoublePickMetrics, 'groups'>,
): DraftDoublePickMetrics {
  return {
    ...metrics,
    [key]: metrics[key] + 1,
  }
}

function normalizeDoublePickMetrics(value: unknown, state: DraftState): DraftDoublePickMetrics {
  const raw = value && typeof value === 'object' ? value as Partial<DraftDoublePickMetrics> : {}
  return {
    groups: normalizeMetricCount(raw.groups, countDoublePickSteps(state)),
    fallbackStarted: normalizeMetricCount(raw.fallbackStarted, 0),
    fallbackResolved: normalizeMetricCount(raw.fallbackResolved, 0),
    bothMissedTimeouts: normalizeMetricCount(raw.bothMissedTimeouts, 0),
    fallbackTimeouts: normalizeMetricCount(raw.fallbackTimeouts, 0),
  }
}

function normalizeMetricCount(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.round(value))
}

function countDoublePickSteps(state: DraftState): number {
  return state.steps.filter(step => isDoublePickStep(state, step)).length
}

function isDoublePickFallbackStep(step: DraftState['steps'][number]): boolean {
  return step.action === 'pick' && step.fallbackForStepIndex != null
}

function getPendingSeats(state: DraftState, step: DraftState['steps'][number]): number[] {
  const activeSeats = step.seats === 'all'
    ? Array.from({ length: state.seats.length }, (_, seatIndex) => seatIndex)
    : step.seats
  return activeSeats.filter(seatIndex => (state.submissions[seatIndex]?.length ?? 0) < step.count)
}

function assignDealtCivIds(state: DraftState, config: DraftRuntimeConfig | null, random: RandomSource = Math.random): DraftState {
  if (!config || !isRedDeathDraftConfig(config)) {
    if (state.dealtCivIds == null && state.dealtCivIdsBySeat == null) return state
    return { ...state, dealtCivIds: null, dealtCivIdsBySeat: null }
  }

  if (state.status !== 'active') {
    if (state.dealtCivIds == null && state.dealtCivIdsBySeat == null) return state
    return { ...state, dealtCivIds: null, dealtCivIdsBySeat: null }
  }

  const step = getCurrentStep(state)
  if (!step || step.action !== 'pick') {
    if (state.dealtCivIds == null && state.dealtCivIdsBySeat == null) return state
    return { ...state, dealtCivIds: null, dealtCivIdsBySeat: null }
  }

  if (step.reveal) {
    if (state.dealtCivIds == null && state.dealtCivIdsBySeat == null) return state
    return { ...state, dealtCivIds: null, dealtCivIdsBySeat: null }
  }

  if (step.blind) {
    const activeSeats = step.seats === 'all'
      ? Array.from({ length: state.seats.length }, (_, seatIndex) => seatIndex)
      : step.seats
    const current = state.dealtCivIdsBySeat ?? {}
    if (activeSeats.every(seatIndex => (current[seatIndex]?.length ?? 0) > 0)) return state

    const dealSize = normalizeDealOptionsSize(config.dealOptionsSize)
    const nextBySeat: Record<number, string[]> = { ...current }
    for (const seatIndex of activeSeats) {
      if ((nextBySeat[seatIndex]?.length ?? 0) > 0) continue
      nextBySeat[seatIndex] = pickRandomDistinct(state.availableCivIds, Math.min(dealSize, state.availableCivIds.length), random)
    }

    return {
      ...state,
      dealtCivIds: null,
      dealtCivIdsBySeat: nextBySeat,
    }
  }

  if (state.dealtCivIds?.length) return state

  const dealSize = normalizeDealOptionsSize(config.dealOptionsSize)
  return {
    ...state,
    dealtCivIdsBySeat: null,
    dealtCivIds: pickRandomDistinct(state.availableCivIds, Math.min(dealSize, state.availableCivIds.length), random),
  }
}

function clearSwapWindowState(room: RoomRecord): RoomRecord {
  return {
    ...room,
    swapWindowOpen: false,
    swapState: null,
    swapDisconnectFinalizeAt: null,
    swapSafetyEndsAt: null,
  }
}

function buildMapVoteSeed(matchId: string, ballots: readonly RevealedMapVoteSeatBallot[]): string {
  const serialized = ballots
    .map(ballot => `${ballot.seatIndex}:${ballot.confirmed ? 1 : 0}:${ballot.maps.join(',')}`)
    .join('|')

  let hash = 2166136261
  for (let index = 0; index < serialized.length; index++) {
    hash ^= serialized.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }

  return `${matchId}:${hash >>> 0}`
}

function normalizeDealOptionsSize(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 2
  return Math.max(1, Math.round(value))
}

function isRedDeathDraftConfig(config: Pick<DraftRuntimeConfig, 'formatId'>): boolean {
  return isRedDeathFormatId(config.formatId)
}

function normalizeCompletedSwapRequest(value: unknown): LeaderSwapRequest[] {
  if (!value || typeof value !== 'object') return []
  const request = value as Partial<LeaderSwapRequest>
  if (!Number.isInteger(request.fromSeat) || !Number.isInteger(request.toSeat)) return []
  const fromSeat = Number(request.fromSeat)
  const toSeat = Number(request.toSeat)
  if (fromSeat < 0 || toSeat < 0) return []
  return [{ fromSeat, toSeat }]
}
