import type {
  DraftTimerConfig,
  LobbyModeValue,
  MinRoleMismatchDetail,
  MinRoleSetDetail,
  OptimisticLobbyAction,
  PendingOptimisticLobbyAction,
  PlayerRow,
} from '~/client/lib/config-screen/helpers'
import type { LobbySnapshot, LobbyTeamArrangeStrategy, RankedRoleOptionSnapshot } from '~/client/stores'
import { formatModeLabel, GAME_MODE_CHOICES, inferGameMode } from '@civup/game'
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'
import { Dropdown, TextInput } from '~/client/components/ui'
import {
  applyOptimisticLobbyAction,
  buildRankDotStyle,
  findRankedRoleOptionByTier,
  formatLobbyMinRole,
  formatTimerValue,
  getTimerConfigFromDraft,
  MAX_TIMER_MINUTES,
  normalizeLobbyMinRoleValue,
  normalizeTimerMinutesInput,
  parseTimerMinutesInput,
  timerSecondsToMinutesInput,
  timerSecondsToMinutesPlaceholder,
} from '~/client/lib/config-screen/helpers'
import { MinRoleMismatchNotice, MinRoleSetNotice, PlayerChip, PremadeLinkButton, ReadonlyTimerRow } from '~/client/lib/config-screen/parts'
import { cn } from '~/client/lib/css'
import { isDev } from '~/client/lib/is-dev'
import { createOptimisticState } from '~/client/lib/optimistic-state'
import {
  arrangeLobbyTeams,
  cancelLobby,
  avatarUrl as currentAvatarUrl,
  displayName as currentDisplayName,
  draftStore,
  fetchLobbyRankedRoles,
  fillLobbyWithTestPlayers,
  isSpectator,
  placeLobbySlot,
  removeLobbySlot,
  sendCancel,
  sendConfig,
  sendStart,
  startLobbyDraft,
  toggleLobbyPremadeLink,
  updateLobbyConfig,
  updateLobbyMode,
  userId,
} from '~/client/stores'

interface ConfigScreenProps {
  lobby?: LobbySnapshot
  onLobbyStarted?: (matchId: string) => void
  onSwitchTarget?: () => void
}

