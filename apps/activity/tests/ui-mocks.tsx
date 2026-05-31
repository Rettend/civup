/** @jsxImportSource solid-js */

import type { CivBlitzPartialKit, DraftState, LeaderDataVersion, MapScriptId, MapTypeId, MapVoteMapId, RankedChoiceRound, RevealedMapVoteSeatBallot } from '@civup/game'
import type { LeaderTagCategory } from '../src/client/lib/leader-tags'
import type { LobbyArrangeStrategy, LobbySnapshot, RankedRoleOptionSnapshot } from '../src/client/stores'
import { getPickSeatForPlayer } from '@civup/game'
import { mock } from 'bun:test'
import { createMutable } from 'solid-js/store'
import { getTagCategory } from '../src/client/lib/leader-tags'

export const storeSpies = {
  sendStart: mock(() => true),
  sendCancel: mock(() => {}),
  sendScrub: mock(() => true),
  sendRevert: mock(() => true),
  sendBan: mock((_civIds: string[]) => {}),
  sendPick: mock((_civId: string) => {}),
  sendCivBlitzSubmit: mock((_kit: CivBlitzPartialKit) => {}),
  sendPreview: mock((_kind: 'ban' | 'pick', _civIds: string[]) => {}),
  sendMapVoteConfirm: mock(() => true),
  sendMapVoteSelection: mock((_selection: { maps: MapVoteMapId[] }) => true),
  sendLeaderSwap: mock((_seatIndex: number) => {}),
  updateDraftSteamLobbyLink: mock((steamLobbyLink: string | null) => {
    uiMockState.steamLobbyLink = steamLobbyLink
  }),
  reportMatchResult: mock(async (_matchId: string, _reporterId: string, _placements: string, _leaderAssignments?: Record<string, string>) => ({ ok: true })),
  scrubMatchResult: mock(async () => ({ ok: true })),
  toggleFfaPlacement: mock((seatIndex: number) => {
    const existingIndex = uiMockState.ffaPlacementOrder.indexOf(seatIndex)
    if (existingIndex >= 0) uiMockState.ffaPlacementOrder.splice(existingIndex, 1)
    else uiMockState.ffaPlacementOrder.push(seatIndex)
  }),
  toggleTeamPlacement: mock((team: number) => {
    const existingIndex = uiMockState.teamPlacementOrder.indexOf(team)
    if (existingIndex >= 0) uiMockState.teamPlacementOrder.splice(existingIndex, 1)
    else uiMockState.teamPlacementOrder.push(team)
  }),
  arrangeLobbySlots: mock(async (_mode: string, _lobbyId: string, _userId: string, _strategy: LobbyArrangeStrategy) => uiMockState.arrangeLobbySlotsResult),
  cancelLobby: mock(async (_mode: string, _lobbyId: string, _userId: string) => uiMockState.cancelLobbyResult),
  canFillLobbyWithTestPlayers: mock(async (_mode: string) => uiMockState.canFillLobbyWithTestPlayersResult),
  fetchLobbyRankedRoles: mock(async (_mode: string, _lobbyId: string) => uiMockState.fetchLobbyRankedRolesResult),
  fillLobbyWithTestPlayers: mock(async (_mode: string, _lobbyId: string, _userId: string) => uiMockState.fillLobbyWithTestPlayersResult),
  placeLobbySlot: mock(async (_mode: string, _payload: { lobbyId: string, userId: string, targetSlot: number, playerId?: string, displayName?: string, avatarUrl?: string | null }) => uiMockState.placeLobbySlotResult),
  removeLobbySlot: mock(async (_mode: string, _payload: { lobbyId: string, userId: string, slot: number }) => uiMockState.removeLobbySlotResult),
  transferLobbyHost: mock(async (_mode: string, _payload: { lobbyId: string, userId: string, targetPlayerId: string }) => uiMockState.transferLobbyHostResult),
  repeatLobbyDraft: mock(async (_mode: string, _lobbyId: string, _userId: string) => uiMockState.repeatLobbyDraftResult),
  startLobbyDraft: mock(async (_mode: string, _lobbyId: string, _userId: string) => uiMockState.startLobbyDraftResult),
  updateLobbyConfig: mock(async (_mode: string, _lobbyId: string, _userId: string, patch: Record<string, unknown>) => {
    const result = uiMockState.updateLobbyConfigResult
    if (!result.ok) return result
    return { ok: true, lobby: mockLobbySnapshotFromConfigPatch(patch) }
  }),
  updateLobbyMode: mock(async (_mode: string, _lobbyId: string, _userId: string, _nextMode: string) => uiMockState.updateLobbyModeResult),
}

export const discordSpies = {
  openExternalLink: mock(async () => ({ opened: true })),
}

export const clipboardSpies = {
  copyTextToClipboard: mock(async () => true),
}

