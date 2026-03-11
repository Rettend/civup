import type { MiniSeatItem } from './MiniLayout'
import type {
  DraftTimerConfig,
  LobbyModeValue,
  MinRoleSetDetail,
  OptimisticLobbyAction,
  PendingOptimisticLobbyAction,
  PlayerRow,
} from '~/client/lib/config-screen/helpers'
import type { LobbyJoinEligibilitySnapshot, LobbySnapshot, LobbyTeamArrangeStrategy, RankedRoleOptionSnapshot } from '~/client/stores'
import { formatModeLabel, GAME_MODE_CHOICES, inferGameMode } from '@civup/game'
import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'
import { Dropdown, TextInput } from '~/client/components/ui'
import {
  applyOptimisticLobbyAction,
  buildRankDotStyle,
  findRankedRoleOptionByTier,
  formatLeaderPoolValue,
  formatLobbyMinRole,
  formatTimerValue,
  getLeaderPoolSizeMinimum,
  getTimerConfigFromDraft,
  leaderPoolSizePlaceholder,
  leaderPoolSizeToInput,
  MAX_LEADER_POOL_INPUT,
  MAX_TIMER_MINUTES,
  normalizeLeaderPoolSizeInput,
  normalizeLobbyMinRoleValue,
  normalizeTimerMinutesInput,
  parseLeaderPoolSizeInput,
  parseTimerMinutesInput,
  resolvePendingJoinGhostSlot,
  timerSecondsToMinutesInput,
  timerSecondsToMinutesPlaceholder,
} from '~/client/lib/config-screen/helpers'
import { MinRoleSetNotice, PlayerChip, PremadeLinkButton, ReadonlyTimerRow } from '~/client/lib/config-screen/parts'
import { cn } from '~/client/lib/css'
import { createOptimisticState } from '~/client/lib/optimistic-state'
import {
  arrangeLobbyTeams,
  canFillLobbyWithTestPlayers,
  cancelLobby,
  avatarUrl as currentAvatarUrl,
  displayName as currentDisplayName,
  draftStore,
  fetchLobbyRankedRoles,
  fillLobbyWithTestPlayers,
  isMiniView,
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
import { MiniFrame, MiniSeatGrid } from './MiniLayout'

interface ConfigScreenProps {
  lobby?: LobbySnapshot
  showJoinPending?: boolean
  joinEligibility?: LobbyJoinEligibilitySnapshot
  onLobbyStarted?: (matchId: string) => void
  onSwitchTarget?: () => void
}

interface LobbyEditableDraftConfig extends DraftTimerConfig {
  leaderPoolSize: number | null
}

const CONFIG_MESSAGE_TIMEOUT_MS = 4000

/** Pre-draft setup screen (lobby waiting + room waiting). */
export function ConfigScreen(props: ConfigScreenProps) {
  const state = () => draftStore.state
  const [lobbyState, setLobbyState] = createSignal<LobbySnapshot | null>(props.lobby ?? null)
  const [banMinutes, setBanMinutes] = createSignal('')
  const [pickMinutes, setPickMinutes] = createSignal('')
  const [leaderPoolInput, setLeaderPoolInput] = createSignal('')
  const [editingField, setEditingField] = createSignal<'ban' | 'pick' | 'leaderPool' | null>(null)
  const [configMessage, setConfigMessage] = createSignal<string | null>(null)
  const [configMessageTone, setConfigMessageTone] = createSignal<'error' | 'info' | null>(null)
  const [cancelPending, setCancelPending] = createSignal(false)
  const [startPending, setStartPending] = createSignal(false)
  const [lobbyActionPending, setLobbyActionPending] = createSignal(false)
  const [pendingPlaceSelfSlot, setPendingPlaceSelfSlot] = createSignal<number | null>(null)
  const [draggingPlayerId, setDraggingPlayerId] = createSignal<string | null>(null)
  const [dragOverSlot, setDragOverSlot] = createSignal<number | null>(null)
  const [optimisticLobbyAction, setOptimisticLobbyAction] = createSignal<OptimisticLobbyAction | null>(null)
  let optimisticLobbyActionTimeout: ReturnType<typeof setTimeout> | null = null
  let configMessageTimeout: ReturnType<typeof setTimeout> | null = null
  const [lobbyTimerConfig, setLobbyTimerConfig] = createSignal<LobbyEditableDraftConfig | null>(
    props.lobby
      ? {
          banTimerSeconds: props.lobby.draftConfig.banTimerSeconds,
          pickTimerSeconds: props.lobby.draftConfig.pickTimerSeconds,
          leaderPoolSize: props.lobby.draftConfig.leaderPoolSize,
        }
      : null,
  )
  const [rankedRoleOptions, setRankedRoleOptions] = createSignal<RankedRoleOptionSnapshot[]>([])
  const [fillTestPlayersAvailable, setFillTestPlayersAvailable] = createSignal(false)
  const [minRoleSetDetail, setMinRoleSetDetail] = createSignal<MinRoleSetDetail | null>(null)
  let fillTestPlayersAvailabilityKey: string | null = null
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
      leaderPoolSize: lobby.draftConfig.leaderPoolSize,
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
  const pendingSelfJoinSlot = () => resolvePendingJoinGhostSlot(
    currentLobby(),
    userId(),
    (props.showJoinPending === true) || pendingPlaceSelfSlot() != null,
    props.joinEligibility,
    pendingPlaceSelfSlot(),
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

  createEffect(() => {
    const lobby = currentLobby()
    if (!lobby) {
      fillTestPlayersAvailabilityKey = null
      setFillTestPlayersAvailable(false)
      return
    }

    const nextFetchKey = `${lobby.mode}:${lobby.id}`
    if (fillTestPlayersAvailabilityKey === nextFetchKey) return
    fillTestPlayersAvailabilityKey = nextFetchKey

    let cancelled = false
    void (async () => {
      const available = await canFillLobbyWithTestPlayers(lobby.mode)
      if (cancelled) return
      setFillTestPlayersAvailable(available)
    })()

    onCleanup(() => {
      cancelled = true
    })
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
    if (targetEntry && targetEntry.playerId !== currentUserId) {
      setPendingPlaceSelfSlot(null)
    }
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

  const draftConfig = (): LobbyEditableDraftConfig => {
    const lobby = currentLobby()
    if (lobby) {
      return lobbyTimerConfig() ?? {
        banTimerSeconds: lobby.draftConfig.banTimerSeconds,
        pickTimerSeconds: lobby.draftConfig.pickTimerSeconds,
        leaderPoolSize: lobby.draftConfig.leaderPoolSize,
      }
    }
    return {
      ...getTimerConfigFromDraft(state()),
      leaderPoolSize: null,
    }
  }

  const timerConfig = (): DraftTimerConfig => {
    const config = draftConfig()
    return {
      banTimerSeconds: config.banTimerSeconds,
      pickTimerSeconds: config.pickTimerSeconds,
    }
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
  const leaderPoolPlayerCount = () => {
    const lobby = currentLobby()
    if (lobby) return lobby.entries.filter(entry => entry != null).length
    return state()?.seats.length ?? 0
  }
  const leaderPoolValidationCount = () => {
    const lobby = currentLobby()
    if (lobby) return lobby.mode === 'ffa' ? leaderPoolPlayerCount() : lobby.targetSize
    return state()?.seats.length ?? leaderPoolPlayerCount()
  }
  const leaderPoolMinimumValue = () => getLeaderPoolSizeMinimum(lobbyMode(), leaderPoolValidationCount())
  const leaderPoolPlaceholderValue = () => leaderPoolSizePlaceholder(lobbyMode(), leaderPoolPlayerCount())
  const currentDraftLeaderPoolSize = () => {
    const draftState = state()
    if (!draftState) return null
    return new Set([
      ...draftState.availableCivIds,
      ...draftState.bans.map(selection => selection.civId),
      ...draftState.picks.map(selection => selection.civId),
    ]).size
  }
  const formattedLeaderPool = () => {
    const lobby = currentLobby()
    if (lobby) return formatLeaderPoolValue(draftConfig().leaderPoolSize, inferGameMode(lobby.mode), leaderPoolPlayerCount())
    const size = currentDraftLeaderPoolSize()
    return size == null ? 'Unknown' : String(size)
  }
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

  const optimisticTimerConfig = createOptimisticState(draftConfig, {
    equals: (a, b) => a.banTimerSeconds === b.banTimerSeconds && a.pickTimerSeconds === b.pickTimerSeconds && a.leaderPoolSize === b.leaderPoolSize,
  })

  const clearConfigMessage = () => {
    if (configMessageTimeout) {
      clearTimeout(configMessageTimeout)
      configMessageTimeout = null
    }
    setConfigMessage(null)
    setConfigMessageTone(null)
    setMinRoleSetDetail(null)
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
    setMinRoleSetDetail(null)
    scheduleConfigMessageClear()
  }

  const showInfoMessage = (message: string) => {
    setConfigMessage(message)
    setConfigMessageTone('info')
    setMinRoleSetDetail(null)
    scheduleConfigMessageClear()
  }

  const showMinRoleSetMessage = (detail: MinRoleSetDetail) => {
    setConfigMessage(`Min rank set to ${detail.roleLabel}`)
    setConfigMessageTone('info')
    setMinRoleSetDetail(detail)
    scheduleConfigMessageClear()
  }

  onCleanup(() => {
    if (configMessageTimeout) clearTimeout(configMessageTimeout)
  })

  createEffect(() => {
    const config = optimisticTimerConfig.value()
    if (editingField() !== 'ban') setBanMinutes(timerSecondsToMinutesInput(config.banTimerSeconds))
    if (editingField() !== 'pick') setPickMinutes(timerSecondsToMinutesInput(config.pickTimerSeconds))
    if (editingField() !== 'leaderPool') setLeaderPoolInput(leaderPoolSizeToInput(config.leaderPoolSize))
  })

  createEffect(() => {
    const status = optimisticTimerConfig.status()
    if (status === 'error') {
      showErrorMessage(optimisticTimerConfig.error() ?? 'Failed to save changes.')
    }
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
      leaderPoolSize: resolvedLobby.draftConfig.leaderPoolSize,
    })
  }

  const buildLobbyRow = (slot: number, entry: LobbySnapshot['entries'][number] | null, key: string): PlayerRow => {
    const pendingSelf = pendingSelfJoinSlot() === slot
    const currentUserId = userId()

    if (pendingSelf && currentUserId) {
      return {
        key,
        slot,
        name: currentDisplayName() || 'You',
        playerId: currentUserId,
        avatarUrl: currentAvatarUrl(),
        partyIds: [],
        isHost: false,
        empty: false,
        pendingSelf: true,
      }
    }

    return {
      key,
      slot,
      name: entry?.displayName ?? '[empty]',
      playerId: entry?.playerId ?? null,
      avatarUrl: entry?.avatarUrl ?? null,
      partyIds: entry?.partyIds ?? [],
      isHost: entry?.playerId === hostId(),
      empty: entry == null,
      pendingSelf: false,
    }
  }

  const teamRows = (team: 0 | 1): PlayerRow[] => {
    const lobby = currentLobby()
    if (lobby) {
      const size = Math.max(1, Math.floor(lobby.targetSize / 2))
      const start = team === 0 ? 0 : size
      return Array.from({ length: size }, (_, i) => {
        const slot = start + i
        const entry = lobby.entries[slot] ?? null
        return buildLobbyRow(slot, entry, `lobby-${slot}`)
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
      pendingSelf: false,
    }))
  }

  const ffaRows = (): PlayerRow[] => {
    const lobby = currentLobby()
    if (lobby) {
      return Array.from({ length: lobby.targetSize }, (_, i) => {
        const entry = lobby.entries[i] ?? null
        return buildLobbyRow(i, entry, `lobby-ffa-${i}`)
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
      pendingSelf: false,
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

  const viewerJoinBlockedReason = () => {
    const currentUserId = userId()
    const eligibility = props.joinEligibility
    if (!currentUserId || !eligibility || eligibility.canJoin) return null
    if (isCurrentUserSlotted()) return null
    return eligibility.blockedReason ?? 'You cannot join this lobby right now.'
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
    if (props.showJoinPending && !isCurrentUserSlotted()) return false
    if (props.joinEligibility && !props.joinEligibility.canJoin && !isCurrentUserSlotted()) return false
    if (!amHost() && currentUserLinkedPartySize() > 0) return false
    return true
  }

  const canRemoveSlot = (row: PlayerRow) => {
    if (!isLobbyMode()) return false
    if (row.empty || !row.playerId || row.pendingSelf) return false
    if (row.isHost) return false
    const id = userId()
    if (!id) return false
    if (amHost()) return true
    return row.playerId === id
  }

  const canDragRow = (row: PlayerRow) => {
    if (!isLobbyMode()) return false
    if (lobbyActionPending()) return false
    if (row.empty || !row.playerId || row.pendingSelf) return false
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
      const leaderPoolMinimum = leaderPoolMinimumValue()
      const parsedLeaderPool = parseLeaderPoolSizeInput(leaderPoolInput(), leaderPoolMinimum)
      if (parsedBan === undefined || parsedPick === undefined || parsedLeaderPool === undefined) {
        optimisticTimerConfig.clearError()
        showErrorMessage(`Leaders can be ${leaderPoolMinimum}-${MAX_LEADER_POOL_INPUT}, or blank for the default.`)
        const current = optimisticTimerConfig.value()
        setBanMinutes(timerSecondsToMinutesInput(current.banTimerSeconds))
        setPickMinutes(timerSecondsToMinutesInput(current.pickTimerSeconds))
        setLeaderPoolInput(leaderPoolSizeToInput(current.leaderPoolSize))
        return
      }

      const banTimerSeconds = parsedBan == null ? null : parsedBan * 60
      const pickTimerSeconds = parsedPick == null ? null : parsedPick * 60
      const leaderPoolSize = parsedLeaderPool
      const current = optimisticTimerConfig.value()

      if (
        banTimerSeconds === current.banTimerSeconds
        && pickTimerSeconds === current.pickTimerSeconds
        && leaderPoolSize === current.leaderPoolSize
      ) {
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
      await optimisticTimerConfig.commit({ banTimerSeconds, pickTimerSeconds, leaderPoolSize }, async () => {
        const lobby = currentLobby()
        if (lobby) {
          const result = await updateLobbyConfig(lobby.mode, lobby.id, currentUserId, {
            banTimerSeconds,
            pickTimerSeconds,
            leaderPoolSize,
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
      showInfoMessage(`Game mode changed to ${formatModeLabel(result.lobby.mode, result.lobby.mode)}.`)
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
        leaderPoolSize: draftConfig().leaderPoolSize,
        minRole: nextMinRole,
      })
      if (!result.ok) {
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
        showInfoMessage('Min rank cleared')
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
    if (!isCurrentUserSlotted() && props.joinEligibility?.canJoin !== false) {
      setPendingPlaceSelfSlot(slot)
    }

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
        showErrorMessage(result.error)
        return
      }
      applyLobbySnapshot(result.lobby)
    }
    finally {
      setPendingPlaceSelfSlot(null)
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
    const currentUserSlot = draggedPlayerId === currentUserId
      ? lobby.entries.findIndex(entry => entry?.playerId === currentUserId)
      : -1

    let optimisticAction: PendingOptimisticLobbyAction | null = null
    if (draggedPlayerId === currentUserId && !isLinkedDrag && currentUserSlot >= 0) {
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
    if (lobbyActionPending() || startPending() || cancelPending()) return
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
                      pending={lobbyActionPending() || startPending() || cancelPending()}
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

  const toMiniSeatItem = (row: PlayerRow, team: number | null): MiniSeatItem => ({
    key: row.key,
    name: row.empty ? 'Empty' : row.name,
    avatarUrl: row.avatarUrl ?? null,
    team,
    empty: row.empty,
  })

  const miniColumns = () => {
    if (isTeamMode()) {
      return [
        teamRows(0).map(row => toMiniSeatItem(row, 0)),
        teamRows(1).map(row => toMiniSeatItem(row, 1)),
      ]
    }

    return [
      ffaFirstColumn().map(row => toMiniSeatItem(row, null)),
      ffaSecondColumn().map(row => toMiniSeatItem(row, null)),
    ]
  }

  const setupStatusText = () => {
    if (isLobbyMode()) {
      if (amHost()) return canStartLobby() ? 'Ready to start' : 'Waiting for more players'
      return isCurrentUserSlotted() ? 'Waiting for host' : 'Spectating'
    }

    if (amHost()) return 'Ready to start'
    return isSpectator() ? 'Spectating' : 'Waiting for host'
  }

  return (
    <Show
      when={isMiniView()}
      fallback={(
        <div class="text-fg font-sans bg-bg overflow-y-auto min-h-dvh">
          <div class="mx-auto px-6 py-4 flex flex-col gap-6 max-w-5xl w-full">
            <div class="grid grid-cols-[2.25rem_minmax(0,1fr)_2.25rem] items-center">
              <div class="h-9 w-9" />
              <div class="text-center">
                <h1 class="text-2xl text-heading mb-1">Draft Setup</h1>
                <span class="text-sm text-accent font-medium">{formatId()}</span>
              </div>

              <Show when={props.onSwitchTarget} fallback={<div class="h-9 w-9" />}>
                <button
                  type="button"
                  class="text-fg-muted border border-border-subtle rounded-md flex shrink-0 h-9 w-9 cursor-pointer transition-colors items-center justify-center hover:text-fg hover:bg-bg-muted"
                  title="Lobby Overview"
                  aria-label="Lobby Overview"
                  onClick={() => props.onSwitchTarget?.()}
                >
                  <span class="i-ph-squares-four-bold text-base" />
                </button>
              </Show>
            </div>

            <div class="gap-4 grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px]">
              <div class="p-4 rounded-lg bg-bg-subtle">
                <div class="text-xs text-fg-subtle tracking-widest font-bold mb-3 uppercase">Players</div>

                <Show when={viewerJoinBlockedReason()}>
                  {reason => (
                    <div class="text-sm text-danger mb-3 px-3 py-2 border border-danger/25 rounded-md bg-danger/10">
                      {reason()}
                    </div>
                  )}
                </Show>

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
                      <div class="text-xs text-accent tracking-wider font-bold mb-2">Team A</div>
                      {renderTeamColumn(teamRows(0))}
                    </div>
                    <div>
                      <div class="text-xs text-accent tracking-wider font-bold mb-2">Team B</div>
                      {renderTeamColumn(teamRows(1))}
                    </div>
                  </div>
                </Show>
              </div>

              <div class="p-4 rounded-lg bg-bg-subtle flex flex-col gap-3">
                <div class="text-xs text-fg-subtle tracking-widest font-bold flex uppercase items-center justify-between">
                  <span>Config</span>
                  <span class="flex h-4 w-4 items-center justify-center">
                    <Show when={props.showJoinPending || optimisticTimerConfig.status() === 'pending' || lobbyActionPending() || startPending()}>
                      <span class="i-gg:spinner text-sm text-accent animate-spin" />
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
                      <Show when={isLobbyMode()}>
                        <ReadonlyTimerRow
                          label="Matchmaking min rank"
                          value={formattedLobbyMinRole()}
                        />
                      </Show>
                      <ReadonlyTimerRow
                        label="Leaders"
                        value={formattedLeaderPool()}
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
                    <Show when={isLobbyMode()}>
                      <Dropdown
                        label="Matchmaking Min Rank"
                        value={lobbyMinRoleValue()}
                        disabled={lobbyActionPending()}
                        options={minRoleDropdownOptions()}
                        onChange={value => void handleLobbyMinRoleChange(value)}
                      />

                      <TextInput
                        type="number"
                        label="Leaders"
                        min={String(leaderPoolMinimumValue())}
                        max={String(MAX_LEADER_POOL_INPUT)}
                        step="1"
                        value={leaderPoolInput()}
                        placeholder={leaderPoolPlaceholderValue()}
                        onFocus={() => setEditingField('leaderPool')}
                        onInput={(event) => {
                          optimisticTimerConfig.clearError()
                          clearConfigMessage()
                          const normalized = normalizeLeaderPoolSizeInput(event.currentTarget.value, leaderPoolMinimumValue())
                          event.currentTarget.value = normalized
                          setLeaderPoolInput(normalized)
                        }}
                        onBlur={() => void saveConfigOnBlur()}
                      />
                    </Show>

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
                    <div class="text-xs text-fg flex gap-1.5 items-center">
                      <span class={cn(
                        'text-base shrink-0 self-center',
                        configMessageTone() === 'error'
                          ? 'i-ph-x-bold text-danger'
                          : 'i-ph-check-bold text-accent',
                      )}
                      />
                      <Show
                        when={configMessageTone() === 'info' && minRoleSetDetail()}
                        fallback={<span class="leading-relaxed">{configMessage()}</span>}
                      >
                        <MinRoleSetNotice detail={minRoleSetDetail()!} />
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
                  <span class="text-sm text-fg-subtle">
                    {setupStatusText()}
                  </span>
                )}
              >
                <Show
                  when={!isLobbyMode()}
                  fallback={(
                    <div class="flex gap-3 items-center">
                      <button
                        class="text-sm text-bg font-bold px-8 py-2.5 rounded-lg bg-accent cursor-pointer transition-colors disabled:opacity-60 disabled:cursor-not-allowed hover:brightness-110"
                        disabled={!canStartLobby() || startPending() || lobbyActionPending()}
                        onClick={() => void handleStartLobbyDraftAction()}
                      >
                        {startPending() ? 'Starting...' : 'Start Draft'}
                      </button>
                      <button
                        class="text-sm text-fg-muted px-6 py-2.5 border border-border rounded-lg bg-bg-muted/25 cursor-pointer transition-colors hover:text-fg hover:border-border-hover hover:bg-bg-muted/50 disabled:opacity-60 disabled:cursor-not-allowed"
                        disabled={cancelPending() || startPending() || lobbyActionPending()}
                        onClick={() => void handleCancelAction()}
                      >
                        {cancelPending() ? 'Cancelling...' : 'Cancel Lobby'}
                      </button>
                      <Show when={lobbyMode() === '2v2' || lobbyMode() === '3v3'}>
                        <button
                          class="text-fg-muted border border-border rounded-lg bg-bg-muted/25 flex h-10 w-10 cursor-pointer transition-colors items-center justify-center hover:text-fg hover:border-border-hover hover:bg-bg-muted/50 disabled:opacity-60 disabled:cursor-not-allowed"
                          title="Randomize"
                          aria-label="Randomize teams"
                          disabled={cancelPending() || startPending() || lobbyActionPending()}
                          onClick={() => void handleArrangeTeams('randomize')}
                        >
                          <span class="i-ph:shuffle-simple-bold text-lg" />
                        </button>
                        <button
                          class="text-fg-muted border border-border rounded-lg bg-bg-muted/25 flex h-10 w-10 cursor-pointer transition-colors items-center justify-center hover:text-fg hover:border-border-hover hover:bg-bg-muted/50 disabled:opacity-60 disabled:cursor-not-allowed"
                          title="Auto-balance"
                          aria-label="Auto-balance teams"
                          disabled={cancelPending() || startPending() || lobbyActionPending()}
                          onClick={() => void handleArrangeTeams('balance')}
                        >
                          <span class="i-ph:scales-bold text-lg" />
                        </button>
                      </Show>
                      <Show when={fillTestPlayersAvailable()}>
                        <button
                          class="text-sm text-fg-muted px-6 py-2.5 border border-border rounded-lg bg-bg-muted/25 cursor-pointer transition-colors hover:text-fg hover:border-border-hover hover:bg-bg-muted/50 disabled:opacity-60 disabled:cursor-not-allowed"
                          disabled={cancelPending() || startPending() || lobbyActionPending()}
                          onClick={() => void handleFillTestPlayers()}
                        >
                          Fill Test Players
                        </button>
                      </Show>
                    </div>
                  )}
                >
                  <div class="flex flex-col gap-2 items-center">
                    <span class="text-sm text-fg-subtle">{setupStatusText()}</span>

                    <div class="flex gap-3 items-center">
                      <button
                        class="text-sm text-bg font-bold px-8 py-2.5 rounded-lg bg-accent cursor-pointer transition-colors hover:brightness-110"
                        onClick={sendStart}
                      >
                        Start Draft
                      </button>
                      <button
                        class="text-sm text-fg-muted px-6 py-2.5 border border-border rounded-lg bg-bg-muted/25 cursor-pointer transition-colors hover:text-fg hover:border-border-hover hover:bg-bg-muted/50"
                        onClick={() => void handleCancelAction()}
                      >
                        Cancel Draft
                      </button>
                    </div>
                  </div>
                </Show>
              </Show>
            </div>
          </div>
        </div>
      )}
    >
      <MiniFrame
        modeLabel={formatId()}
        title="Draft Setup"
        titleAccent="gold"
        rightLabel={currentLobby() ? `${filledSlots()}/${currentLobby()!.targetSize}` : null}
      >
        <MiniSeatGrid
          columns={miniColumns()}
        />
      </MiniFrame>
    </Show>
  )
}
