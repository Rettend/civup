import type { LobbyArrangeStrategy, LobbySnapshot } from '~/client/stores'
import type { OptimisticLobbyAction, PendingOptimisticLobbyAction, PlayerRow, RankRoleSetDetail } from './helpers'
import type { DraftSetupPageProps } from './types'
import { formatModeLabel, inferGameMode, isTeamMode as isTeamGameMode, slotToTeamIndex } from '@civup/game'
import { createEffect, createMemo, createRenderEffect, createSignal, onCleanup } from 'solid-js'
import { buildMiniColumns, buildTeamRows, buildFfaRows, splitFfaRows } from './draftSetupRows'
import { useDraftSetupConfigState } from './useDraftSetupConfigState'
import {
  applyOptimisticLobbyAction,
  buildLobbyBalanceSummary,
  resolveOptimisticLobbyPlacementAction,
  resolvePendingJoinGhostSlot,
} from './helpers'
import {
  arrangeLobbySlots,
  cancelLobby,
  avatarUrl as currentAvatarUrl,
  displayName as currentDisplayName,
  draftStore,
  fillLobbyWithTestPlayers,
  isMiniView,
  isMobileLayout,
  isSpectator,
  placeLobbySlot,
  removeLobbySlot,
  sendCancel,
  sendStart,
  startLobbyDraft,
  updateLobbyConfig,
  userId,
} from '~/client/stores'

const CONFIG_MESSAGE_TIMEOUT_MS = 4000