interface MockState {
  userId: string | null
  displayName: string
  avatarUrl: string | null
  isMiniView: boolean
  isMobileLayout: boolean
  isCivBlitzDraft: boolean
  isRedDeathDraft: boolean
  isSpectator: boolean
  connectionStatus: ConnectionStatus
  connectionError: string | null
  draftState: DraftState | null
  draftHostId: string | null
  draftSeatIndex: number | null
  draftLeaderDataVersion: LeaderDataVersion
  timerEndsAt: number | null
  gridOpen: boolean
  gridExpanded: boolean
  gridViewMode: 'grid' | 'multi-list' | 'list'
  resultSelectionsLocked: boolean
  selectedWinningTeam: number | null
  selectedLeaderId: string | null
  detailLeaderId: string | null
  pickSelections: string[]
  banSelections: string[]
  banSelectionStepToken: string | null
  isRandomSelected: boolean
  favoriteLeaderIds: string[]
  ffaPlacementOrder: number[]
  teamPlacementOrder: number[]
  hiddenDraftLeaderSelections: string[]
  canOpenLeaderGrid: boolean
  canSendPickPreview: boolean
  sendStartResult: boolean
  mapVoteEnabled: boolean
  mapVotePhase: 'idle' | 'voting' | 'reveal' | 'done'
  mapVoteSelectedMaps: MapVoteMapId[]
  mapVoteHasConfirmed: boolean
  mapVoteConfirmedSeatIndices: number[]
  mapVoteSeatVotes: RevealedMapVoteSeatBallot[]
  mapVoteWinningType: MapTypeId | null
  mapVoteWinningScript: MapScriptId | null
  mapVoteWinningTypeCandidate: MapTypeId | null
  mapVoteWinningScriptCandidate: MapScriptId | null
  mapVoteTypeRounds: RankedChoiceRound<MapTypeId>[]
  mapVoteScriptRounds: RankedChoiceRound<MapScriptId>[]
  mapVoteVotingEndsAt: number | null
  mapVoteRevealEndsAt: number | null
  searchQuery: string
  previewPicks: Record<number, string | null>
  draftPreviewBans: Record<number, string[]>
  draftPreviewPicks: Record<number, string[]>
  steamLobbyLink: string | null
  permanentAlly: boolean
  canSwapLeaderSeatIndices: number[]
  swapFlashSeatIndices: number[]
  swapWindowOpen: boolean
  tagFiltersState: Record<LeaderTagCategory, string[]>
  arrangeLobbySlotsResult: { ok: true } | { ok: false, error: string }
  cancelLobbyResult: { ok: true } | { ok: false, error: string }
  canFillLobbyWithTestPlayersResult: boolean
  fetchLobbyRankedRolesResult: { options: RankedRoleOptionSnapshot[] } | null
  fillLobbyWithTestPlayersResult: { ok: true, addedCount: number } | { ok: false, error: string }
  placeLobbySlotResult: { ok: true, lobby: LobbySnapshot, transferNotice: string | null } | { ok: false, error: string }
  removeLobbySlotResult: { ok: true, lobby: LobbySnapshot } | { ok: false, error: string }
  transferLobbyHostResult: { ok: true, lobby: LobbySnapshot } | { ok: false, error: string }
  repeatLobbyDraftResult: { ok: true, kind: 'resume' | 'complete', matchId: string, sessionAccessToken: string | null } | { ok: false, error: string }
  startLobbyDraftResult: { ok: true, matchId: string, sessionAccessToken: string | null } | { ok: false, error: string }
  updateLobbyConfigResult: { ok: true } | { ok: false, error: string }
  updateLobbyModeResult: { ok: true } | { ok: false, error: string }
}

function emptyTagFilters(): Record<LeaderTagCategory, string[]> {
  return {
    econ: [],
    win: [],
    spike: [],
    role: [],
    other: [],
  }
}

function mockLobbySnapshot(): LobbySnapshot {
  return {
    id: 'lobby-1',
    revision: 1,
    mode: 'ffa',
    hostId: 'host-1',
    status: 'open',
    steamLobbyLink: 'steam://joinlobby/289070/example',
    minRole: null,
    maxRole: null,
    lastArrange: null,
    entries: [],
    minPlayers: 2,
    targetSize: 4,
    draftConfig: {
      banTimerSeconds: 60,
      pickTimerSeconds: 90,
      leaderPoolSize: 6,
      leaderDataVersion: 'live',
      mapVoteEnabled: false,
      blindBans: true,
      blindPicks: false,
      simultaneousPick: false,
      redDeath: false,
      permanentAlly: true,
      dealOptionsSize: null,
      civBlitz: false,
      civBlitzOptionCount: 4,
      civBlitzExcludeBbgExpanded: true,
      randomDraft: false,
      hiddenDraft: false,
      duplicateFactions: false,
    },
    serverDefaults: {
      banTimerSeconds: 60,
      pickTimerSeconds: 90,
    },
  }
}

