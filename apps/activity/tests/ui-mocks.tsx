/** @jsxImportSource solid-js */

import { getPickSeatForPlayer, type DraftState, type LeaderDataVersion } from '@civup/game'
import type { LeaderTagCategory } from '../src/client/lib/leader-tags'
import type { LobbyArrangeStrategy, LobbySnapshot, RankedRoleOptionSnapshot } from '../src/client/stores'
import { getTagCategory } from '../src/client/lib/leader-tags'
import { mock } from 'bun:test'
import { createMutable } from 'solid-js/store'

export const storeSpies = {
  sendStart: mock(() => true),
  sendCancel: mock(() => {}),
  sendScrub: mock(() => {}),
  sendRevert: mock(() => {}),
  sendBan: mock((_civIds: string[]) => {}),
  sendPick: mock((_civId: string) => {}),
  sendPreview: mock((_kind: 'ban' | 'pick', _civIds: string[]) => {}),
  sendSwapAccept: mock(() => {}),
  sendSwapRequest: mock((_seatIndex: number) => {}),
  reportMatchResult: mock(async () => ({ ok: true })),
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
  startLobbyDraft: mock(async (_mode: string, _lobbyId: string, _userId: string) => uiMockState.startLobbyDraftResult),
  updateLobbyConfig: mock(async (_mode: string, _lobbyId: string, _userId: string, patch: Partial<LobbySnapshot>) => ({
    ...uiMockState.updateLobbyConfigResult,
    lobby: { steamLobbyLink: patch.steamLobbyLink ?? null },
  })),
  updateLobbyMode: mock(async (_mode: string, _lobbyId: string, _userId: string, _nextMode: string) => uiMockState.updateLobbyModeResult),
}

export const discordSpies = {
  openExternalLink: mock(async () => ({ opened: true })),
}

export const clipboardSpies = {
  copyTextToClipboard: mock(async () => true),
}

type MockState = {
  userId: string | null
  displayName: string
  avatarUrl: string | null
  isMiniView: boolean
  isMobileLayout: boolean
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
  isRandomSelected: boolean
  favoriteLeaderIds: string[]
  ffaPlacementOrder: number[]
  teamPlacementOrder: number[]
  canOpenLeaderGrid: boolean
  canSendPickPreview: boolean
  sendStartResult: boolean
  searchQuery: string
  previewPicks: Record<number, string | null>
  draftPreviewBans: Record<number, string[]>
  draftPreviewPicks: Record<number, string[]>
  canRequestSwapSeatIndices: number[]
  swapWindowOpen: boolean
  incomingSwapSeatIndices: number[]
  tagFiltersState: Record<LeaderTagCategory, string[]>
  arrangeLobbySlotsResult: { ok: true } | { ok: false, error: string }
  cancelLobbyResult: { ok: true } | { ok: false, error: string }
  canFillLobbyWithTestPlayersResult: boolean
  fetchLobbyRankedRolesResult: { options: RankedRoleOptionSnapshot[] } | null
  fillLobbyWithTestPlayersResult: { ok: true, addedCount: number } | { ok: false, error: string }
  placeLobbySlotResult: { ok: true, lobby: LobbySnapshot, transferNotice: string | null } | { ok: false, error: string }
  removeLobbySlotResult: { ok: true, lobby: LobbySnapshot } | { ok: false, error: string }
  startLobbyDraftResult: { ok: true, matchId: string, roomAccessToken: string | null } | { ok: false, error: string }
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
    entries: [],
    minPlayers: 2,
    targetSize: 4,
    draftConfig: {
      banTimerSeconds: 60,
      pickTimerSeconds: 90,
      leaderPoolSize: 6,
      leaderDataVersion: 'live',
      blindBans: true,
      simultaneousPick: false,
      redDeath: false,
      dealOptionsSize: null,
      randomDraft: false,
      duplicateFactions: false,
    },
    serverDefaults: {
      banTimerSeconds: 60,
      pickTimerSeconds: 90,
    },
  }
}

