import type {
  DraftEvent,
  DraftPreviewState,
  DraftState,
  LeaderSwapRequest,
  LeaderSwapState,
  MapVoteSelection,
  PendingLeaderSwapRequest,
  RandomSource,
  RevealedMapVoteSeatBallot,
} from '@civup/game'
import type { DraftRuntimeConfig } from '@civup/session'
import type { DraftLifecyclePayload } from './draft-lifecycle-events.ts'
import type { MapVoteSelectionUpdateResult, StoredMapVoteState } from './map-vote-room-state.ts'
import {
  createMapVoteRng,
  DEFAULT_MAP_VOTE_SELECTION,
  draftFormatMap,
  getCurrentStep,
  isRedDeathFormatId,
  MAP_VOTE_REVEAL_DURATION_MS,
  MAP_VOTE_VOTING_DURATION_MS,
  normalizeMapVoteSelection,
  resolveMapVoteWinner,
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
  lifecycleEventSequence: number
}

export type RoomEffect =
  | { type: 'set-alarm', at: number }
  | { type: 'delete-alarm' }
  | { type: 'schedule-swap-alarm' }
  | { type: 'broadcast-update', events: DraftEvent[] }
  | { type: 'broadcast-swap-update', picks?: DraftState['picks'] }
  | { type: 'sync-draft-lifecycle', payload: DraftLifecyclePayload, delivery: 'await' | 'background' }
  | { type: 'schedule-debug-active-bots', blindBans: boolean }
  | { type: 'schedule-debug-map-vote-bots' }
  | { type: 'close-connections', reason: string }

export type RoomCommand =
  | ApplyDraftResultCommand
  | UpdatePreviewsCommand
  | UpdateConfigCommand
  | SetSwapStateCommand
  | AcceptSwapCommand
  | SetSwapDisconnectFinalizeAtCommand
  | ClearSwapDisconnectFinalizeAtCommand
  | PruneExpiredSwapsCommand
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

export interface SetSwapStateCommand {
  type: 'set-swap-state'
  swapState: LeaderSwapState
}

export interface AcceptSwapCommand {
  type: 'accept-swap'
  nextState: DraftState
  swapState: LeaderSwapState
  picks: DraftState['picks']
}

export interface SetSwapDisconnectFinalizeAtCommand {
  type: 'set-swap-disconnect-finalize-at'
  disconnectFinalizeAt: number
}

export interface ClearSwapDisconnectFinalizeAtCommand {
  type: 'clear-swap-disconnect-finalize-at'
}

export interface PruneExpiredSwapsCommand {
  type: 'prune-expired-swaps'
  now: number
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
  return {
    version: ROOM_RECORD_VERSION,
    config,
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
    lifecycleEventSequence: typeof overrides.lifecycleEventSequence === 'number' && Number.isFinite(overrides.lifecycleEventSequence)
      ? overrides.lifecycleEventSequence
      : 0,
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
    },
  )
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
        { type: 'broadcast-update', events: command.events },
        lifecycleSync.effect,
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
    nextRoom = {
      ...clearSwapWindowState(nextRoom),
      alarmStepIndex: -1,
      timerEndsAt: null,
      cancelledAt,
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
    nextRoom = clearSwapWindowState(nextRoom)
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

export function setSwapStateCommand(
  room: RoomRecord,
  command: SetSwapStateCommand,
): RoomTransition {
  return createTransition({
    ...room,
    swapState: command.swapState,
  }, [
    { type: 'schedule-swap-alarm' },
    { type: 'broadcast-swap-update' },
  ])
}

export function acceptSwapCommand(
  room: RoomRecord,
  command: AcceptSwapCommand,
): RoomTransition {
  let nextRoom: RoomRecord = {
    ...room,
    state: command.nextState,
    swapState: command.swapState,
  }
  const effects: RoomEffect[] = [
    { type: 'schedule-swap-alarm' },
    { type: 'broadcast-swap-update', picks: command.picks },
  ]
  if (nextRoom.completedAt != null) {
    const lifecycleSync = createCompleteLifecycleSync(nextRoom, {
      completedAt: nextRoom.completedAt,
      delivery: 'await',
      kind: 'SwapAccepted',
    })
    nextRoom = lifecycleSync.room
    effects.push(lifecycleSync.effect)
  }

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

export function pruneExpiredSwapsCommand(
  room: RoomRecord,
  command: PruneExpiredSwapsCommand,
): RoomTransition<boolean> {
  const swapState = normalizeRoomSwapState(room)
  const pendingSwaps = swapState.pendingSwaps.filter(swap => swap.expiresAt > command.now)
  if (pendingSwaps.length === swapState.pendingSwaps.length) {
    return createTransition(room, [], false)
  }

  return createTransition({
    ...room,
    swapState: {
      pendingSwaps,
      completedSwaps: swapState.completedSwaps,
    },
  }, [
    { type: 'broadcast-swap-update' },
  ], true)
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
    pendingSwaps: [],
    completedSwaps: [],
  }
}

export function normalizeStoredSwapState(
  value: unknown,
): LeaderSwapState {
  if (!value || typeof value !== 'object') return createEmptySwapState()

  const raw = value as {
    pendingSwaps?: unknown
    completedSwaps?: unknown
  }

  return {
    pendingSwaps: Array.isArray(raw.pendingSwaps)
      ? raw.pendingSwaps.flatMap(normalizePendingSwapRequest)
      : [],
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
      mapTypes: [...normalizedSelection.mapTypes],
      mapScripts: [...normalizedSelection.mapScripts],
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
    kind: 'DraftCompleted' | 'SwapAccepted' | 'DraftFinalized'
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
    completedAt: options.completedAt,
    finalized: options.finalized === true ? true : undefined,
    state: room.state,
    mapVoteResult: room.mapVote.result ?? null,
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
    cancelledAt: options.cancelledAt,
    reason: room.state.cancelReason ?? 'scrub',
    state: room.state,
    mapVoteResult: room.mapVote.result ?? null,
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

function assignDealtCivIds(state: DraftState, config: DraftRuntimeConfig | null, random: RandomSource = Math.random): DraftState {
  if (!config || !isRedDeathDraftConfig(config)) {
    if (state.dealtCivIds == null) return state
    return { ...state, dealtCivIds: null }
  }

  if (state.status !== 'active') {
    if (state.dealtCivIds == null) return state
    return { ...state, dealtCivIds: null }
  }

  const step = getCurrentStep(state)
  if (!step || step.action !== 'pick') {
    if (state.dealtCivIds == null) return state
    return { ...state, dealtCivIds: null }
  }

  if (state.dealtCivIds?.length) return state

  const dealSize = normalizeDealOptionsSize(config.dealOptionsSize)
  return {
    ...state,
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
    .map(ballot => `${ballot.seatIndex}:${ballot.confirmed ? 1 : 0}:${ballot.mapTypes.join(',')}:${ballot.mapScripts.join(',')}`)
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

function normalizePendingSwapRequest(value: unknown): PendingLeaderSwapRequest[] {
  if (!value || typeof value !== 'object') return []
  const request = value as Partial<PendingLeaderSwapRequest>
  if (!Number.isInteger(request.fromSeat) || !Number.isInteger(request.toSeat) || !Number.isFinite(request.expiresAt)) return []
  const fromSeat = Number(request.fromSeat)
  const toSeat = Number(request.toSeat)
  const expiresAt = Number(request.expiresAt)
  if (fromSeat < 0 || toSeat < 0) return []
  return [{ fromSeat, toSeat, expiresAt }]
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