function mockLobbySnapshotFromConfigPatch(patch: Record<string, unknown>): LobbySnapshot {
  const snapshot = mockLobbySnapshot()
  return {
    ...snapshot,
    revision: snapshot.revision + 1,
    steamLobbyLink: typeof patch.steamLobbyLink === 'string' || patch.steamLobbyLink === null ? patch.steamLobbyLink : snapshot.steamLobbyLink,
    minRole: patch.minRole === null || typeof patch.minRole === 'string' ? patch.minRole as LobbySnapshot['minRole'] : snapshot.minRole,
    maxRole: patch.maxRole === null || typeof patch.maxRole === 'string' ? patch.maxRole as LobbySnapshot['maxRole'] : snapshot.maxRole,
    targetSize: typeof patch.targetSize === 'number' ? patch.targetSize : snapshot.targetSize,
    draftConfig: {
      ...snapshot.draftConfig,
      banTimerSeconds: typeof patch.banTimerSeconds === 'number' || patch.banTimerSeconds === null ? patch.banTimerSeconds : snapshot.draftConfig.banTimerSeconds,
      pickTimerSeconds: typeof patch.pickTimerSeconds === 'number' || patch.pickTimerSeconds === null ? patch.pickTimerSeconds : snapshot.draftConfig.pickTimerSeconds,
      leaderPoolSize: typeof patch.leaderPoolSize === 'number' || patch.leaderPoolSize === null ? patch.leaderPoolSize : snapshot.draftConfig.leaderPoolSize,
      leaderDataVersion: patch.leaderDataVersion === 'beta' || patch.leaderDataVersion === 'live' ? patch.leaderDataVersion : snapshot.draftConfig.leaderDataVersion,
      mapVoteEnabled: typeof patch.mapVoteEnabled === 'boolean' ? patch.mapVoteEnabled : snapshot.draftConfig.mapVoteEnabled,
      blindBans: typeof patch.blindBans === 'boolean' ? patch.blindBans : snapshot.draftConfig.blindBans,
      blindPicks: typeof patch.blindPicks === 'boolean' ? patch.blindPicks : snapshot.draftConfig.blindPicks,
      simultaneousPick: typeof patch.simultaneousPick === 'boolean' ? patch.simultaneousPick : snapshot.draftConfig.simultaneousPick,
      permanentAlly: typeof patch.permanentAlly === 'boolean' ? patch.permanentAlly : snapshot.draftConfig.permanentAlly,
      redDeath: typeof patch.redDeath === 'boolean' ? patch.redDeath : snapshot.draftConfig.redDeath,
      dealOptionsSize: typeof patch.dealOptionsSize === 'number' || patch.dealOptionsSize === null ? patch.dealOptionsSize : snapshot.draftConfig.dealOptionsSize,
      randomDraft: typeof patch.randomDraft === 'boolean' ? patch.randomDraft : snapshot.draftConfig.randomDraft,
      hiddenDraft: typeof patch.hiddenDraft === 'boolean' ? patch.hiddenDraft : snapshot.draftConfig.hiddenDraft,
      duplicateFactions: typeof patch.duplicateFactions === 'boolean' ? patch.duplicateFactions : snapshot.draftConfig.duplicateFactions,
      closed: typeof patch.closed === 'boolean' ? patch.closed : snapshot.draftConfig.closed,
    },
  }
}

function defaults(): MockState {
  return {
    userId: 'host-1',
    displayName: 'Host Player',
    avatarUrl: null,
    isMiniView: false,
    isMobileLayout: false,
    isCivBlitzDraft: false,
    isRedDeathDraft: false,
    isSpectator: false,
    connectionStatus: 'connected',
    connectionError: null,
    draftState: null,
    draftHostId: 'host-1',
    draftSeatIndex: 0,
    draftLeaderDataVersion: 'live',
    timerEndsAt: null,
    gridOpen: false,
    gridExpanded: false,
    gridViewMode: 'grid',
    resultSelectionsLocked: false,
    selectedWinningTeam: null,
    selectedLeaderId: null,
    detailLeaderId: null,
    pickSelections: [],
    banSelections: [],
    banSelectionStepToken: null,
    isRandomSelected: false,
    favoriteLeaderIds: [],
    ffaPlacementOrder: [],
    teamPlacementOrder: [],
    hiddenDraftLeaderSelections: [],
    canOpenLeaderGrid: true,
    canSendPickPreview: false,
    sendStartResult: true,
    mapVoteEnabled: true,
    mapVotePhase: 'idle',
    mapVoteSelectedMaps: [],
    mapVoteHasConfirmed: false,
    mapVoteConfirmedSeatIndices: [],
    mapVoteSeatVotes: [],
    mapVoteWinningType: null,
    mapVoteWinningScript: null,
    mapVoteWinningTypeCandidate: null,
    mapVoteWinningScriptCandidate: null,
    mapVoteTypeRounds: [],
    mapVoteScriptRounds: [],
    mapVoteVotingEndsAt: null,
    mapVoteRevealEndsAt: null,
    searchQuery: '',
    previewPicks: {},
    draftPreviewBans: {},
    draftPreviewPicks: {},
    steamLobbyLink: null,
    permanentAlly: false,
    canSwapLeaderSeatIndices: [],
    swapFlashSeatIndices: [],
    swapWindowOpen: false,
    tagFiltersState: emptyTagFilters(),
    arrangeLobbySlotsResult: { ok: true },
    cancelLobbyResult: { ok: true },
    canFillLobbyWithTestPlayersResult: false,
    fetchLobbyRankedRolesResult: null,
    fillLobbyWithTestPlayersResult: { ok: true, addedCount: 0 },
    placeLobbySlotResult: { ok: true, lobby: mockLobbySnapshot(), transferNotice: null },
    removeLobbySlotResult: { ok: true, lobby: mockLobbySnapshot() },
    transferLobbyHostResult: { ok: true, lobby: mockLobbySnapshot() },
    repeatLobbyDraftResult: { ok: true, kind: 'complete', matchId: 'match-1', sessionAccessToken: 'session-token' },
    startLobbyDraftResult: { ok: true, matchId: 'match-1', sessionAccessToken: 'session-token' },
    updateLobbyConfigResult: { ok: true },
    updateLobbyModeResult: { ok: true },
  }
}