const defaults = (): MockState => ({
  userId: 'host-1',
  displayName: 'Host Player',
  avatarUrl: null,
  isMiniView: false,
  isMobileLayout: false,
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
  isRandomSelected: false,
  favoriteLeaderIds: [],
  ffaPlacementOrder: [],
  teamPlacementOrder: [],
  canOpenLeaderGrid: true,
  canSendPickPreview: false,
  sendStartResult: true,
  searchQuery: '',
  previewPicks: {},
  draftPreviewBans: {},
  draftPreviewPicks: {},
  canRequestSwapSeatIndices: [],
  swapWindowOpen: false,
  incomingSwapSeatIndices: [],
  tagFiltersState: emptyTagFilters(),
  arrangeLobbySlotsResult: { ok: true },
  cancelLobbyResult: { ok: true },
  canFillLobbyWithTestPlayersResult: false,
  fetchLobbyRankedRolesResult: null,
  fillLobbyWithTestPlayersResult: { ok: true, addedCount: 0 },
  placeLobbySlotResult: { ok: true, lobby: mockLobbySnapshot(), transferNotice: null },
  removeLobbySlotResult: { ok: true, lobby: mockLobbySnapshot() },
  startLobbyDraftResult: { ok: true, matchId: 'match-1', roomAccessToken: 'room-token' },
  updateLobbyConfigResult: { ok: true },
  updateLobbyModeResult: { ok: true },
})

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
  uiMockState.isRandomSelected = false
  uiMockState.favoriteLeaderIds = []
  uiMockState.ffaPlacementOrder = []
  uiMockState.teamPlacementOrder = []
  uiMockState.canOpenLeaderGrid = true
  uiMockState.canSendPickPreview = false
  uiMockState.sendStartResult = true
  uiMockState.searchQuery = ''
  uiMockState.previewPicks = {}
  uiMockState.draftPreviewBans = {}
  uiMockState.draftPreviewPicks = {}
  uiMockState.canRequestSwapSeatIndices = []
  uiMockState.swapWindowOpen = false
  uiMockState.incomingSwapSeatIndices = []
  uiMockState.tagFiltersState = emptyTagFilters()
  for (const spy of Object.values(discordSpies)) spy.mockClear()
  for (const spy of Object.values(clipboardSpies)) spy.mockClear()
  for (const spy of Object.values(storeSpies)) spy.mockClear()
  storeSpies.sendStart.mockImplementation(() => uiMockState.sendStartResult)
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
  uiMockState.isRandomSelected = false
  uiMockState.searchQuery = ''
  uiMockState.tagFiltersState = emptyTagFilters()
  uiMockState.detailLeaderId = null
  uiMockState.selectedWinningTeam = null
  uiMockState.ffaPlacementOrder = []
  uiMockState.teamPlacementOrder = []
}

function phaseHeaderBg() {
  return 'bg-bg-subtle'
}