export function useDraftSetupState(props: DraftSetupPageProps) {
  const state = () => draftStore.state
  const [lobbyState, setLobbyState] = createSignal<LobbySnapshot | null>(null)
  const [configMessage, setConfigMessage] = createSignal<string | null>(null)
  const [configMessageTone, setConfigMessageTone] = createSignal<'error' | 'info' | null>(null)
  const [rankRoleSetDetail, setRankRoleSetDetail] = createSignal<RankRoleSetDetail | null>(null)
  const [cancelPending, setCancelPending] = createSignal(false)
  const [startPending, setStartPending] = createSignal(false)
  const [lobbyActionPending, setLobbyActionPending] = createSignal(false)
  const [pendingPlaceSelfSlot, setPendingPlaceSelfSlot] = createSignal<number | null>(null)
  const [draggingPlayerId, setDraggingPlayerId] = createSignal<string | null>(null)
  const [dragOverSlot, setDragOverSlot] = createSignal<number | null>(null)
  const [optimisticLobbyAction, setOptimisticLobbyAction] = createSignal<OptimisticLobbyAction | null>(null)
  let optimisticLobbyActionTimeout: ReturnType<typeof setTimeout> | null = null
  let configMessageTimeout: ReturnType<typeof setTimeout> | null = null

  createRenderEffect(() => {
    const incomingLobby = props.lobby ?? null
    setLobbyState((current) => {
      if (!incomingLobby) return null
      if (current && incomingLobby.revision < current.revision) return current
      return incomingLobby
    })
  })

  const clearOptimisticLobbyAction = () => {
    if (optimisticLobbyActionTimeout) {
      clearTimeout(optimisticLobbyActionTimeout)
      optimisticLobbyActionTimeout = null
    }
    setOptimisticLobbyAction(null)
  }

  createEffect(() => {
    const action = optimisticLobbyAction()
    if (!action) return

    const lobby = lobbyState()
    const currentUserId = userId()
    if (!lobby || !currentUserId || lobby.status !== 'open') {
      clearOptimisticLobbyAction()
      return
    }

    if (lobby.revision > action.baseRevision || Date.now() > action.expiresAt) {
      clearOptimisticLobbyAction()
      return
    }

    if (action.kind === 'place-self' || action.kind === 'remove-self') {
      const currentSlot = lobby.entries.findIndex(entry => entry?.playerId === currentUserId)
      if (action.kind === 'place-self' && currentSlot === action.targetSlot) {
        clearOptimisticLobbyAction()
        return
      }
      if (action.kind === 'remove-self' && currentSlot < 0) clearOptimisticLobbyAction()
    }
  })

  const startOptimisticLobbyAction = (action: PendingOptimisticLobbyAction) => {
    clearOptimisticLobbyAction()
    const expiresAt = Date.now() + 2500
    const baseRevision = lobbyState()?.revision ?? 0
    const next = { ...action, baseRevision, expiresAt } as OptimisticLobbyAction
    setOptimisticLobbyAction(next)
    optimisticLobbyActionTimeout = setTimeout(() => {
      setOptimisticLobbyAction((current) => current && current.expiresAt === expiresAt ? null : current)
      optimisticLobbyActionTimeout = null
    }, 2500)
  }

  const clearConfigMessage = () => {
    if (configMessageTimeout) {
      clearTimeout(configMessageTimeout)
      configMessageTimeout = null
    }
    setConfigMessage(null)
    setConfigMessageTone(null)
    setRankRoleSetDetail(null)
  }
  const scheduleConfigMessageClear = () => {
    if (configMessageTimeout) clearTimeout(configMessageTimeout)
    configMessageTimeout = setTimeout(() => {
      configMessageTimeout = null
      clearConfigMessage()
    }, CONFIG_MESSAGE_TIMEOUT_MS)
  }
  const showErrorMessage = (message: string) => {
    setConfigMessage(message)
    setConfigMessageTone('error')
    setRankRoleSetDetail(null)
    scheduleConfigMessageClear()
  }
  const showInfoMessage = (message: string) => {
    setConfigMessage(message)
    setConfigMessageTone('info')
    setRankRoleSetDetail(null)
    scheduleConfigMessageClear()
  }
  const showRankRoleSetMessage = (detail: RankRoleSetDetail) => {
    setConfigMessage(`${detail.boundLabel} set to ${detail.roleLabel}`)
    setConfigMessageTone('info')
    setRankRoleSetDetail(detail)
    scheduleConfigMessageClear()
  }

  onCleanup(() => {
    clearOptimisticLobbyAction()
    if (configMessageTimeout) clearTimeout(configMessageTimeout)
  })

  const currentLobby = () => applyOptimisticLobbyAction(lobbyState(), optimisticLobbyAction(), userId(), currentDisplayName(), currentAvatarUrl())
  const lobbyBalance = createMemo(() => buildLobbyBalanceSummary(currentLobby()))
  const teamBalance = (team: number) => lobbyBalance()?.teams.find(summary => summary.team === team) ?? null
  const pendingSelfJoinSlot = () => resolvePendingJoinGhostSlot(currentLobby(), userId(), (props.showJoinPending === true) || pendingPlaceSelfSlot() != null, props.joinEligibility, pendingPlaceSelfSlot())
  const steamLobbyLink = () => currentLobby()?.steamLobbyLink ?? props.steamLobbyLink ?? null
  const isLobbyMode = () => currentLobby() != null
  const hostId = () => currentLobby()?.hostId ?? draftStore.hostId ?? state()?.seats[0]?.playerId ?? null
  const amHost = () => {
    const id = userId()
    return Boolean(id && id === hostId())
  }
  const lobbyMode = () => inferGameMode(currentLobby()?.mode ?? state()?.formatId)
  const formatLabel = () => {
    const lobby = currentLobby()
    if (lobby) return formatModeLabel(lobby.mode, 'DRAFT', { redDeath: configState.derived.draftConfig().redDeath, targetSize: lobby.targetSize })
    return formatModeLabel(inferGameMode(state()?.formatId), 'DRAFT', { redDeath: configState.derived.isRedDeath(), targetSize: state()?.seats.length })
  }
  const miniFormatLabel = () => {
    const lobby = currentLobby()
    if (lobby) return formatModeLabel(lobby.mode, 'DRAFT', { redDeath: configState.derived.draftConfig().redDeath, compactRedDeath: true, targetSize: lobby.targetSize })
    return formatModeLabel(inferGameMode(state()?.formatId), 'DRAFT', { redDeath: configState.derived.isRedDeath(), compactRedDeath: true, targetSize: state()?.seats.length })
  }
  const isTeamMode = () => {
    const lobby = currentLobby()
    if (lobby) return inferGameMode(lobby.mode) !== 'ffa'
    return state()?.seats.some(seat => seat.team != null) ?? false
  }
  const teamIndices = () => {
    const lobby = currentLobby()
    if (lobby) {
      const mode = inferGameMode(lobby.mode)
      const indices = new Set<number>()
      for (let slot = 0; slot < lobby.entries.length; slot++) {
        const team = slotToTeamIndex(mode, slot, lobby.targetSize)
        if (team != null) indices.add(team)
      }
      return [...indices].sort((a, b) => a - b)
    }
    return Array.from(new Set((state()?.seats ?? []).flatMap(seat => seat.team == null ? [] : [seat.team]))).sort((a, b) => a - b)
  }
  const filledSlots = () => currentLobby()?.entries.filter(entry => entry != null).length ?? 0

  const configState = useDraftSetupConfigState({
    props,
    currentLobby,
    amHost,
    isLobbyMode,
    lobbyMode,
    filledSlots,
    lobbyActionPending,
    setLobbyActionPending,
    startPending,
    clearConfigMessage,
    showErrorMessage,
    showInfoMessage,
    showRankRoleSetMessage,
  })

  createEffect(() => {
    const slot = pendingPlaceSelfSlot()
    if (slot == null) return

    const lobby = currentLobby()
    const currentUserId = userId()
    if (!lobby || !currentUserId || props.joinEligibility?.canJoin === false) {
      setPendingPlaceSelfSlot(null)
      return
    }
    if (lobby.entries.some(entry => entry?.playerId === currentUserId)) {
      setPendingPlaceSelfSlot(null)
      return
    }
    const targetEntry = lobby.entries[slot] ?? null
    if (targetEntry && targetEntry.playerId !== currentUserId) setPendingPlaceSelfSlot(null)
  })

  const arrangeTargetLabel = () => isTeamGameMode(lobbyMode()) ? 'teams' : 'seat order'
  const arrangeTargetTitle = () => isTeamGameMode(lobbyMode()) ? 'Teams' : 'Seat order'
  const randomizeButtonLabel = () => isTeamGameMode(lobbyMode()) ? 'Shuffle players' : `Randomize ${arrangeTargetLabel()}`
  const randomizeButtonTitle = () => isTeamGameMode(lobbyMode()) ? 'Shuffle players' : `Randomize ${arrangeTargetLabel()}`
  const show2v2TeamCountToggle = () => isLobbyMode() && lobbyMode() === '2v2'
  const hasExpanded2v2Teams = () => currentLobby()?.targetSize === 8
  const extra2v2SeatsOccupied = () => (currentLobby()?.entries.slice(4) ?? []).some(entry => entry != null)
  const canToggle2v2Teams = () => amHost() && !lobbyActionPending() && (!hasExpanded2v2Teams() || !extra2v2SeatsOccupied())
  const twoVTwoTeamCountToggleLabel = () => hasExpanded2v2Teams() ? 'Remove extra teams' : 'Add two extra teams'
  const twoVTwoTeamCountToggleTitle = () => hasExpanded2v2Teams() && extra2v2SeatsOccupied() ? 'Clear Teams C and D before removing them.' : twoVTwoTeamCountToggleLabel()
  const isLargeTeamLobbyMode = () => isLobbyMode() && (lobbyMode() === '5v5' || lobbyMode() === '6v6')
  const currentUserLobbySlot = createMemo(() => {
    const id = userId()
    if (!id) return null
    const slot = currentLobby()?.entries.findIndex(entry => entry?.playerId === id) ?? -1
    return slot >= 0 ? slot : null
  })
  const isCurrentUserSlotted = () => currentUserLobbySlot() != null
  const canCurrentUserPlaceSelf = () => {
    if (!isLobbyMode() || !userId()) return false
    if (props.showJoinPending && !isCurrentUserSlotted()) return false
    if (props.joinEligibility && !props.joinEligibility.canJoin && !isCurrentUserSlotted()) return false
    return true
  }
  const joinLobbyTargetSlot = createMemo(() => {
    const lobby = currentLobby()
    const currentUserId = userId()
    if (!lobby || !currentUserId || isCurrentUserSlotted()) return null
    const suggestedSlot = resolvePendingJoinGhostSlot(lobby, currentUserId, true, props.joinEligibility ?? null)
    if (suggestedSlot != null) return suggestedSlot
    const firstEmptySlot = lobby.entries.findIndex(entry => entry == null)
    return firstEmptySlot >= 0 ? firstEmptySlot : null
  })
  const canJoinLobby = () => !isCurrentUserSlotted() && canCurrentUserPlaceSelf() && joinLobbyTargetSlot() != null
  const canLeaveLobby = () => isLobbyMode() && !amHost() && currentUserLobbySlot() != null
  const joinLobbyButtonTitle = () => {
    if (props.showJoinPending) return 'Joining lobby...'
    if (props.joinEligibility?.blockedReason) return props.joinEligibility.blockedReason
    if (joinLobbyTargetSlot() == null) return 'No empty seats available.'
    return 'Join Lobby'
  }

  const rowBuildInput = () => ({
    lobby: currentLobby(),
    draftState: state(),
    hostId: hostId(),
    currentUserId: userId(),
    currentUserDisplayName: currentDisplayName(),
    currentUserAvatarUrl: currentAvatarUrl(),
    pendingSelfJoinSlot: pendingSelfJoinSlot(),
  })
  const teamRows = (team: number) => buildTeamRows(rowBuildInput(), team)
  const ffaRows = () => buildFfaRows(rowBuildInput())
  const ffaFirstColumn = () => splitFfaRows(ffaRows())[0]
  const ffaSecondColumn = () => splitFfaRows(ffaRows())[1]

  const canJoinSlot = (row: PlayerRow) => row.empty && canCurrentUserPlaceSelf()
  const canRemoveSlot = (row: PlayerRow) => {
    if (!isLobbyMode() || row.empty || !row.playerId || row.pendingSelf || row.isHost) return false
    const id = userId()
    if (!id) return false
    return amHost() || row.playerId === id
  }
  const canDragRow = (row: PlayerRow) => {
    if (!isLobbyMode() || lobbyActionPending() || row.empty || !row.playerId || row.pendingSelf) return false
    const id = userId()
    if (!id) return false
    if (amHost()) return true
    return row.playerId === id
  }
  const canDropOnRow = (row: PlayerRow) => {
    if (!isLobbyMode() || lobbyActionPending()) return false
    const dragged = draggingPlayerId()
    const id = userId()
    if (!dragged || !id) return false
    if (amHost()) return true
    return dragged === id && row.empty
  }

  const handle2v2TeamCountToggle = async () => {
    const lobby = currentLobby()
    const currentUserId = userId()
    if (!lobby || !currentUserId || !amHost() || lobby.mode !== '2v2' || lobbyActionPending()) return
    const nextTargetSize = lobby.targetSize > 4 ? 4 : 8
    setLobbyActionPending(true)
    clearConfigMessage()
    try {
      const result = await updateLobbyConfig(lobby.mode, lobby.id, currentUserId, { targetSize: nextTargetSize })
      if (!result.ok) return showErrorMessage(result.error)
      showInfoMessage(nextTargetSize === 8 ? 'Added two extra teams.' : 'Removed the extra teams.')
    }
    finally {
      setLobbyActionPending(false)
    }
  }
  const handleFillTestPlayers = async () => {
    const lobby = currentLobby()
    const currentUserId = userId()
    if (!lobby || !currentUserId || !amHost() || lobbyActionPending() || startPending() || cancelPending()) return
    setLobbyActionPending(true)
    clearConfigMessage()
    try {
      const result = await fillLobbyWithTestPlayers(lobby.mode, lobby.id, currentUserId)
      if (!result.ok) return showErrorMessage(result.error)
      showInfoMessage(result.addedCount > 0 ? `Added ${result.addedCount} test player${result.addedCount === 1 ? '' : 's'} to empty slots.` : 'Lobby is already full.')
    }
    finally {
      setLobbyActionPending(false)
    }
  }
  const handleMovePlayerToSlot = async (slot: number, draggedPlayerId: string) => {
    const lobby = currentLobby()
    const currentUserId = userId()
    if (!lobby || !currentUserId || lobbyActionPending()) return
    const movingSelf = draggedPlayerId === currentUserId
    const optimisticAction = resolveOptimisticLobbyPlacementAction(lobby, currentUserId, draggedPlayerId, slot, amHost())
    if (movingSelf && !isCurrentUserSlotted() && props.joinEligibility?.canJoin !== false) setPendingPlaceSelfSlot(slot)
    if (optimisticAction) startOptimisticLobbyAction(optimisticAction)
    setLobbyActionPending(true)
    clearConfigMessage()
    try {
      const payload: { lobbyId: string, userId: string, targetSlot: number, playerId?: string, displayName?: string, avatarUrl?: string | null } = {
        lobbyId: lobby.id,
        userId: currentUserId,
        targetSlot: slot,
        displayName: currentDisplayName(),
        avatarUrl: currentAvatarUrl(),
      }
      if (amHost() && draggedPlayerId !== currentUserId) payload.playerId = draggedPlayerId
      const result = await placeLobbySlot(lobby.mode, payload)
      if (!result.ok) {
        if (movingSelf) setPendingPlaceSelfSlot(null)
        if (optimisticAction) clearOptimisticLobbyAction()
        showErrorMessage(result.error)
      }
      else if (result.transferNotice) {
        showInfoMessage(result.transferNotice)
      }
    }
    finally {
      setLobbyActionPending(false)
    }
  }
  const handlePlaceSelf = async (slot: number) => {
    const currentUserId = userId()
    if (!currentUserId) return
    await handleMovePlayerToSlot(slot, currentUserId)
  }
  const handleDropOnSlot = async (slot: number) => {
    const draggedPlayerId = draggingPlayerId()
    if (!draggedPlayerId) return
    try {
      await handleMovePlayerToSlot(slot, draggedPlayerId)
    }
    finally {
      setDraggingPlayerId(null)
      setDragOverSlot(null)
    }
  }
  const handleRemoveFromSlot = async (slot: number) => {
    const lobby = currentLobby()
    const currentUserId = userId()
    if (!lobby || !currentUserId || lobbyActionPending()) return
    const removingPlayerId = lobby.entries[slot]?.playerId ?? null
    let optimisticAction: PendingOptimisticLobbyAction | null = null
    if (removingPlayerId === currentUserId) optimisticAction = { kind: 'remove-self' }
    else if (removingPlayerId && amHost()) optimisticAction = { kind: 'remove-player', playerId: removingPlayerId }
    if (optimisticAction) startOptimisticLobbyAction(optimisticAction)
    setLobbyActionPending(true)
    clearConfigMessage()
    try {
      const result = await removeLobbySlot(lobby.mode, { lobbyId: lobby.id, userId: currentUserId, slot })
      if (!result.ok) {
        if (optimisticAction) clearOptimisticLobbyAction()
        showErrorMessage(result.error)
      }
    }
    finally {
      setLobbyActionPending(false)
    }
  }
  const handleStartLobbyDraftAction = async () => {
    const lobby = currentLobby()
    const currentUserId = userId()
    if (!lobby || !currentUserId || !amHost() || !configState.derived.canStartLobby() || startPending() || lobbyActionPending()) return
    setStartPending(true)
    clearConfigMessage()
    try {
      const result = await startLobbyDraft(lobby.mode, lobby.id, currentUserId)
      if (!result.ok) return showErrorMessage(result.error)
      props.onLobbyStarted?.(result.matchId, lobby.steamLobbyLink, result.roomAccessToken)
      showInfoMessage('Draft room created. Opening draft...')
    }
    finally {
      setStartPending(false)
    }
  }
  const handleArrangeLobby = async (strategy: LobbyArrangeStrategy) => {
    const lobby = currentLobby()
    const currentUserId = userId()
    if (!lobby || !currentUserId || !amHost() || lobbyActionPending() || startPending() || cancelPending()) return
    setLobbyActionPending(true)
    clearConfigMessage()
    try {
      const result = await arrangeLobbySlots(lobby.mode, lobby.id, currentUserId, strategy)
      if (!result.ok) return showErrorMessage(result.error)
      showInfoMessage(
        strategy === 'balance'
          ? `${arrangeTargetTitle()} auto-balanced.`
          : strategy === 'shuffle-teams'
            ? 'Teams shuffled.'
            : `${arrangeTargetTitle()} randomized.`,
      )
    }
    finally {
      setLobbyActionPending(false)
    }
  }
  const handleCancelAction = async () => {
    if (cancelPending()) return
    const lobby = currentLobby()
    if (lobby) {
      const currentUserId = userId()
      if (!currentUserId) return showErrorMessage('Could not identify your Discord user. Reopen the activity.')
      setCancelPending(true)
      clearConfigMessage()
      try {
        const result = await cancelLobby(lobby.mode, lobby.id, currentUserId)
        if (!result.ok) return showErrorMessage(result.error)
        showInfoMessage('Lobby cancelled. Closing...')
      }
      finally {
        setCancelPending(false)
      }
      return
    }
    sendCancel('cancel')
  }

  const miniColumns = () => buildMiniColumns({
    isTeamMode: isTeamMode(),
    teamIndices: teamIndices(),
    teamRows,
    ffaColumns: [ffaFirstColumn(), ffaSecondColumn()],
    draftState: state(),
    previewPicks: draftStore.previews.picks,
  })
  const setupStatusText = () => {
    if (isLobbyMode()) {
      if (amHost()) return configState.derived.canStartLobby() ? 'Ready to start' : 'Waiting for more players'
      return isCurrentUserSlotted() ? 'Waiting for host' : 'Spectating'
    }
    if (amHost()) return 'Ready to start'
    return isSpectator() ? 'Spectating' : 'Waiting for host'
  }
  const desktopSetupPanelMaxHeightClass = () => {
    if (amHost()) return 'lg:max-h-[432px]'
    if (isCurrentUserSlotted() && lobbyMode() === '6v6') return 'lg:max-h-[368px]'
    return 'lg:max-h-[336px]'
  }

  const handleDragStart = (playerId: string | null) => {
    if (!playerId) return
    setDraggingPlayerId(playerId)
  }
  const handleDragEnd = () => {
    setDraggingPlayerId(null)
    setDragOverSlot(null)
  }
  const handleJoinLobby = async () => {
    const slot = joinLobbyTargetSlot()
    if (slot == null) return
    await handlePlaceSelf(slot)
  }
  const handleLeaveLobby = async () => {
    const slot = currentUserLobbySlot()
    if (slot == null) return
    await handleRemoveFromSlot(slot)
  }
  const sendStartAction = () => sendStart()

  const pending = {
    lobbyAction: lobbyActionPending,
    start: startPending,
    cancel: cancelPending,
  }

  const layout = {
    isMiniView,
    isMobileLayout,
    desktopSetupPanelMaxHeightClass,
  }

  const header = {
    steamLobbyLink,
    isLobbyMode,
    isHost: amHost,
    savePending: lobbyActionPending,
    formatLabel,
    modeLabelClass: configState.derived.modeLabelClass,
    saveSteamLobbyLink: configState.actions.saveSteamLobbyLink,
  }

  const players = {
    isTeamMode,
    isLargeTeamLobbyMode,
    teamIndices,
    teamRows,
    teamBalance,
    ffaColumns: () => [ffaFirstColumn(), ffaSecondColumn()],
    lowConfidence: () => Boolean(lobbyBalance()?.lowConfidence),
    dragOverSlot,
    pending,
    permissions: {
      canDragRow,
      canDropOnRow,
      canJoinSlot,
      canRemoveSlot,
    },
    actions: {
      join: handlePlaceSelf,
      remove: handleRemoveFromSlot,
      dragStart: handleDragStart,
      dragEnd: handleDragEnd,
      dragEnter: setDragOverSlot,
      drop: handleDropOnSlot,
    },
    teamCountToggle: {
      show: show2v2TeamCountToggle,
      expanded: hasExpanded2v2Teams,
      canToggle: canToggle2v2Teams,
      label: twoVTwoTeamCountToggleLabel,
      title: twoVTwoTeamCountToggleTitle,
      toggle: handle2v2TeamCountToggle,
    },
  }

  const status = {
    text: setupStatusText,
    currentLobby,
    filledSlots,
    isCurrentUserSlotted,
    canJoinLobby,
    canLeaveLobby,
    joinLobbyButtonTitle,
  }

  const actions = {
    isHost: amHost,
    isLobbyMode,
    pending,
    canStartLobby: configState.derived.canStartLobby,
    arrangeTargetLabel,
    randomizeButtonLabel,
    randomizeButtonTitle,
    fillTestPlayersAvailable: configState.derived.fillTestPlayersAvailable,
    sendStart: sendStartAction,
    cancel: handleCancelAction,
    joinLobby: handleJoinLobby,
    leaveLobby: handleLeaveLobby,
    startLobbyDraft: handleStartLobbyDraftAction,
    randomizeLobby: () => handleArrangeLobby('randomize'),
    shuffleTeamsLobby: () => handleArrangeLobby('shuffle-teams'),
    balanceLobby: () => handleArrangeLobby('balance'),
    fillTestPlayers: handleFillTestPlayers,
  }

  const config = {
    isLobbyMode,
    isHost: amHost,
    lobbyMode,
    lobbyActionPending,
    message: {
      text: configMessage,
      tone: configMessageTone,
      rankRoleSetDetail,
    },
    ...configState,
  }

  const mini = {
    formatLabel: miniFormatLabel,
    titleAccent: () => configState.derived.isRedDeath() ? 'orange' : 'gold',
    rightLabel: () => currentLobby() ? `${filledSlots()}/${currentLobby()!.targetSize}` : null,
    columns: miniColumns,
  }

  return {
    layout,
    header,
    players,
    status,
    actions,
    config,
    mini,
  }
}
