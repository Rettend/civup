import type { OptimisticLobbyAction, PendingOptimisticLobbyAction, PlayerRow, RankRoleSetDetail } from './helpers'
import type { DraftSetupPageProps } from './types'
import type { LobbyArrangeStrategy, LobbySnapshot } from '~/client/stores'
import { formatLeaderPoolRankLabel, formatModeLabel, inferGameMode, isTeamMode as isTeamGameMode, slotToTeamIndex } from '@civup/game'
import { createEffect, createMemo, createRenderEffect, createSignal, onCleanup } from 'solid-js'
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
  repeatLobbyDraft,
  removeLobbySlot,
  sendCancel,
  sendStart,
  startLobbyDraft,
  transferLobbyHost,
  updateLobbyConfig,
  userId,
} from '~/client/stores'
import { buildFfaRows, buildMiniColumns, buildTeamRows, splitFfaRows } from './draftSetupRows'
import {
  applyOptimisticLobbyAction,
  buildLobbyBalanceSummary,
  resolveOptimisticLobbyPlacementAction,
  resolvePendingJoinGhostSlot,
} from './helpers'
import { useDraftSetupConfigState } from './useDraftSetupConfigState'

const CONFIG_MESSAGE_TIMEOUT_MS = 4000

export function useDraftSetupState(props: DraftSetupPageProps) {
  const state = () => draftStore.state
  const [lobbyState, setLobbyState] = createSignal<LobbySnapshot | null>(null)
  const [configMessage, setConfigMessage] = createSignal<string | null>(null)
  const [configMessageTone, setConfigMessageTone] = createSignal<'error' | 'info' | 'warning' | null>(null)
  const [rankRoleSetDetail, setRankRoleSetDetail] = createSignal<RankRoleSetDetail | null>(null)
  const [cancelPending, setCancelPending] = createSignal(false)
  const [startPending, setStartPending] = createSignal(false)
  const [repeatPending, setRepeatPending] = createSignal(false)
  const [lobbyActionPending, setLobbyActionPending] = createSignal(false)
  const [pendingPlaceSelfSlot, setPendingPlaceSelfSlot] = createSignal<number | null>(null)
  const [pendingArrangeStrategy, setPendingArrangeStrategy] = createSignal<LobbyArrangeStrategy | null>(null)
  const [draggingPlayerId, setDraggingPlayerId] = createSignal<string | null>(null)
  const [dragOverSlot, setDragOverSlot] = createSignal<number | null>(null)
  const [optimisticLobbyAction, setOptimisticLobbyAction] = createSignal<OptimisticLobbyAction | null>(null)
  let optimisticLobbyActionTimeout: ReturnType<typeof setTimeout> | null = null
  let configMessageTimeout: ReturnType<typeof setTimeout> | null = null

  const applyLobbySnapshot = (incomingLobby: LobbySnapshot | null) => {
    setLobbyState((current) => {
      if (!incomingLobby) return null
      if (current && current.id === incomingLobby.id && incomingLobby.revision < current.revision) return current
      return incomingLobby
    })
  }

  createRenderEffect(() => {
    applyLobbySnapshot(props.lobby ?? null)
  })

  const clearOptimisticLobbyAction = () => {
    if (optimisticLobbyActionTimeout) {
      clearTimeout(optimisticLobbyActionTimeout)
      optimisticLobbyActionTimeout = null
    }
    setOptimisticLobbyAction(null)
  }
  const clearPendingArrangeStrategy = () => {
    setPendingArrangeStrategy(null)
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
      setOptimisticLobbyAction(current => current && current.expiresAt === expiresAt ? null : current)
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
    clearPendingArrangeStrategy()
    if (configMessageTimeout) clearTimeout(configMessageTimeout)
  })

  const currentLobby = () => applyOptimisticLobbyAction(lobbyState(), optimisticLobbyAction(), userId(), currentDisplayName(), currentAvatarUrl())
  const persistentConfigMessage = () => currentLobby()?.tournament?.rematchWarning ?? null
  const effectiveConfigMessage = () => configMessage() ?? persistentConfigMessage()
  const effectiveConfigMessageTone = () => configMessageTone() ?? (persistentConfigMessage() ? 'warning' : null)
  const lobbyBalance = createMemo(() => buildLobbyBalanceSummary(currentLobby(), userId()))
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
    if (lobby) return formatModeLabel(lobby.mode, 'DRAFT', { redDeath: configState.derived.draftConfig().redDeath, civBlitz: configState.derived.draftConfig().civBlitz, targetSize: lobby.targetSize })
    return formatModeLabel(inferGameMode(state()?.formatId), 'DRAFT', { redDeath: configState.derived.isRedDeath(), targetSize: state()?.seats.length })
  }
  const miniFormatLabel = () => {
    const lobby = currentLobby()
    if (lobby) return formatModeLabel(lobby.mode, 'DRAFT', { redDeath: configState.derived.draftConfig().redDeath, compactRedDeath: true, civBlitz: configState.derived.draftConfig().civBlitz, targetSize: lobby.targetSize })
    return formatModeLabel(inferGameMode(state()?.formatId), 'DRAFT', { redDeath: configState.derived.isRedDeath(), compactRedDeath: true, targetSize: state()?.seats.length })
  }
  const statsLabel = () => {
    const config = configState.derived.draftConfig()
    if (config.civBlitz) return 'CivBlitz'
    if (config.redDeath) return 'Red Death'

    const lobby = currentLobby()
    const baseLabel = lobby
      ? formatModeLabel(lobby.mode, 'DRAFT', { targetSize: lobby.targetSize })
      : formatModeLabel(inferGameMode(state()?.formatId), 'DRAFT', { targetSize: state()?.seats.length })
    return `${baseLabel} Stats`
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
  const currentUserLobbySlot = createMemo(() => {
    const id = userId()
    if (!id) return null
    const slot = currentLobby()?.entries.findIndex(entry => entry?.playerId === id) ?? -1
    return slot >= 0 ? slot : null
  })
  const isCurrentUserSlotted = () => currentUserLobbySlot() != null
  const isLobbyClosed = () => currentLobby()?.draftConfig.closed === true

  const configState = useDraftSetupConfigState({
    props,
    currentLobby,
    amHost,
    canSaveSteamLobbyLink: isCurrentUserSlotted,
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
  const lobbyRankBadge = () => {
    const rank = currentLobby()?.lobbyRank ?? null
    if (!rank) return null

    const roleOption = configState.options.rankedRoles().find(option => option.tier === rank.tier) ?? null
    return {
      label: roleOption?.label ?? formatLeaderPoolRankLabel(rank.tier),
      color: roleOption?.color ?? null,
      leaderPoolSize: rank.leaderPoolSize,
    }
  }

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
  const shuffleTeamsButtonLabel = () => lobbyMode() === '1v1' ? 'Randomize First Pick' : 'Shuffle teams'
  const isTournamentOneVsOneLobby = () => lobbyMode() === '1v1' && currentLobby()?.tournament?.configLocked === true
  const isTournamentRosterLocked = () => currentLobby()?.tournament?.rosterLocked === true
  const showRandomizeLobbyAction = () => lobbyMode() !== '1v1' && !isTournamentRosterLocked()
  const showShuffleTeamsLobbyAction = () => !isTournamentOneVsOneLobby() && !isTournamentRosterLocked() && (lobbyMode() === '1v1' || isTeamGameMode(lobbyMode()))
  const showBalanceLobbyAction = () => lobbyMode() !== '1v1' && !isTournamentRosterLocked()
  const seatCountToggleConfig = () => {
    const lobby = currentLobby()
    if (!lobby) return null
    if (lobbyMode() === '2v2') {
      return {
        collapsedSize: 4,
        expandedSize: 8,
        addLabel: 'Add two extra teams',
        removeLabel: 'Remove extra teams',
        addMessage: 'Added two extra teams.',
        removeMessage: 'Removed the extra teams.',
        blockedTitle: 'Clear Teams C and D before removing them.',
      }
    }
    if (lobbyMode() === 'ffa' && !configState.derived.optimisticDraftConfig().redDeath && (lobby.targetSize === 8 || lobby.targetSize === 12)) {
      return {
        collapsedSize: 8,
        expandedSize: 12,
        addLabel: 'Add more seats',
        removeLabel: 'Remove extra seats',
        addMessage: 'Added four extra seats.',
        removeMessage: 'Removed the extra seats.',
        blockedTitle: 'Clear the extra FFA seats before removing them.',
      }
    }
    return null
  }
  const showSeatCountToggle = () => seatCountToggleConfig() != null
  const hasExpandedSeats = () => currentLobby()?.targetSize === seatCountToggleConfig()?.expandedSize
  const extraSeatsOccupied = () => {
    const config = seatCountToggleConfig()
    if (!config) return false
    return (currentLobby()?.entries.slice(config.collapsedSize) ?? []).some(entry => entry != null)
  }
  const canToggleSeatCount = () => amHost() && !lobbyActionPending() && (!hasExpandedSeats() || !extraSeatsOccupied())
  const seatCountToggleLabel = () => {
    const config = seatCountToggleConfig()
    if (!config) return ''
    return hasExpandedSeats() ? config.removeLabel : config.addLabel
  }
  const seatCountToggleTitle = () => hasExpandedSeats() && extraSeatsOccupied() ? seatCountToggleConfig()?.blockedTitle ?? '' : seatCountToggleLabel()
  const isLargeTeamLobbyMode = () => isLobbyMode() && (lobbyMode() === '5v5' || lobbyMode() === '6v6')
  const canCurrentUserPlaceSelf = () => {
    if (!isLobbyMode() || !userId()) return false
    if (props.showJoinPending && !isCurrentUserSlotted()) return false
    if (isLobbyClosed() && !amHost() && !isCurrentUserSlotted()) return false
    if (props.joinEligibility && !props.joinEligibility.canJoin && !isCurrentUserSlotted()) return false
    return true
  }
  const joinLobbyTargetSlot = createMemo(() => {
    const lobby = currentLobby()
    const currentUserId = userId()
    if (!lobby || !currentUserId || isCurrentUserSlotted()) return null
    const suggestedSlot = resolvePendingJoinGhostSlot(lobby, currentUserId, true, props.joinEligibility ?? null)
    if (suggestedSlot != null) return suggestedSlot
    if (lobby.tournament?.rosterLocked) return null
    const firstEmptySlot = lobby.entries.findIndex(entry => entry == null)
    return firstEmptySlot >= 0 ? firstEmptySlot : null
  })
  const canJoinLobby = () => !isCurrentUserSlotted() && canCurrentUserPlaceSelf() && joinLobbyTargetSlot() != null
  const canLeaveLobby = () => isLobbyMode() && !amHost() && currentUserLobbySlot() != null
  const joinLobbyButtonTitle = () => {
    if (props.showJoinPending) return 'Joining lobby...'
    if (isLobbyClosed() && !amHost() && !isCurrentUserSlotted()) return 'This lobby is closed.'
    if (props.joinEligibility?.blockedReason) return props.joinEligibility.blockedReason
    if (joinLobbyTargetSlot() == null) return 'No empty seats available.'
    return 'Join Lobby'
  }

  const rowBuildInput = createMemo(() => ({
    lobby: currentLobby(),
    draftState: state(),
    hostId: hostId(),
    currentUserId: userId(),
    currentUserDisplayName: currentDisplayName(),
    currentUserAvatarUrl: currentAvatarUrl(),
    pendingSelfJoinSlot: pendingSelfJoinSlot(),
  }))
  // Memoized so that unrelated re-renders (e.g. `lobbyActionPending` toggling
  // while the host is performing an arrange) don't rebuild the row objects and
  // force `<For>` to remount chip DOM — that would cancel the FLIP animation
  // in `DraftSetupPlayersPanel` mid-flight.
  const teamRowsByTeam = createMemo(() => {
    const input = rowBuildInput()
    const map = new Map<number, PlayerRow[]>()
    for (const team of teamIndices()) map.set(team, buildTeamRows(input, team))
    return map
  })
  const teamRows = (team: number) => teamRowsByTeam().get(team) ?? []
  const ffaRows = createMemo(() => buildFfaRows(rowBuildInput()))
  const ffaColumnsSplit = createMemo(() => splitFfaRows(ffaRows()))
  const ffaFirstColumn = () => ffaColumnsSplit()[0]
  const ffaSecondColumn = () => ffaColumnsSplit()[1]
  const ffaColumnsPair = createMemo<[PlayerRow[], PlayerRow[]]>(() => [ffaFirstColumn(), ffaSecondColumn()])

  const registeredTournamentSlot = () => {
    const id = userId()
    if (!id) return null
    return currentLobby()?.tournament?.entryRosters.flatMap(entry => entry.members).find(member => member.playerId === id)?.slot
      ?? props.joinEligibility?.pendingSlot
      ?? null
  }
  const canJoinSlot = (row: PlayerRow) => row.empty
    && canCurrentUserPlaceSelf()
    && (currentLobby()?.tournament?.rosterLocked !== true || registeredTournamentSlot() === row.slot)
  const canRemoveSlot = (row: PlayerRow) => {
    if (currentLobby()?.tournament?.rosterLocked) return false
    if (!isLobbyMode() || row.empty || !row.playerId || row.pendingSelf || row.isHost) return false
    const id = userId()
    if (!id) return false
    return amHost() || row.playerId === id
  }
  const canTransferHostToRow = (row: PlayerRow) => currentLobby()?.tournament?.rosterLocked !== true && isLobbyMode() && amHost() && !row.empty && !row.pendingSelf && !!row.playerId && !row.isHost
  const canDragRow = (row: PlayerRow) => {
    if (currentLobby()?.tournament?.rosterLocked) return false
    if (!isLobbyMode() || lobbyActionPending() || row.empty || !row.playerId || row.pendingSelf) return false
    const id = userId()
    if (!id) return false
    if (amHost()) return true
    return row.playerId === id
  }
  const canDropOnRow = (row: PlayerRow) => {
    if (currentLobby()?.tournament?.rosterLocked) return false
    if (!isLobbyMode() || lobbyActionPending()) return false
    const dragged = draggingPlayerId()
    const id = userId()
    if (!dragged || !id) return false
    if (amHost()) return true
    return dragged === id && row.empty
  }

  const handleSeatCountToggle = async () => {
    const lobby = currentLobby()
    const currentUserId = userId()
    const config = seatCountToggleConfig()
    if (!lobby || !currentUserId || !amHost() || !config || lobbyActionPending() || lobby.tournament?.rosterLocked) return
    const nextTargetSize = lobby.targetSize > config.collapsedSize ? config.collapsedSize : config.expandedSize
    setLobbyActionPending(true)
    clearConfigMessage()
    try {
      const result = await updateLobbyConfig(lobby.mode, lobby.id, currentUserId, { targetSize: nextTargetSize })
      if (!result.ok) return showErrorMessage(result.error)
      showInfoMessage(nextTargetSize === config.expandedSize ? config.addMessage : config.removeMessage)
    }
    finally {
      setLobbyActionPending(false)
    }
  }
  const handleFillTestPlayers = async () => {
    const lobby = currentLobby()
    const currentUserId = userId()
    if (!lobby || !currentUserId || !amHost() || lobbyActionPending() || startPending() || cancelPending() || lobby.tournament?.rosterLocked) return
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
  const handleTransferHost = async (targetPlayerId: string) => {
    const lobby = currentLobby()
    const currentUserId = userId()
    if (!lobby || !currentUserId || !amHost() || lobbyActionPending()) return
    if (targetPlayerId === lobby.hostId) return
    setLobbyActionPending(true)
    clearConfigMessage()
    try {
      const result = await transferLobbyHost(lobby.mode, { lobbyId: lobby.id, userId: currentUserId, targetPlayerId })
      if (!result.ok) return showErrorMessage(result.error)
      const targetName = lobby.entries.find(entry => entry?.playerId === targetPlayerId)?.displayName ?? 'Player'
      showInfoMessage(`${targetName} is now host.`)
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
      const configSaved = await configState.actions.flushPendingEdits()
      if (!configSaved) return

      const latestLobby = currentLobby()
      const latestUserId = userId()
      if (!latestLobby || !latestUserId || !amHost() || !configState.derived.canStartLobby() || lobbyActionPending()) return

      const result = await startLobbyDraft(latestLobby.mode, latestLobby.id, latestUserId)
      if (!result.ok) return showErrorMessage(result.error)
      props.onLobbyStarted?.(result.matchId, latestLobby.steamLobbyLink, result.sessionAccessToken)
      showInfoMessage('Draft created. Opening draft...')
    }
    finally {
      setStartPending(false)
    }
  }
  const handleRepeatLobbyDraftAction = async () => {
    const lobby = currentLobby()
    const currentUserId = userId()
    if (!lobby || !currentUserId || !amHost() || !lobby.repeatDraft || repeatPending() || startPending() || lobbyActionPending()) return
    setRepeatPending(true)
    clearConfigMessage()
    try {
      const result = await repeatLobbyDraft(lobby.mode, lobby.id, currentUserId)
      if (!result.ok) return showErrorMessage(result.error)
      props.onLobbyStarted?.(result.matchId, lobby.steamLobbyLink, result.sessionAccessToken)
      showInfoMessage(result.kind === 'resume' ? 'Draft restored. Opening draft...' : 'Draft repeated. Opening report screen...')
    }
    finally {
      setRepeatPending(false)
    }
  }
  const handleArrangeLobby = async (strategy: LobbyArrangeStrategy) => {
    const lobby = currentLobby()
    const currentUserId = userId()
    if (!lobby || !currentUserId || !amHost() || lobbyActionPending() || startPending() || cancelPending() || lobby.tournament?.rosterLocked) return
    setPendingArrangeStrategy(strategy)
    setLobbyActionPending(true)
    clearConfigMessage()
    try {
      const result = await arrangeLobbySlots(lobby.mode, lobby.id, currentUserId, strategy)
      if (!result.ok) {
        clearPendingArrangeStrategy()
        return showErrorMessage(result.error)
      }
      showInfoMessage(
        strategy === 'balance'
          ? `${arrangeTargetTitle()} auto-balanced.`
          : strategy === 'shuffle-teams'
            ? lobbyMode() === '1v1' ? 'First pick randomized.' : 'Teams shuffled.'
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
  const sendStartAction = async () => {
    if (!amHost() || isLobbyMode() || startPending()) return
    setStartPending(true)
    clearConfigMessage()
    try {
      const configSaved = await configState.actions.flushPendingEdits()
      if (!configSaved) return
      sendStart()
    }
    finally {
      setStartPending(false)
    }
  }

  const pending = {
    lobbyAction: lobbyActionPending,
    start: startPending,
    repeat: repeatPending,
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
    canSaveSteamLobbyLink: isCurrentUserSlotted,
    savePending: lobbyActionPending,
    formatLabel,
    lobbyRank: lobbyRankBadge,
    modeLabelClass: configState.derived.modeLabelClass,
    saveSteamLobbyLink: configState.actions.saveSteamLobbyLink,
  }

  const players = {
    isTeamMode,
    isLargeTeamLobbyMode,
    teamIndices,
    teamRows,
    teamBalance,
    ffaColumns: ffaColumnsPair,
    dragOverSlot,
    pending,
    arrangeEvent: () => currentLobby()?.lastArrange ?? null,
    pendingArrangeStrategy,
    clearPendingArrangeStrategy,
    rankedRoles: configState.options.rankedRoles,
    statsLabel,
    unranked: configState.derived.isUnranked,
    permissions: {
      canDragRow,
      canDropOnRow,
      canJoinSlot,
      canRemoveSlot,
      canTransferHostToRow,
    },
    actions: {
      join: handlePlaceSelf,
      remove: handleRemoveFromSlot,
      transferHost: handleTransferHost,
      dragStart: handleDragStart,
      dragEnd: handleDragEnd,
      dragEnter: setDragOverSlot,
      drop: handleDropOnSlot,
    },
    teamCountToggle: {
      show: showSeatCountToggle,
      expanded: hasExpandedSeats,
      canToggle: canToggleSeatCount,
      label: seatCountToggleLabel,
      title: seatCountToggleTitle,
      toggle: handleSeatCountToggle,
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
    repeatDraft: () => currentLobby()?.repeatDraft ?? null,
    arrangeTargetLabel,
    randomizeButtonLabel,
    randomizeButtonTitle,
    shuffleTeamsButtonLabel,
    showRandomizeLobbyAction,
    showShuffleTeamsLobbyAction,
    showBalanceLobbyAction,
    fillTestPlayersAvailable: () => configState.derived.fillTestPlayersAvailable() && currentLobby()?.tournament?.rosterLocked !== true,
    sendStart: sendStartAction,
    cancel: handleCancelAction,
    joinLobby: handleJoinLobby,
    leaveLobby: handleLeaveLobby,
    startLobbyDraft: handleStartLobbyDraftAction,
    repeatLobbyDraft: handleRepeatLobbyDraftAction,
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
      text: effectiveConfigMessage,
      tone: effectiveConfigMessageTone,
      rankRoleSetDetail: () => configMessage() ? rankRoleSetDetail() : null,
    },
    ...configState,
  }

  const mini = {
    formatLabel: miniFormatLabel,
    titleAccent: () => configState.derived.isCivBlitz() ? 'cyan' : configState.derived.isRedDeath() ? 'orange' : 'gold',
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