export const uiMockState: MockState = createMutable(defaults())

export function resetUiMocks() {
  Object.assign(uiMockState, defaults())
  uiMockState.gridOpen = false
  uiMockState.gridExpanded = false
  uiMockState.gridViewMode = 'grid'
  uiMockState.resultSelectionsLocked = false
  uiMockState.selectedWinningTeam = null
  uiMockState.selectedLeaderId = null
  uiMockState.detailLeaderId = null
  uiMockState.pickSelections = []
  uiMockState.banSelections = []
  uiMockState.banSelectionStepToken = null
  uiMockState.isRandomSelected = false
  uiMockState.favoriteLeaderIds = []
  uiMockState.ffaPlacementOrder = []
  uiMockState.teamPlacementOrder = []
  uiMockState.hiddenDraftLeaderSelections = []
  uiMockState.canOpenLeaderGrid = true
  uiMockState.canSendPickPreview = false
  uiMockState.sendStartResult = true
  uiMockState.mapVoteEnabled = true
  uiMockState.mapVotePhase = 'idle'
  uiMockState.mapVoteSelectedMaps = []
  uiMockState.mapVoteHasConfirmed = false
  uiMockState.mapVoteConfirmedSeatIndices = []
  uiMockState.mapVoteSeatVotes = []
  uiMockState.mapVoteWinningType = null
  uiMockState.mapVoteWinningScript = null
  uiMockState.mapVoteWinningTypeCandidate = null
  uiMockState.mapVoteWinningScriptCandidate = null
  uiMockState.mapVoteTypeRounds = []
  uiMockState.mapVoteScriptRounds = []
  uiMockState.mapVoteVotingEndsAt = null
  uiMockState.mapVoteRevealEndsAt = null
  uiMockState.searchQuery = ''
  uiMockState.previewPicks = {}
  uiMockState.draftPreviewBans = {}
  uiMockState.draftPreviewPicks = {}
  uiMockState.steamLobbyLink = null
  uiMockState.canSwapLeaderSeatIndices = []
  uiMockState.swapFlashSeatIndices = []
  uiMockState.swapWindowOpen = false
  uiMockState.tagFiltersState = emptyTagFilters()
  for (const spy of Object.values(discordSpies)) spy.mockClear()
  for (const spy of Object.values(clipboardSpies)) spy.mockClear()
  for (const spy of Object.values(storeSpies)) spy.mockClear()
  storeSpies.sendStart.mockImplementation(() => uiMockState.sendStartResult)
  storeSpies.sendScrub.mockImplementation(() => true)
  storeSpies.sendRevert.mockImplementation(() => true)
}

function currentStep() {
  const state = uiMockState.draftState
  if (!state || state.status !== 'active') return null
  return state.steps[state.currentStepIndex] ?? null
}

function currentPickTargetSeatIndex() {
  const state = uiMockState.draftState
  const seatIndex = uiMockState.draftSeatIndex
  if (!state || seatIndex == null) return null
  return getPickSeatForPlayer(state, seatIndex)
}

function isMyOwnPickTurn() {
  const step = currentStep()
  const seatIndex = uiMockState.draftSeatIndex
  const targetSeatIndex = currentPickTargetSeatIndex()
  return Boolean(step?.action === 'pick' && seatIndex != null && targetSeatIndex != null && targetSeatIndex === seatIndex)
}

function isMyTurn() {
  const state = uiMockState.draftState
  const step = currentStep()
  const seatIndex = uiMockState.draftSeatIndex
  if (!state || !step || seatIndex == null) return false
  if (step.action === 'pick') return currentPickTargetSeatIndex() != null
  if (step.seats === 'all') return true
  return step.seats.includes(seatIndex)
}

function hasSubmitted() {
  const state = uiMockState.draftState
  const seatIndex = uiMockState.draftSeatIndex
  if (!state || seatIndex == null) return false
  const step = currentStep()
  if (!step) return false

  const targetSeatIndex = step.action === 'pick'
    ? currentPickTargetSeatIndex() ?? seatIndex
    : seatIndex

  return (state.submissions[targetSeatIndex]?.length ?? 0) >= step.count
}

function phaseLabel() {
  const state = uiMockState.draftState
  if (!state) return 'Draft'
  if (state.status === 'waiting') return 'Draft Setup'
  if (state.status === 'complete') return 'Draft Complete'
  if (state.status === 'cancelled') return 'Draft Cancelled'
  return currentStep()?.action === 'ban' ? 'Ban Phase' : 'Pick Phase'
}

function phaseAccent() {
  return currentStep()?.action === 'ban' ? 'red' : 'gold'
}