/** Pre-draft setup screen (lobby waiting + room waiting). */
export function ConfigScreen(props: ConfigScreenProps) {
  const state = () => draftStore.state
  const [lobbyState, setLobbyState] = createSignal<LobbySnapshot | null>(props.lobby ?? null)
  const [banMinutes, setBanMinutes] = createSignal('')
  const [pickMinutes, setPickMinutes] = createSignal('')
  const [editingField, setEditingField] = createSignal<'ban' | 'pick' | null>(null)
  const [configMessage, setConfigMessage] = createSignal<string | null>(null)
  const [configMessageTone, setConfigMessageTone] = createSignal<'error' | 'info' | null>(null)
  const [cancelPending, setCancelPending] = createSignal(false)
  const [startPending, setStartPending] = createSignal(false)
  const [lobbyActionPending, setLobbyActionPending] = createSignal(false)
  const [draggingPlayerId, setDraggingPlayerId] = createSignal<string | null>(null)
  const [dragOverSlot, setDragOverSlot] = createSignal<number | null>(null)
  const [optimisticLobbyAction, setOptimisticLobbyAction] = createSignal<OptimisticLobbyAction | null>(null)
  let optimisticLobbyActionTimeout: ReturnType<typeof setTimeout> | null = null
  let bootstrapJoinHintUsed = false
  const [lobbyTimerConfig, setLobbyTimerConfig] = createSignal<DraftTimerConfig | null>(
    props.lobby
      ? {
          banTimerSeconds: props.lobby.draftConfig.banTimerSeconds,
          pickTimerSeconds: props.lobby.draftConfig.pickTimerSeconds,
        }
      : null,
  )
  const [rankedRoleOptions, setRankedRoleOptions] = createSignal<RankedRoleOptionSnapshot[]>([])
  const [minRoleMismatchDetail, setMinRoleMismatchDetail] = createSignal<MinRoleMismatchDetail | null>(null)
  const [minRoleSetDetail, setMinRoleSetDetail] = createSignal<MinRoleSetDetail | null>(null)
  let rankedRoleOptionsFetchKey: string | null = null

  createEffect(() => {
    const incomingLobby = props.lobby ?? null
    setLobbyState((current) => {
      if (!incomingLobby) return null
      if (current && incomingLobby.revision < current.revision) return current
      return incomingLobby
    })
  })

  createEffect(() => {
    const lobby = lobbyState()
    if (!lobby) {
      setLobbyTimerConfig(null)
      return
    }

    setLobbyTimerConfig({
      banTimerSeconds: lobby.draftConfig.banTimerSeconds,
      pickTimerSeconds: lobby.draftConfig.pickTimerSeconds,
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

    if (lobby.revision > action.baseRevision) {
      clearOptimisticLobbyAction()
      return
    }

    if (Date.now() > action.expiresAt) {
      clearOptimisticLobbyAction()
      return
    }

    if (action.kind === 'place-self' || action.kind === 'remove-self') {
      const currentSlot = lobby.entries.findIndex(entry => entry?.playerId === currentUserId)

      if (action.kind === 'place-self' && currentSlot === action.targetSlot) {
        clearOptimisticLobbyAction()
        return
      }

      if (action.kind === 'remove-self' && currentSlot < 0) {
        clearOptimisticLobbyAction()
      }
    }
  })

  const startOptimisticLobbyAction = (action: PendingOptimisticLobbyAction) => {
    clearOptimisticLobbyAction()
    const expiresAt = Date.now() + 2500
    const baseRevision = lobbyState()?.revision ?? 0
    const next = {
      ...action,
      baseRevision,
      expiresAt,
    } as OptimisticLobbyAction

    setOptimisticLobbyAction(next)
    optimisticLobbyActionTimeout = setTimeout(() => {
      setOptimisticLobbyAction((current) => {
        if (!current || current.expiresAt !== expiresAt) return current
        return null
      })
      optimisticLobbyActionTimeout = null
    }, 2500)
  }

  onCleanup(() => {
    clearOptimisticLobbyAction()
  })

  const currentLobby = () => applyOptimisticLobbyAction(
    lobbyState(),
    optimisticLobbyAction(),
    userId(),
    currentDisplayName(),
    currentAvatarUrl(),
  )
  const isLobbyMode = () => currentLobby() != null
  const hostId = () => currentLobby()?.hostId ?? draftStore.hostId ?? state()?.seats[0]?.playerId ?? null
  const amHost = () => {
    const id = userId()
    if (!id) return false
    return id === hostId()
  }

  createEffect(() => {
    const lobby = currentLobby()
    if (!lobby) {
      rankedRoleOptionsFetchKey = null
      setRankedRoleOptions([])
      return
    }

    const nextFetchKey = `${lobby.mode}:${lobby.id}`
    if (rankedRoleOptionsFetchKey === nextFetchKey) return
    rankedRoleOptionsFetchKey = nextFetchKey

    let cancelled = false
    void (async () => {
      const snapshot = await fetchLobbyRankedRoles(lobby.mode, lobby.id)
      if (cancelled) return
      setRankedRoleOptions(snapshot?.options ?? [])
    })()

    onCleanup(() => {
      cancelled = true
    })
  })

  const formatId = () => {
    const lobby = currentLobby()
    if (lobby) return formatModeLabel(lobby.mode, 'DRAFT')
    return formatModeLabel(state()?.formatId, 'DRAFT')
  }
  const isTeamMode = () => {
    const lobby = currentLobby()
    if (lobby) return inferGameMode(lobby.mode) !== 'ffa'
    return state()?.seats.some(s => s.team != null) ?? false
  }

  const timerConfig = (): DraftTimerConfig => {
    const lobby = currentLobby()
    if (lobby) {
      return lobbyTimerConfig() ?? {
        banTimerSeconds: lobby.draftConfig.banTimerSeconds,
        pickTimerSeconds: lobby.draftConfig.pickTimerSeconds,
      }
    }
    return getTimerConfigFromDraft(state())
  }

  const serverDefaultTimerConfig = (): DraftTimerConfig => {
    const lobby = currentLobby()
    if (!lobby) return { banTimerSeconds: null, pickTimerSeconds: null }
    return {
      banTimerSeconds: lobby.serverDefaults.banTimerSeconds,
      pickTimerSeconds: lobby.serverDefaults.pickTimerSeconds,
    }
  }

  const lobbyMinRoleValue = () => currentLobby()?.minRole ?? ''
  const formattedLobbyMinRole = () => formatLobbyMinRole(currentLobby()?.minRole ?? null, rankedRoleOptions())
  const minRoleDropdownOptions = () => [
    {
      value: '',
      label: 'Anyone',
      render: () => (
        <span class="flex gap-2 items-center">
          <span class="rounded-full bg-white/25 h-2.5 w-2.5" />
          Anyone
        </span>
      ),
    },
    ...rankedRoleOptions().map(option => ({
      value: option.tier,
      label: option.label,
      render: () => (
        <span class="flex gap-2 items-center">
          <span class="rounded-full h-2.5 w-2.5" style={buildRankDotStyle(option.color)} />
          {option.label}
        </span>
      ),
    })),
  ]

  const banTimerPlaceholder = () => timerSecondsToMinutesPlaceholder(serverDefaultTimerConfig().banTimerSeconds)
  const pickTimerPlaceholder = () => timerSecondsToMinutesPlaceholder(serverDefaultTimerConfig().pickTimerSeconds)

  const optimisticTimerConfig = createOptimisticState(timerConfig, {
    equals: (a, b) => a.banTimerSeconds === b.banTimerSeconds && a.pickTimerSeconds === b.pickTimerSeconds,
  })

  const clearConfigMessage = () => {
    setConfigMessage(null)
    setConfigMessageTone(null)
    setMinRoleMismatchDetail(null)
    setMinRoleSetDetail(null)
  }

  const showErrorMessage = (message: string) => {
    setConfigMessage(message)
    setConfigMessageTone('error')
    setMinRoleMismatchDetail(null)
    setMinRoleSetDetail(null)
  }

  const showInfoMessage = (message: string) => {
    setConfigMessage(message)
    setConfigMessageTone('info')
    setMinRoleMismatchDetail(null)
    setMinRoleSetDetail(null)
  }

  const showMinRoleMismatchMessage = (detail: MinRoleMismatchDetail) => {
    setConfigMessage(`${detail.playerName} does not meet the new minimum rank ${detail.roleLabel}`)
    setConfigMessageTone('error')
    setMinRoleMismatchDetail(detail)
    setMinRoleSetDetail(null)
  }

  const showMinRoleSetMessage = (detail: MinRoleSetDetail) => {
    setConfigMessage(`Minimum rank set to ${detail.roleLabel}`)
    setConfigMessageTone('info')
    setMinRoleMismatchDetail(null)
    setMinRoleSetDetail(detail)
  }

  createEffect(() => {
    const config = optimisticTimerConfig.value()
    if (editingField() !== 'ban') setBanMinutes(timerSecondsToMinutesInput(config.banTimerSeconds))
    if (editingField() !== 'pick') setPickMinutes(timerSecondsToMinutesInput(config.pickTimerSeconds))
  })

  createEffect(() => {
    const status = optimisticTimerConfig.status()
    if (status === 'error') {
      showErrorMessage(optimisticTimerConfig.error() ?? 'Failed to save changes.')
    }
  })

  createEffect(() => {
    if (bootstrapJoinHintUsed) return
    if (optimisticLobbyAction()) return

    const lobby = lobbyState()
    const currentUserId = userId()
    if (!lobby || !currentUserId || lobby.status !== 'open') return

    if (lobby.hostId === currentUserId) {
      bootstrapJoinHintUsed = true
      return
    }

    if (lobby.entries.some(entry => entry?.playerId === currentUserId)) {
      bootstrapJoinHintUsed = true
      return
    }

    const firstEmptySlot = lobby.entries.findIndex(entry => entry == null)
    if (firstEmptySlot < 0) {
      bootstrapJoinHintUsed = true
      return
    }

    bootstrapJoinHintUsed = true
    startOptimisticLobbyAction({
      kind: 'place-self',
      targetSlot: firstEmptySlot,
    })
  })

  const applyLobbySnapshot = (lobby: LobbySnapshot) => {
    setLobbyState((current) => {
      if (current && lobby.revision < current.revision) return current
      return lobby
    })
    const resolvedLobby = lobbyState()
    if (!resolvedLobby) return
    setLobbyTimerConfig({
      banTimerSeconds: resolvedLobby.draftConfig.banTimerSeconds,
      pickTimerSeconds: resolvedLobby.draftConfig.pickTimerSeconds,
    })
  }

  const teamRows = (team: 0 | 1): PlayerRow[] => {
    const lobby = currentLobby()
    if (lobby) {
      const size = Math.max(1, Math.floor(lobby.targetSize / 2))
      const start = team === 0 ? 0 : size
      return Array.from({ length: size }, (_, i) => {
        const slot = start + i
        const entry = lobby.entries[slot] ?? null
        return {
          key: `lobby-${slot}`,
          slot,
          name: entry?.displayName ?? '[empty]',
          playerId: entry?.playerId ?? null,
          avatarUrl: entry?.avatarUrl ?? null,
          partyIds: entry?.partyIds ?? [],
          isHost: entry?.playerId === hostId(),
          empty: entry == null,
        }
      })
    }

    const seats = state()?.seats.filter(seat => seat.team === team) ?? []
    return seats.map((seat, index) => ({
      key: `room-${team}-${seat.playerId}`,
      slot: index,
      name: seat.displayName,
      playerId: seat.playerId,
      avatarUrl: seat.avatarUrl ?? null,
      partyIds: [],
      isHost: seat.playerId === hostId(),
      empty: false,
    }))
  }

  const ffaRows = (): PlayerRow[] => {
    const lobby = currentLobby()
    if (lobby) {
      return Array.from({ length: lobby.targetSize }, (_, i) => {
        const entry = lobby.entries[i] ?? null
        return {
          key: `lobby-ffa-${i}`,
          slot: i,
          name: entry?.displayName ?? '[empty]',
          playerId: entry?.playerId ?? null,
          avatarUrl: entry?.avatarUrl ?? null,
          partyIds: entry?.partyIds ?? [],
          isHost: entry?.playerId === hostId(),
          empty: entry == null,
        }
      })
    }

    return (state()?.seats ?? []).map((seat, i) => ({
      key: `room-ffa-${seat.playerId}`,
      slot: i,
      name: seat.displayName,
      playerId: seat.playerId,
      avatarUrl: seat.avatarUrl ?? null,
      partyIds: [],
      isHost: seat.playerId === hostId(),
      empty: false,
    }))
  }

  const ffaFirstColumn = () => {
    const rows = ffaRows()
    const half = Math.ceil(rows.length / 2)
    return rows.slice(0, half)
  }

  const ffaSecondColumn = () => {
    const rows = ffaRows()
    const half = Math.ceil(rows.length / 2)
    return rows.slice(half)
  }

  const lobbyMode = (): LobbyModeValue => {
    return inferGameMode(currentLobby()?.mode ?? state()?.formatId)
  }

  const filledSlots = () => {
    const lobby = currentLobby()
    if (!lobby) return 0
    return lobby.entries.filter(entry => entry != null).length
  }

  const canStartLobby = () => {
    const lobby = currentLobby()
    if (!lobby) return false
    const filled = filledSlots()
    if (lobby.mode === 'ffa') {
      return filled >= lobby.minPlayers && filled <= lobby.targetSize
    }
    return filled === lobby.targetSize
  }

  const isCurrentUserSlotted = () => {
    const id = userId()
    if (!id) return false
    return currentLobby()?.entries.some(entry => entry?.playerId === id) ?? false
  }

  const currentUserLinkedPartySize = () => {
    const id = userId()
    if (!id) return 0
    const entry = currentLobby()?.entries.find(candidate => candidate?.playerId === id)
    return entry?.partyIds?.length ?? 0
  }

  const canJoinSlot = (row: PlayerRow) => {
    if (!isLobbyMode()) return false
    if (!row.empty) return false
    if (!userId()) return false
    if (!amHost() && currentUserLinkedPartySize() > 0) return false
    return true
  }

  const canRemoveSlot = (row: PlayerRow) => {
    if (!isLobbyMode()) return false
    if (row.empty || !row.playerId) return false
    if (row.isHost) return false
    const id = userId()
    if (!id) return false
    if (amHost()) return true
    return row.playerId === id
  }

  const canDragRow = (row: PlayerRow) => {
    if (!isLobbyMode()) return false
    if (lobbyActionPending()) return false
    if (row.empty || !row.playerId) return false
    const id = userId()
    if (!id) return false
    if (amHost()) return true
    if (row.partyIds.length > 0) return false
    return row.playerId === id
  }

  const canDropOnRow = (row: PlayerRow) => {
    if (!isLobbyMode()) return false
    if (lobbyActionPending()) return false
    const dragged = draggingPlayerId()
    const id = userId()
    if (!dragged || !id) return false
    if (amHost()) return true
    if (currentUserLinkedPartySize() > 0) return false
    return dragged === id && row.empty
  }

  const saveConfigOnBlur = async () => {
    const isHostUser = amHost()
    const nextBanMinutes = banMinutes()
    const nextPickMinutes = pickMinutes()

    try {
      if (!isHostUser) return

      const parsedBan = parseTimerMinutesInput(nextBanMinutes)
      const parsedPick = parseTimerMinutesInput(nextPickMinutes)
      if (parsedBan === undefined || parsedPick === undefined) {
        optimisticTimerConfig.clearError()
        showErrorMessage(`Use whole minutes between 0 and ${MAX_TIMER_MINUTES}.`)
        const current = optimisticTimerConfig.value()
        setBanMinutes(timerSecondsToMinutesInput(current.banTimerSeconds))
        setPickMinutes(timerSecondsToMinutesInput(current.pickTimerSeconds))
        return
      }

      const banTimerSeconds = parsedBan == null ? null : parsedBan * 60
      const pickTimerSeconds = parsedPick == null ? null : parsedPick * 60
      const current = optimisticTimerConfig.value()

      if (banTimerSeconds === current.banTimerSeconds && pickTimerSeconds === current.pickTimerSeconds) {
        optimisticTimerConfig.clearError()
        return
      }

      const currentUserId = userId()
      if (!currentUserId) {
        optimisticTimerConfig.clearError()
        showErrorMessage('Could not identify your Discord user. Reopen the activity.')
        return
      }

      clearConfigMessage()
      await optimisticTimerConfig.commit({ banTimerSeconds, pickTimerSeconds }, async () => {
        const lobby = currentLobby()
        if (lobby) {
          const result = await updateLobbyConfig(lobby.mode, lobby.id, currentUserId, {
            banTimerSeconds,
            pickTimerSeconds,
            minRole: lobby.minRole,
          })
          if (!result.ok) throw new Error(result.error)
          applyLobbySnapshot(result.lobby)
          return
        }

        await sendConfig(banTimerSeconds, pickTimerSeconds)
      }, {
        syncTimeoutMs: currentLobby() ? 9000 : 5000,
        syncTimeoutMessage: 'Save not confirmed. Please try again.',
      })
    }
    finally {
      setEditingField(null)
    }
  }

  const handleLobbyModeChange = async (nextMode: LobbyModeValue) => {
    const lobby = currentLobby()
    const currentUserId = userId()
    if (!lobby || !currentUserId || !amHost()) return
    if (lobby.mode === nextMode) return
    if (lobbyActionPending()) return

    setLobbyActionPending(true)
    clearConfigMessage()
    try {
      const result = await updateLobbyMode(lobby.mode, lobby.id, currentUserId, nextMode)
      if (!result.ok) {
        showErrorMessage(result.error)
        return
      }
      applyLobbySnapshot(result.lobby)
      showInfoMessage(`Lobby mode changed to ${formatModeLabel(result.lobby.mode, result.lobby.mode)}.`)
    }
    finally {
      setLobbyActionPending(false)
    }
  }

  const handleLobbyMinRoleChange = async (value: string) => {
    const lobby = currentLobby()
    const currentUserId = userId()
    if (!lobby || !currentUserId || !amHost()) return
    if (lobbyActionPending()) return

    const nextMinRole = normalizeLobbyMinRoleValue(value)
    if (lobby.minRole === nextMinRole) return

    setLobbyActionPending(true)
    clearConfigMessage()
    try {
      const result = await updateLobbyConfig(lobby.mode, lobby.id, currentUserId, {
        banTimerSeconds: timerConfig().banTimerSeconds,
        pickTimerSeconds: timerConfig().pickTimerSeconds,
        minRole: nextMinRole,
      })
      if (!result.ok) {
        if (result.errorCode === 'MIN_ROLE_MEMBER_MISMATCH' && result.context?.minRole) {
          showMinRoleMismatchMessage({
            playerName: result.context.playerName,
            roleLabel: result.context.minRole.label,
            roleColor: result.context.minRole.color,
          })
          return
        }
        showErrorMessage(result.error)
        return
      }

      applyLobbySnapshot(result.lobby)
      const refreshedOptions = await fetchLobbyRankedRoles(result.lobby.mode, result.lobby.id)
      if (refreshedOptions?.options?.length) setRankedRoleOptions(refreshedOptions.options)
      const optionSource = refreshedOptions?.options?.length ? refreshedOptions.options : rankedRoleOptions()
      const selectedMinRole = nextMinRole ? findRankedRoleOptionByTier(optionSource, nextMinRole) : null
      if (nextMinRole) {
        showMinRoleSetMessage({
          roleLabel: selectedMinRole?.label ?? 'Unranked',
          roleColor: selectedMinRole?.color ?? null,
        })
      }
      else {
        showInfoMessage('Minimum rank cleared')
      }
    }
    finally {
      setLobbyActionPending(false)
    }
  }

  const handleFillTestPlayers = async () => {
    const lobby = currentLobby()
    const currentUserId = userId()
    if (!lobby || !currentUserId || !amHost()) return
    if (lobbyActionPending() || startPending() || cancelPending()) return

    setLobbyActionPending(true)
    clearConfigMessage()
    try {
      const result = await fillLobbyWithTestPlayers(lobby.mode, lobby.id, currentUserId)
      if (!result.ok) {
        showErrorMessage(result.error)
        return
      }

      applyLobbySnapshot(result.lobby)
      if (result.addedCount > 0) {
        showInfoMessage(`Added ${result.addedCount} test player${result.addedCount === 1 ? '' : 's'} to empty slots.`)
      }
      else {
        showInfoMessage('Lobby is already full.')
      }
    }
    finally {
      setLobbyActionPending(false)
    }
  }

  const handlePlaceSelf = async (slot: number) => {
    const lobby = currentLobby()
    const currentUserId = userId()
    if (!lobby || !currentUserId) return
    if (lobbyActionPending()) return

    startOptimisticLobbyAction({ kind: 'place-self', targetSlot: slot })
    setLobbyActionPending(true)
    clearConfigMessage()
    try {
      const result = await placeLobbySlot(lobby.mode, {
        lobbyId: lobby.id,
        userId: currentUserId,
        targetSlot: slot,
        displayName: currentDisplayName(),
        avatarUrl: currentAvatarUrl(),
      })
      if (!result.ok) {
        clearOptimisticLobbyAction()
        showErrorMessage(result.error)
        return
      }
      applyLobbySnapshot(result.lobby)
      clearOptimisticLobbyAction()
    }
    finally {
      setLobbyActionPending(false)
    }
  }

  const handleDropOnSlot = async (slot: number) => {
    const lobby = currentLobby()
    const currentUserId = userId()
    const draggedPlayerId = draggingPlayerId()
    if (!lobby || !currentUserId || !draggedPlayerId) return
    if (lobbyActionPending()) return

    const payload: {
      lobbyId: string
      userId: string
      targetSlot: number
      playerId?: string
      displayName?: string
      avatarUrl?: string | null
    } = {
      lobbyId: lobby.id,
      userId: currentUserId,
      targetSlot: slot,
      displayName: currentDisplayName(),
      avatarUrl: currentAvatarUrl(),
    }

    if (amHost() && draggedPlayerId !== currentUserId) {
      payload.playerId = draggedPlayerId
    }

    const draggedEntry = lobby.entries.find(entry => entry?.playerId === draggedPlayerId) ?? null
    const isLinkedDrag = isTeamMode() && (draggedEntry?.partyIds?.length ?? 0) > 0

    let optimisticAction: PendingOptimisticLobbyAction | null = null
    if (draggedPlayerId === currentUserId && !isLinkedDrag) {
      optimisticAction = { kind: 'place-self', targetSlot: slot }
    }
    else if (amHost() && !isLinkedDrag) {
      optimisticAction = { kind: 'move-player', playerId: draggedPlayerId, targetSlot: slot }
    }

    if (optimisticAction) {
      startOptimisticLobbyAction(optimisticAction)
    }

    setLobbyActionPending(true)
    clearConfigMessage()
    try {
      const result = await placeLobbySlot(lobby.mode, payload)
      if (!result.ok) {
        if (optimisticAction) clearOptimisticLobbyAction()
        showErrorMessage(result.error)
        return
      }
      applyLobbySnapshot(result.lobby)
      if (optimisticAction) clearOptimisticLobbyAction()
    }
    finally {
      setLobbyActionPending(false)
      setDraggingPlayerId(null)
      setDragOverSlot(null)
    }
  }

  const handleRemoveFromSlot = async (slot: number) => {
    const lobby = currentLobby()
    const currentUserId = userId()
    if (!lobby || !currentUserId) return
    if (lobbyActionPending()) return

    const removingPlayerId = lobby.entries[slot]?.playerId ?? null
    let optimisticAction: PendingOptimisticLobbyAction | null = null
    if (removingPlayerId === currentUserId) {
      optimisticAction = { kind: 'remove-self' }
    }
    else if (removingPlayerId && amHost()) {
      optimisticAction = { kind: 'remove-player', playerId: removingPlayerId }
    }

    if (optimisticAction) {
      startOptimisticLobbyAction(optimisticAction)
    }

    setLobbyActionPending(true)
    clearConfigMessage()
    try {
      const result = await removeLobbySlot(lobby.mode, {
        lobbyId: lobby.id,
        userId: currentUserId,
        slot,
      })
      if (!result.ok) {
        if (optimisticAction) clearOptimisticLobbyAction()
        showErrorMessage(result.error)
        return
      }
      applyLobbySnapshot(result.lobby)
      if (optimisticAction) clearOptimisticLobbyAction()
    }
    finally {
      setLobbyActionPending(false)
    }
  }

  const handleStartLobbyDraftAction = async () => {
    const lobby = currentLobby()
    const currentUserId = userId()
    if (!lobby || !currentUserId || !amHost()) return
    if (!canStartLobby() || startPending() || lobbyActionPending()) return

    setStartPending(true)
    clearConfigMessage()
    try {
      const result = await startLobbyDraft(lobby.mode, lobby.id, currentUserId)
      if (!result.ok) {
        showErrorMessage(result.error)
        return
      }

      props.onLobbyStarted?.(result.matchId)
      showInfoMessage('Draft room created. Opening draft...')
    }
    finally {
      setStartPending(false)
    }
  }

  const handleArrangeTeams = async (strategy: LobbyTeamArrangeStrategy) => {
    const lobby = currentLobby()
    const currentUserId = userId()
    if (!lobby || !currentUserId || !amHost()) return
    const mode = inferGameMode(lobby.mode)
    if (mode !== '2v2' && mode !== '3v3') return
    if (lobbyActionPending() || startPending() || cancelPending()) return

    setLobbyActionPending(true)
    clearConfigMessage()
    try {
      const result = await arrangeLobbyTeams(lobby.mode, lobby.id, currentUserId, strategy)
      if (!result.ok) {
        showErrorMessage(result.error)
        return
      }

      applyLobbySnapshot(result.lobby)
      showInfoMessage(strategy === 'randomize' ? 'Teams randomized.' : 'Teams auto-balanced.')
    }
    finally {
      setLobbyActionPending(false)
    }
  }

  const areRowsPremadeLinked = (leftRow: PlayerRow, rightRow: PlayerRow) => {
    if (!leftRow.playerId || !rightRow.playerId) return false
    return leftRow.partyIds.includes(rightRow.playerId) && rightRow.partyIds.includes(leftRow.playerId)
  }

  const canTogglePremadeLink = (leftRow: PlayerRow, rightRow: PlayerRow) => {
    const currentUserId = userId()
    if (!currentUserId || !isLobbyMode() || !isTeamMode()) return false
    if (lobbyActionPending() || startPending() || cancelPending()) return false
    if (!leftRow.playerId || !rightRow.playerId) return false
    if (amHost()) return true
    return leftRow.playerId === currentUserId || rightRow.playerId === currentUserId
  }

  const handleTogglePremadeLink = async (leftRow: PlayerRow, rightRow: PlayerRow) => {
    const lobby = currentLobby()
    const currentUserId = userId()
    if (!lobby || !currentUserId) return
    const mode = inferGameMode(lobby.mode)
    if (mode !== '2v2' && mode !== '3v3') return
    if (!canTogglePremadeLink(leftRow, rightRow)) return

    const currentlyLinked = areRowsPremadeLinked(leftRow, rightRow)
    setLobbyActionPending(true)
    clearConfigMessage()
    try {
      const result = await toggleLobbyPremadeLink(lobby.mode, lobby.id, currentUserId, leftRow.slot)
      if (!result.ok) {
        showErrorMessage(result.error)
        return
      }

      applyLobbySnapshot(result.lobby)
      showInfoMessage(currentlyLinked ? 'Premade link removed.' : 'Premade link added.')
    }
    finally {
      setLobbyActionPending(false)
    }
  }

  const renderTeamColumn = (rows: PlayerRow[]) => (
    <div class="flex flex-col">
      <For each={rows}>
        {(row, index) => {
          const nextRow = () => rows[index() + 1] ?? null
          return (
            <>
              <PlayerChip
                row={row}
                pending={lobbyActionPending()}
                draggable={canDragRow(row)}
                allowDrop={canDropOnRow(row)}
                dropActive={canDropOnRow(row) && dragOverSlot() === row.slot}
                showJoin={canJoinSlot(row)}
                showRemove={canRemoveSlot(row)}
                onJoin={() => void handlePlaceSelf(row.slot)}
                onRemove={() => void handleRemoveFromSlot(row.slot)}
                onDragStart={() => {
                  if (!row.playerId) return
                  setDraggingPlayerId(row.playerId)
                }}
                onDragEnd={() => {
                  setDraggingPlayerId(null)
                  setDragOverSlot(null)
                }}
                onDragEnter={() => setDragOverSlot(row.slot)}
                onDragLeave={() => { if (dragOverSlot() === row.slot) setDragOverSlot(null) }}
                onDrop={() => void handleDropOnSlot(row.slot)}
              />
              <Show when={nextRow()}>
                {(next) => {
                  const linked = () => areRowsPremadeLinked(row, next())
                  const canToggle = () => canTogglePremadeLink(row, next())
                  return (
                    <PremadeLinkButton
                      linked={linked()}
                      interactive={canToggle()}
                      pending={lobbyActionPending()}
                      title={linked() ? 'Unlink premade' : 'Link premade'}
                      onToggle={() => void handleTogglePremadeLink(row, next())}
                    />
                  )
                }}
              </Show>
            </>
          )
        }}
      </For>
    </div>
  )

  const handleCancelAction = async () => {
    if (cancelPending()) return

    const lobby = currentLobby()
    if (lobby) {
      const currentUserId = userId()
      if (!currentUserId) {
        showErrorMessage('Could not identify your Discord user. Reopen the activity.')
        return
      }

      setCancelPending(true)
      clearConfigMessage()
      try {
        const result = await cancelLobby(lobby.mode, lobby.id, currentUserId)
        if (!result.ok) {
          showErrorMessage(result.error)
          return
        }
        showInfoMessage('Lobby cancelled. Closing...')
      }
      finally {
        setCancelPending(false)
      }
      return
    }

    sendCancel('cancel')
  }

  return (
    <div class="text-text-primary font-sans bg-bg-primary overflow-y-auto min-h-dvh">
      <div class="mx-auto px-6 py-4 flex flex-col gap-6 max-w-5xl w-full">
        <div class="grid grid-cols-[2.25rem_minmax(0,1fr)_2.25rem] items-center">
          <div class="h-9 w-9" />
          <div class="text-center">
            <h1 class="text-2xl text-heading mb-1">Draft Setup</h1>
            <span class="text-sm text-accent-gold font-medium">{formatId()}</span>
          </div>

          <Show when={props.onSwitchTarget} fallback={<div class="h-9 w-9" />}>
            <button
              type="button"
              class="text-text-secondary border border-border-subtle rounded-md flex shrink-0 h-9 w-9 cursor-pointer transition-colors items-center justify-center hover:text-text-primary hover:bg-bg-hover"
              title="Lobby Overview"
              aria-label="Lobby Overview"
              onClick={() => props.onSwitchTarget?.()}
            >
              <span class="i-ph-squares-four-bold text-base" />
            </button>
          </Show>
        </div>

        <div class="gap-4 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div class="p-4 rounded-lg bg-bg-secondary">
            <div class="text-xs text-text-muted tracking-widest font-bold mb-3 uppercase">Players</div>

            <Show
              when={isTeamMode()}
              fallback={(
                <div class="gap-3 grid grid-cols-2">
                  <div class="flex flex-col gap-2">
                    <For each={ffaFirstColumn()}>
                      {row => (
                        <PlayerChip
                          row={row}
                          pending={lobbyActionPending()}
                          draggable={canDragRow(row)}
                          allowDrop={canDropOnRow(row)}
                          dropActive={canDropOnRow(row) && dragOverSlot() === row.slot}
                          showJoin={canJoinSlot(row)}
                          showRemove={canRemoveSlot(row)}
                          onJoin={() => void handlePlaceSelf(row.slot)}
                          onRemove={() => void handleRemoveFromSlot(row.slot)}
                          onDragStart={() => {
                            if (!row.playerId) return
                            setDraggingPlayerId(row.playerId)
                          }}
                          onDragEnd={() => {
                            setDraggingPlayerId(null)
                            setDragOverSlot(null)
                          }}
                          onDragEnter={() => setDragOverSlot(row.slot)}
                          onDragLeave={() => { if (dragOverSlot() === row.slot) setDragOverSlot(null) }}
                          onDrop={() => void handleDropOnSlot(row.slot)}
                        />
                      )}
                    </For>
                  </div>
                  <div class="flex flex-col gap-2">
                    <For each={ffaSecondColumn()}>
                      {row => (
                        <PlayerChip
                          row={row}
                          pending={lobbyActionPending()}
                          draggable={canDragRow(row)}
                          allowDrop={canDropOnRow(row)}
                          dropActive={canDropOnRow(row) && dragOverSlot() === row.slot}
                          showJoin={canJoinSlot(row)}
                          showRemove={canRemoveSlot(row)}
                          onJoin={() => void handlePlaceSelf(row.slot)}
                          onRemove={() => void handleRemoveFromSlot(row.slot)}
                          onDragStart={() => {
                            if (!row.playerId) return
                            setDraggingPlayerId(row.playerId)
                          }}
                          onDragEnd={() => {
                            setDraggingPlayerId(null)
                            setDragOverSlot(null)
                          }}
                          onDragEnter={() => setDragOverSlot(row.slot)}
                          onDragLeave={() => { if (dragOverSlot() === row.slot) setDragOverSlot(null) }}
                          onDrop={() => void handleDropOnSlot(row.slot)}
                        />
                      )}
                    </For>
                  </div>
                </div>
              )}
            >
              <div class="gap-4 grid grid-cols-2">
                <div>
                  <div class="text-xs text-accent-gold tracking-wider font-bold mb-2">Team A</div>
                  {renderTeamColumn(teamRows(0))}
                </div>
                <div>
                  <div class="text-xs text-accent-gold tracking-wider font-bold mb-2">Team B</div>
                  {renderTeamColumn(teamRows(1))}
                </div>
              </div>
            </Show>
          </div>

          <div class="p-4 rounded-lg bg-bg-secondary flex flex-col gap-3">
            <div class="text-xs text-text-muted tracking-widest font-bold flex uppercase items-center justify-between">
              <span>Config</span>
              <span class="flex h-4 w-4 items-center justify-center">
                <Show when={optimisticTimerConfig.status() === 'pending' || lobbyActionPending() || startPending()}>
                  <span class="i-gg:spinner text-sm text-accent-gold animate-spin" />
                </Show>
              </span>
            </div>

            <Show when={isLobbyMode() && amHost()}>
              <Dropdown
                label="Game Mode"
                value={lobbyMode()}
                disabled={lobbyActionPending()}
                options={GAME_MODE_CHOICES.map(choice => ({ value: choice.value, label: choice.name }))}
                onChange={value => void handleLobbyModeChange(inferGameMode(value))}
              />
            </Show>

            <Show
              when={amHost()}
              fallback={(
                <div class="flex flex-col gap-2">
                  <ReadonlyTimerRow
                    label="Min rank"
                    value={formattedLobbyMinRole()}
                  />
                  <ReadonlyTimerRow
                    label="Ban timer"
                    value={formatTimerValue(timerConfig().banTimerSeconds, serverDefaultTimerConfig().banTimerSeconds)}
                  />
                  <ReadonlyTimerRow
                    label="Pick timer"
                    value={formatTimerValue(timerConfig().pickTimerSeconds, serverDefaultTimerConfig().pickTimerSeconds)}
                  />
                </div>
              )}
            >
              <div class="flex flex-col gap-2">
                <Dropdown
                  label="Minimum Rank"
                  value={lobbyMinRoleValue()}
                  disabled={lobbyActionPending()}
                  options={minRoleDropdownOptions()}
                  onChange={value => void handleLobbyMinRoleChange(value)}
                />

                <TextInput
                  type="number"
                  label="Ban Timer (minutes)"
                  min="0"
                  max={String(MAX_TIMER_MINUTES)}
                  step="1"
                  value={banMinutes()}
                  placeholder={banTimerPlaceholder()}
                  onFocus={() => setEditingField('ban')}
                  onInput={(event) => {
                    optimisticTimerConfig.clearError()
                    clearConfigMessage()
                    const normalized = normalizeTimerMinutesInput(event.currentTarget.value)
                    event.currentTarget.value = normalized
                    setBanMinutes(normalized)
                  }}
                  onBlur={() => void saveConfigOnBlur()}
                />

                <TextInput
                  type="number"
                  label="Pick Timer (minutes)"
                  min="0"
                  max={String(MAX_TIMER_MINUTES)}
                  step="1"
                  value={pickMinutes()}
                  placeholder={pickTimerPlaceholder()}
                  onFocus={() => setEditingField('pick')}
                  onInput={(event) => {
                    optimisticTimerConfig.clearError()
                    clearConfigMessage()
                    const normalized = normalizeTimerMinutesInput(event.currentTarget.value)
                    event.currentTarget.value = normalized
                    setPickMinutes(normalized)
                  }}
                  onBlur={() => void saveConfigOnBlur()}
                />
              </div>
            </Show>

            <div class="min-h-5">
              <Show when={configMessage()}>
                <div class="text-xs text-text-primary flex gap-1.5 items-center">
                  <span class={cn(
                    'text-base shrink-0 self-center',
                    configMessageTone() === 'error'
                      ? 'i-ph-x-bold text-accent-red'
                      : 'i-ph-check-bold text-accent-gold',
                  )}
                  />
                  <Show
                    when={configMessageTone() === 'error' && minRoleMismatchDetail()}
                    fallback={(
                      <Show
                        when={configMessageTone() === 'info' && minRoleSetDetail()}
                        fallback={<span class="leading-relaxed">{configMessage()}</span>}
                      >
                        <MinRoleSetNotice detail={minRoleSetDetail()!} />
                      </Show>
                    )}
                  >
                    <MinRoleMismatchNotice detail={minRoleMismatchDetail()!} />
                  </Show>
                </div>
              </Show>
            </div>
          </div>
        </div>

        <div class="flex justify-center">
          <Show
            when={amHost()}
            fallback={(
              <span class="text-sm text-text-muted">
                {isLobbyMode()
                  ? isCurrentUserSlotted() ? 'Waiting for host to start...' : 'Spectating - waiting for host to start'
                  : isSpectator() ? 'Spectating - waiting for host to start' : 'Waiting for host to start...'}
              </span>
            )}
          >
            <Show
              when={!isLobbyMode()}
              fallback={(
                <div class="flex gap-3 items-center">
                  <button
                    class="text-sm text-black font-bold px-8 py-2.5 rounded-lg bg-accent-gold cursor-pointer transition-colors hover:bg-accent-gold/80 disabled:opacity-60 disabled:cursor-not-allowed"
                    disabled={!canStartLobby() || startPending() || lobbyActionPending()}
                    onClick={() => void handleStartLobbyDraftAction()}
                  >
                    {startPending() ? 'Starting...' : 'Start Draft'}
                  </button>
                  <button
                    class="text-sm text-text-secondary px-6 py-2.5 border border-white/12 rounded-lg bg-white/3 cursor-pointer transition-colors hover:text-text-primary hover:border-white/20 hover:bg-white/6 disabled:opacity-60 disabled:cursor-not-allowed"
                    disabled={cancelPending() || startPending() || lobbyActionPending()}
                    onClick={() => void handleCancelAction()}
                  >
                    {cancelPending() ? 'Cancelling...' : 'Cancel Lobby'}
                  </button>
                  <Show when={lobbyMode() === '2v2' || lobbyMode() === '3v3'}>
                    <button
                      class="text-text-secondary border border-white/12 rounded-lg bg-white/3 flex h-10 w-10 cursor-pointer transition-colors items-center justify-center hover:text-text-primary hover:border-white/20 hover:bg-white/6 disabled:opacity-60 disabled:cursor-not-allowed"
                      title="Randomize"
                      aria-label="Randomize teams"
                      disabled={cancelPending() || startPending() || lobbyActionPending()}
                      onClick={() => void handleArrangeTeams('randomize')}
                    >
                      <span class="i-ph:shuffle-simple-bold text-lg" />
                    </button>
                    <button
                      class="text-text-secondary border border-white/12 rounded-lg bg-white/3 flex h-10 w-10 cursor-pointer transition-colors items-center justify-center hover:text-text-primary hover:border-white/20 hover:bg-white/6 disabled:opacity-60 disabled:cursor-not-allowed"
                      title="Auto-balance"
                      aria-label="Auto-balance teams"
                      disabled={cancelPending() || startPending() || lobbyActionPending()}
                      onClick={() => void handleArrangeTeams('balance')}
                    >
                      <span class="i-ph:scales-bold text-lg" />
                    </button>
                  </Show>
                  <Show when={isDev()}>
                    <button
                      class="text-sm text-text-secondary px-6 py-2.5 border border-white/12 rounded-lg bg-white/3 cursor-pointer transition-colors hover:text-text-primary hover:border-white/20 hover:bg-white/6 disabled:opacity-60 disabled:cursor-not-allowed"
                      disabled={cancelPending() || startPending() || lobbyActionPending()}
                      onClick={() => void handleFillTestPlayers()}
                    >
                      Fill Test Players
                    </button>
                  </Show>
                </div>
              )}
            >
              <div class="flex gap-3 items-center">
                <button
                  class="text-sm text-black font-bold px-8 py-2.5 rounded-lg bg-accent-gold cursor-pointer transition-colors hover:bg-accent-gold/80"
                  onClick={sendStart}
                >
                  Start Draft
                </button>
                <button
                  class="text-sm text-text-secondary px-6 py-2.5 border border-white/12 rounded-lg bg-white/3 cursor-pointer transition-colors hover:text-text-primary hover:border-white/20 hover:bg-white/6"
                  onClick={() => void handleCancelAction()}
                >
                  Cancel Draft
                </button>
              </div>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  )
}