function currentStepDuration() {
  return currentStep()?.timer ?? 0
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
  activeTagFilterCount: () => Object.values(uiMockState.tagFiltersState).reduce((count, tags) => count + tags.length, 0),
  arrangeLobbySlots: (...args: Parameters<typeof storeSpies.arrangeLobbySlots>) => storeSpies.arrangeLobbySlots(...args),
  banSelections: () => uiMockState.banSelections,
  clearLeaderFavorites: () => { uiMockState.favoriteLeaderIds = [] },
  clearWinningTeam: () => { uiMockState.selectedWinningTeam = null },
  cancelLobby: (...args: Parameters<typeof storeSpies.cancelLobby>) => storeSpies.cancelLobby(...args),
  canFillLobbyWithTestPlayers: (...args: Parameters<typeof storeSpies.canFillLobbyWithTestPlayers>) => storeSpies.canFillLobbyWithTestPlayers(...args),
  canRequestSwapWith: (seatIndex: number) => uiMockState.canRequestSwapSeatIndices.includes(seatIndex),
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
    get previews() {
      return {
        bans: uiMockState.draftPreviewBans,
        picks: uiMockState.draftPreviewPicks,
      }
    },
    swapState: null,
    initVersion: 1,
  },
  favoriteLeaderIds: () => uiMockState.favoriteLeaderIds,
  fetchLobbyRankedRoles: (...args: Parameters<typeof storeSpies.fetchLobbyRankedRoles>) => storeSpies.fetchLobbyRankedRoles(...args),
  ffaPlacementOrder: () => uiMockState.ffaPlacementOrder,
  fillLobbyWithTestPlayers: (...args: Parameters<typeof storeSpies.fillLobbyWithTestPlayers>) => storeSpies.fillLobbyWithTestPlayers(...args),
  getOptimisticSeatPick: () => null,
  getPreviewPickForSeat: (seatIndex: number) => uiMockState.previewPicks[seatIndex] ?? null,
  gridOpen: () => uiMockState.gridOpen,
  gridExpanded: () => uiMockState.gridExpanded,
  gridViewMode: () => uiMockState.gridViewMode,
  hasSubmitted,
  isMiniView: () => uiMockState.isMiniView,
  isLeaderFavorited: (leaderId: string) => uiMockState.favoriteLeaderIds.includes(leaderId),
  isMyTurn,
  isMobileLayout: () => uiMockState.isMobileLayout,
  isMyOwnPickTurn,
  isRandomSelected: () => uiMockState.isRandomSelected,
  isRedDeathDraft: () => uiMockState.isRedDeathDraft,
  isSpectator: () => uiMockState.isSpectator,
  isSwapWindowOpen: () => uiMockState.swapWindowOpen,
  phaseAccent,
  phaseAccentColor,
  phaseHeaderBg,
  phaseLabel,
  pickSelections: () => uiMockState.pickSelections,
  placeLobbySlot: (...args: Parameters<typeof storeSpies.placeLobbySlot>) => storeSpies.placeLobbySlot(...args),
  removeLobbySlot: (...args: Parameters<typeof storeSpies.removeLobbySlot>) => storeSpies.removeLobbySlot(...args),
  reportMatchResult: (...args: Parameters<typeof storeSpies.reportMatchResult>) => storeSpies.reportMatchResult(...args),
  resultSelectionsLocked: () => uiMockState.resultSelectionsLocked,
  scrubMatchResult: (...args: Parameters<typeof storeSpies.scrubMatchResult>) => storeSpies.scrubMatchResult(...args),
  searchQuery: () => uiMockState.searchQuery,
  selectedWinningTeam: () => uiMockState.selectedWinningTeam,
  selectedLeader: () => uiMockState.selectedLeaderId,
  seatHasIncomingSwap: (seatIndex: number) => uiMockState.incomingSwapSeatIndices.includes(seatIndex),
  sendCancel: (...args: Parameters<typeof storeSpies.sendCancel>) => storeSpies.sendCancel(...args),
  sendBan: (...args: Parameters<typeof storeSpies.sendBan>) => storeSpies.sendBan(...args),
  sendConfig: async () => {},
  sendPick: (...args: Parameters<typeof storeSpies.sendPick>) => storeSpies.sendPick(...args),
  sendPreview: (...args: Parameters<typeof storeSpies.sendPreview>) => storeSpies.sendPreview(...args),
  sendRevert: (...args: Parameters<typeof storeSpies.sendRevert>) => storeSpies.sendRevert(...args),
  sendScrub: (...args: Parameters<typeof storeSpies.sendScrub>) => storeSpies.sendScrub(...args),
  sendStart: (...args: Parameters<typeof storeSpies.sendStart>) => storeSpies.sendStart(...args),
  sendSwapAccept: (...args: Parameters<typeof storeSpies.sendSwapAccept>) => storeSpies.sendSwapAccept(...args),
  sendSwapRequest: (...args: Parameters<typeof storeSpies.sendSwapRequest>) => storeSpies.sendSwapRequest(...args),
  setBanSelections: (next: string[]) => { uiMockState.banSelections = [...next] },
  setDetailLeaderId: (leaderId: string | null) => { uiMockState.detailLeaderId = leaderId },
  setIsMiniView: () => {},
  setIsMobileLayout: () => {},
  setGridExpanded: (next: boolean) => { uiMockState.gridExpanded = next },
  setGridOpen: (next: boolean) => { uiMockState.gridOpen = next },
  setGridViewMode: (next: 'grid' | 'multi-list' | 'list') => { uiMockState.gridViewMode = next },
  setIsRandomSelected: (next: boolean) => { uiMockState.isRandomSelected = next },
  setPickSelections,
  setResultSelectionsLocked: (next: boolean) => { uiMockState.resultSelectionsLocked = next },
  setSearchQuery: (next: string) => { uiMockState.searchQuery = next },
  setSelectedLeader: (leaderId: string | null) => { setPickSelections(leaderId ? [leaderId] : []) },
  selectWinningTeam: (team: number | null) => { uiMockState.selectedWinningTeam = team },
  startLobbyDraft: (...args: Parameters<typeof storeSpies.startLobbyDraft>) => storeSpies.startLobbyDraft(...args),
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
  updateLobbyConfig: (...args: Parameters<typeof storeSpies.updateLobbyConfig>) => storeSpies.updateLobbyConfig(...args),
  updateLobbyMode: (...args: Parameters<typeof storeSpies.updateLobbyMode>) => storeSpies.updateLobbyMode(...args),
  userId: () => uiMockState.userId,
}))
type ConnectionStatus = 'disconnected' | 'connecting' | 'reconnecting' | 'connected' | 'error'