function phaseAccentColor() {
  return phaseAccent() === 'red' ? 'var(--danger)' : 'var(--accent)'
}

function setPickSelections(next: string[]) {
  uiMockState.pickSelections = [...next]
  uiMockState.selectedLeaderId = uiMockState.pickSelections[0] ?? null
}

function clearSelections() {
  setPickSelections([])
  uiMockState.banSelections = []
  uiMockState.banSelectionStepToken = null
  uiMockState.isRandomSelected = false
  uiMockState.searchQuery = ''
  uiMockState.tagFiltersState = emptyTagFilters()
  uiMockState.detailLeaderId = null
  uiMockState.selectedWinningTeam = null
  uiMockState.ffaPlacementOrder = []
  uiMockState.teamPlacementOrder = []
  uiMockState.hiddenDraftLeaderSelections = []
}

function clearHiddenDraftLeaderSelections() {
  uiMockState.hiddenDraftLeaderSelections = []
}

function toggleHiddenDraftLeaderSelection(leaderId: string) {
  uiMockState.hiddenDraftLeaderSelections = uiMockState.hiddenDraftLeaderSelections.includes(leaderId)
    ? uiMockState.hiddenDraftLeaderSelections.filter(current => current !== leaderId)
    : [...uiMockState.hiddenDraftLeaderSelections, leaderId]
}

function phaseHeaderBg() {
  return 'bg-bg-subtle'
}

function currentStepDuration() {
  return currentStep()?.timer ?? 0
}

function getSeatMapVote(seatIndex: number) {
  return uiMockState.mapVoteSeatVotes.find(vote => vote.seatIndex === seatIndex) ?? null
}

function isMapVotePhase() {
  return uiMockState.mapVotePhase === 'voting' || uiMockState.mapVotePhase === 'reveal'
}

function toggleRankedChoice<T extends string>(current: readonly T[], next: T, max: number): T[] {
  const existingIndex = current.indexOf(next)
  if (existingIndex >= 0) return current.filter(value => value !== next)
  if (current.length >= max) return [...current]
  return [...current, next]
}

function mapVoteReadyToConfirm() {
  return uiMockState.mapVotePhase === 'voting'
    && uiMockState.draftSeatIndex != null
    && uiMockState.mapVoteSelectedMaps.length > 0
    && !uiMockState.mapVoteHasConfirmed
}

function startMapVote(_matchId: string) {
  if (uiMockState.mapVotePhase !== 'idle') return
  uiMockState.mapVotePhase = 'voting'
  uiMockState.mapVoteSelectedMaps = []
  uiMockState.mapVoteHasConfirmed = false
  uiMockState.mapVoteConfirmedSeatIndices = []
  uiMockState.mapVoteSeatVotes = []
  uiMockState.mapVoteWinningType = null
  uiMockState.mapVoteWinningScript = null
  uiMockState.mapVoteWinningTypeCandidate = null
  uiMockState.mapVoteWinningScriptCandidate = null
  uiMockState.mapVoteTypeRounds = []
  uiMockState.mapVoteScriptRounds = []
  uiMockState.mapVoteVotingEndsAt = Date.now() + 90_000
  uiMockState.mapVoteRevealEndsAt = null
}

function confirmMapVote() {
  if (!mapVoteReadyToConfirm()) return false
  uiMockState.mapVoteHasConfirmed = true
  if (uiMockState.draftSeatIndex != null && !uiMockState.mapVoteConfirmedSeatIndices.includes(uiMockState.draftSeatIndex)) {
    uiMockState.mapVoteConfirmedSeatIndices = [...uiMockState.mapVoteConfirmedSeatIndices, uiMockState.draftSeatIndex].sort((left, right) => left - right)
  }
  return storeSpies.sendMapVoteConfirm()
}

function finishMapVote() {
  if (uiMockState.mapVotePhase !== 'reveal') return
  uiMockState.mapVotePhase = 'done'
  uiMockState.mapVoteVotingEndsAt = null
  uiMockState.mapVoteRevealEndsAt = null
}

function resetMapVote() {
  uiMockState.mapVotePhase = 'idle'
  uiMockState.mapVoteSelectedMaps = []
  uiMockState.mapVoteHasConfirmed = false
  uiMockState.mapVoteConfirmedSeatIndices = []
  uiMockState.mapVoteSeatVotes = []
  uiMockState.mapVoteWinningType = null
  uiMockState.mapVoteWinningScript = null
  uiMockState.mapVoteWinningTypeCandidate = null
  uiMockState.mapVoteWinningScriptCandidate = null
  uiMockState.mapVoteTypeRounds = []
  uiMockState.mapVoteScriptRounds = []
  uiMockState.mapVoteVotingEndsAt = null
  uiMockState.mapVoteRevealEndsAt = null
}

mock.module('~/client/discord', () => ({
  discordSdk: {
    commands: {
      openExternalLink: (...args: Parameters<typeof discordSpies.openExternalLink>) => discordSpies.openExternalLink(...args),
    },
  },
}))

mock.module('~/client/lib/clipboard', () => ({
  copyTextToClipboard: (...args: Parameters<typeof clipboardSpies.copyTextToClipboard>) => clipboardSpies.copyTextToClipboard(...args),
}))

mock.module('~/client/stores', () => ({
  BLIND_PICK_SUBMISSION_PLACEHOLDER: '__blind__',
  MAP_VOTE_REVEAL_DURATION_SECONDS: 10,
  MAP_VOTE_VOTING_DURATION_SECONDS: 90,
  activeTagFilterCount: () => Object.values(uiMockState.tagFiltersState).reduce((count, tags) => count + tags.length, 0),
  arrangeLobbySlots: (...args: Parameters<typeof storeSpies.arrangeLobbySlots>) => storeSpies.arrangeLobbySlots(...args),
  banSelectionStepToken: () => uiMockState.banSelectionStepToken,
  banSelections: () => uiMockState.banSelections,
  clearLeaderFavorites: () => { uiMockState.favoriteLeaderIds = [] },
  clearHiddenDraftLeaderSelections,
  clearWinningTeam: () => { uiMockState.selectedWinningTeam = null },
  cancelLobby: (...args: Parameters<typeof storeSpies.cancelLobby>) => storeSpies.cancelLobby(...args),
  canFillLobbyWithTestPlayers: (...args: Parameters<typeof storeSpies.canFillLobbyWithTestPlayers>) => storeSpies.canFillLobbyWithTestPlayers(...args),
  canSwapLeadersWith: (seatIndex: number) => uiMockState.canSwapLeaderSeatIndices.includes(seatIndex),
  canSendPickPreview: () => uiMockState.canSendPickPreview,
  avatarUrl: () => uiMockState.avatarUrl,
  canOpenLeaderGrid: () => uiMockState.canOpenLeaderGrid,
  clearSelections,
  clearTagFilters: () => { uiMockState.tagFiltersState = emptyTagFilters() },
  clearFfaPlacements: () => { uiMockState.ffaPlacementOrder = [] },
  clearResultSelections: () => {
    uiMockState.selectedWinningTeam = null
    uiMockState.ffaPlacementOrder = []
    uiMockState.teamPlacementOrder = []
  },
  connectionError: () => uiMockState.connectionError,
  connectionStatus: () => uiMockState.connectionStatus,
  currentPickTargetSeatIndex,
  currentStep,
  currentStepDuration,
  dealtCivIds: () => [],
  detailLeaderId: () => uiMockState.detailLeaderId,
  displayName: () => uiMockState.displayName,
  draftNow: (localNow = Date.now()) => localNow,
  draftStore: {
    get state() {
      return uiMockState.draftState
    },
    get hostId() {
      return uiMockState.draftHostId
    },
    get seatIndex() {
      return uiMockState.draftSeatIndex
    },
    get timerEndsAt() {
      return uiMockState.timerEndsAt
    },
    get leaderDataVersion() {
      return uiMockState.draftLeaderDataVersion
    },
    get mapVote() {
      const hasResult = uiMockState.mapVoteWinningType != null && uiMockState.mapVoteWinningScript != null
      return {
        endsAt: uiMockState.mapVotePhase === 'voting'
          ? uiMockState.mapVoteVotingEndsAt
          : uiMockState.mapVotePhase === 'reveal'
            ? uiMockState.mapVoteRevealEndsAt
            : null,
        result: hasResult
          ? {
              mapType: uiMockState.mapVoteWinningType!,
              mapScript: uiMockState.mapVoteWinningScript!,
              winningSeatCount: 0,
              seed: 'mock-seed',
              mapTypeWinner: uiMockState.mapVoteWinningTypeCandidate ?? uiMockState.mapVoteWinningType!,
              mapScriptWinner: uiMockState.mapVoteWinningScriptCandidate ?? uiMockState.mapVoteWinningScript!,
              mapTypeRounds: uiMockState.mapVoteTypeRounds,
              mapScriptRounds: uiMockState.mapVoteScriptRounds,
              resolvedRandomMapType: null,
              resolvedRandomMapScript: null,
            }
          : null,
      }
    },
    get previews() {
      return {
        bans: uiMockState.draftPreviewBans,
        picks: uiMockState.draftPreviewPicks,
      }
    },
    get steamLobbyLink() {
      return uiMockState.steamLobbyLink ?? mockLobbySnapshot().steamLobbyLink
    },
    get permanentAlly() {
      return uiMockState.permanentAlly
    },
    swapState: null,
    initVersion: 1,
  },
  favoriteLeaderIds: () => uiMockState.favoriteLeaderIds,
  fetchLobbyRankedRoles: (...args: Parameters<typeof storeSpies.fetchLobbyRankedRoles>) => storeSpies.fetchLobbyRankedRoles(...args),
  ffaPlacementOrder: () => uiMockState.ffaPlacementOrder,
  fillLobbyWithTestPlayers: (...args: Parameters<typeof storeSpies.fillLobbyWithTestPlayers>) => storeSpies.fillLobbyWithTestPlayers(...args),
  finishMapVote,
  getSeatMapVote,
  getOptimisticSeatPick: () => null,
  getPreviewPickForSeat: (seatIndex: number) => uiMockState.previewPicks[seatIndex] ?? null,
  gridOpen: () => uiMockState.gridOpen,
  gridExpanded: () => uiMockState.gridExpanded,
  gridViewMode: () => uiMockState.gridViewMode,
  hasSubmitted,
  hiddenDraftLeaderSelections: () => uiMockState.hiddenDraftLeaderSelections,
  isHiddenDraftComplete: () => false,
  isCivBlitzDraft: () => uiMockState.isCivBlitzDraft,
  isMiniView: () => uiMockState.isMiniView,
  isMapVotePhase,
  isSeatMapVoteConfirmed: (seatIndex: number) => uiMockState.mapVoteConfirmedSeatIndices.includes(seatIndex),
  isLeaderFavorited: (leaderId: string) => uiMockState.favoriteLeaderIds.includes(leaderId),
  isMyTurn,
  isMobileLayout: () => uiMockState.isMobileLayout,
  isMyOwnPickTurn,
  isRandomSelected: () => uiMockState.isRandomSelected,
  isRedDeathDraft: () => uiMockState.isRedDeathDraft,
  isSpectator: () => uiMockState.isSpectator,
  isSwapWindowOpen: () => uiMockState.swapWindowOpen,
  mapVoteConfirmedSeatIndices: () => uiMockState.mapVoteConfirmedSeatIndices,
  mapVoteEnabled: () => uiMockState.mapVoteEnabled,
  mapVoteHasConfirmed: () => uiMockState.mapVoteHasConfirmed,
  mapVotePhase: () => uiMockState.mapVotePhase,
  mapVoteReadyToConfirm,
  mapVoteRevealEndsAt: () => uiMockState.mapVoteRevealEndsAt,
  mapVoteSeatVotes: () => uiMockState.mapVoteSeatVotes,
  mapVoteSelectedMapCount: () => uiMockState.mapVoteSelectedMaps.length,
  mapVoteSelectedMaps: () => uiMockState.mapVoteSelectedMaps,
  mapVoteVotingEndsAt: () => uiMockState.mapVoteVotingEndsAt,
  mapVoteWinningScriptCandidate: () => uiMockState.mapVoteWinningScriptCandidate,
  mapVoteWinningScript: () => uiMockState.mapVoteWinningScript,
  mapVoteWinningTypeCandidate: () => uiMockState.mapVoteWinningTypeCandidate,
  mapVoteWinningType: () => uiMockState.mapVoteWinningType,
  phaseAccent,
  phaseAccentColor,
  phaseHeaderBg,
  phaseLabel,
  pickSelections: () => uiMockState.pickSelections,
  placeLobbySlot: (...args: Parameters<typeof storeSpies.placeLobbySlot>) => storeSpies.placeLobbySlot(...args),
  removeLobbySlot: (...args: Parameters<typeof storeSpies.removeLobbySlot>) => storeSpies.removeLobbySlot(...args),
  transferLobbyHost: (...args: Parameters<typeof storeSpies.transferLobbyHost>) => storeSpies.transferLobbyHost(...args),
  repeatLobbyDraft: (...args: Parameters<typeof storeSpies.repeatLobbyDraft>) => storeSpies.repeatLobbyDraft(...args),
  reportMatchResult: (...args: Parameters<typeof storeSpies.reportMatchResult>) => storeSpies.reportMatchResult(...args),
  resetMapVote,
  resultSelectionsLocked: () => uiMockState.resultSelectionsLocked,
  seatJustSwapped: (seatIndex: number) => uiMockState.swapFlashSeatIndices.includes(seatIndex),
  scrubMatchResult: (...args: Parameters<typeof storeSpies.scrubMatchResult>) => storeSpies.scrubMatchResult(...args),
  searchQuery: () => uiMockState.searchQuery,
  selectedWinningTeam: () => uiMockState.selectedWinningTeam,
  selectedLeader: () => uiMockState.selectedLeaderId,
  sendCancel: (...args: Parameters<typeof storeSpies.sendCancel>) => storeSpies.sendCancel(...args),
  sendBan: (...args: Parameters<typeof storeSpies.sendBan>) => storeSpies.sendBan(...args),
  sendCivBlitzSubmit: (...args: Parameters<typeof storeSpies.sendCivBlitzSubmit>) => storeSpies.sendCivBlitzSubmit(...args),
  confirmMapVote,
  sendConfig: async () => {},
  sendMapVoteConfirm: (...args: Parameters<typeof storeSpies.sendMapVoteConfirm>) => storeSpies.sendMapVoteConfirm(...args),
  sendMapVoteSelection: (...args: Parameters<typeof storeSpies.sendMapVoteSelection>) => storeSpies.sendMapVoteSelection(...args),
  sendPick: (...args: Parameters<typeof storeSpies.sendPick>) => storeSpies.sendPick(...args),
  sendPreview: (...args: Parameters<typeof storeSpies.sendPreview>) => storeSpies.sendPreview(...args),
  sendRevert: (...args: Parameters<typeof storeSpies.sendRevert>) => storeSpies.sendRevert(...args),
  sendScrub: (...args: Parameters<typeof storeSpies.sendScrub>) => storeSpies.sendScrub(...args),
  sendStart: (...args: Parameters<typeof storeSpies.sendStart>) => storeSpies.sendStart(...args),
  sendLeaderSwap: (...args: Parameters<typeof storeSpies.sendLeaderSwap>) => storeSpies.sendLeaderSwap(...args),
  setBanSelections: (next: string[]) => { uiMockState.banSelections = [...next] },
  setDetailLeaderId: (leaderId: string | null) => { uiMockState.detailLeaderId = leaderId },
  setIsMiniView: () => {},
  setIsMobileLayout: () => {},
  setGridExpanded: (next: boolean) => { uiMockState.gridExpanded = next },
  setGridOpen: (next: boolean) => { uiMockState.gridOpen = next },
  setGridViewMode: (next: 'grid' | 'multi-list' | 'list') => { uiMockState.gridViewMode = next },
  setIsRandomSelected: (next: boolean) => { uiMockState.isRandomSelected = next },
  setMapVoteEnabled: (next: boolean) => { uiMockState.mapVoteEnabled = next },
  toggleMapVoteSelectedMap: (next: MapVoteMapId | null) => {
    if (uiMockState.mapVotePhase !== 'voting' || uiMockState.mapVoteHasConfirmed || uiMockState.draftSeatIndex == null || next == null) return { changed: false, readyToConfirm: false }
    const currentMaps = uiMockState.mapVoteSelectedMaps
    const nextMaps = toggleRankedChoice(currentMaps, next, 3)
    if (nextMaps.join('|') === currentMaps.join('|')) return { changed: false, readyToConfirm: mapVoteReadyToConfirm() }
    uiMockState.mapVoteSelectedMaps = nextMaps
    storeSpies.sendMapVoteSelection({ maps: nextMaps })
    return { changed: true, readyToConfirm: mapVoteReadyToConfirm() }
  },
  setPickSelections,
  setResultSelectionsLocked: (next: boolean) => { uiMockState.resultSelectionsLocked = next },
  setSearchQuery: (next: string) => { uiMockState.searchQuery = next },
  setSelectedLeader: (leaderId: string | null) => { setPickSelections(leaderId ? [leaderId] : []) },
  selectWinningTeam: (team: number | null) => { uiMockState.selectedWinningTeam = team },
  startLobbyDraft: (...args: Parameters<typeof storeSpies.startLobbyDraft>) => storeSpies.startLobbyDraft(...args),
  startMapVote,
  setBanSelectionStepToken: (next: string | null) => { uiMockState.banSelectionStepToken = next },
  tagFilters: () => uiMockState.tagFiltersState,
  teamPlacementOrder: () => uiMockState.teamPlacementOrder,
  toggleDetail: (leaderId: string) => { uiMockState.detailLeaderId = uiMockState.detailLeaderId === leaderId ? null : leaderId },
  toggleBanSelection: (leaderId: string, maxBans: number) => {
    if (uiMockState.banSelections.includes(leaderId)) {
      uiMockState.banSelections = uiMockState.banSelections.filter(id => id !== leaderId)
      return
    }
    if (uiMockState.banSelections.length >= maxBans) return
    uiMockState.banSelections = [...uiMockState.banSelections, leaderId]
  },
  toggleFfaPlacement: (...args: Parameters<typeof storeSpies.toggleFfaPlacement>) => storeSpies.toggleFfaPlacement(...args),
  toggleHiddenDraftLeaderSelection,
  toggleLeaderFavorite: (leaderId: string) => {
    if (uiMockState.favoriteLeaderIds.includes(leaderId)) {
      uiMockState.favoriteLeaderIds = uiMockState.favoriteLeaderIds.filter(id => id !== leaderId)
      return
    }
    uiMockState.favoriteLeaderIds = [...uiMockState.favoriteLeaderIds, leaderId]
  },
  togglePickSelection: (leaderId: string) => {
    setPickSelections(uiMockState.pickSelections[0] === leaderId ? [] : [leaderId])
  },
  toggleTagFilter: (tag: string) => {
    const category = getTagCategory(tag)
    if (!category) return
    const nextTags = uiMockState.tagFiltersState[category].includes(tag)
      ? uiMockState.tagFiltersState[category].filter(current => current !== tag)
      : [...uiMockState.tagFiltersState[category], tag]
    uiMockState.tagFiltersState = {
      ...uiMockState.tagFiltersState,
      [category]: nextTags,
    }
  },
  toggleTeamPlacement: (...args: Parameters<typeof storeSpies.toggleTeamPlacement>) => storeSpies.toggleTeamPlacement(...args),
  toggleLobbyPremadeLink: async () => ({ ok: true }),
  updateDraftSteamLobbyLink: (...args: Parameters<typeof storeSpies.updateDraftSteamLobbyLink>) => storeSpies.updateDraftSteamLobbyLink(...args),
  updateLobbyConfig: (...args: Parameters<typeof storeSpies.updateLobbyConfig>) => storeSpies.updateLobbyConfig(...args),
  updateLobbyMode: (...args: Parameters<typeof storeSpies.updateLobbyMode>) => storeSpies.updateLobbyMode(...args),
  userId: () => uiMockState.userId,
}))
type ConnectionStatus = 'disconnected' | 'connecting' | 'reconnecting' | 'connected' | 'error'
