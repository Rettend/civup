import type { MiniSeatItem } from './MiniLayout'
import type {
  DraftTimerConfig,
  LobbyModeValue,
  OptimisticLobbyAction,
  PendingOptimisticLobbyAction,
  PlayerRow,
  RankRoleSetDetail,
} from '~/client/lib/config-screen/helpers'
import type { LobbyArrangeStrategy, LobbyJoinEligibilitySnapshot, LobbySnapshot, RankedRoleOptionSnapshot } from '~/client/stores'
import { canStartWithPlayerCount, formatModeLabel, GAME_MODE_CHOICES, hasBetaLeaderData, inferGameMode, isTeamMode as isTeamGameMode, isUnrankedMode, maxPlayerCount, normalizeAvailableLeaderDataVersion, normalizeCompetitiveTierBounds, requiresRedDeathDuplicateFactions, slotToTeamIndex } from '@civup/game'
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { Dropdown, Switch, TextInput } from '~/client/components/ui'
import {
  applyOptimisticLobbyAction,
  buildLobbyBalanceSummary,
  buildRankDotStyle,
  findRankedRoleOptionByTier,
  formatLeaderPoolValue,
  formatLobbyMaxRole,
  formatLobbyMinRole,
  formatTimerValue,
  getLeaderPoolSizeMinimum,
  getTimerConfigFromDraft,
  leaderPoolSizePlaceholder,
  leaderPoolSizeToInput,
  MAX_LEADER_POOL_INPUT,
  MAX_TIMER_MINUTES,
  normalizeLobbyRankRoleValue,
  parseLeaderPoolSizeInput,
  parseTimerMinutesInput,
  resolveOptimisticLobbyPlacementAction,
  resolvePendingJoinGhostSlot,
  supportsBlindBansControl,
  timerSecondsToMinutesInput,
  timerSecondsToMinutesPlaceholder,
} from '~/client/lib/config-screen/helpers'
import { PlayerChip, PremadeLinkButton, RankRoleSetNotice, ReadonlyTimerRow } from '~/client/lib/config-screen/parts'
import { cn } from '~/client/lib/css'
import { createOptimisticState } from '~/client/lib/optimistic-state'
import {
  arrangeLobbySlots,
  cancelLobby,
  canFillLobbyWithTestPlayers,
  avatarUrl as currentAvatarUrl,
  displayName as currentDisplayName,
  draftStore,
  fetchLobbyRankedRoles,
  fillLobbyWithTestPlayers,
  isMiniView,
  isMobileLayout,
  isRedDeathDraft,
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
import { SteamLobbyButton } from './SteamLobbyButton'

interface ConfigScreenProps {
  lobby?: LobbySnapshot
  steamLobbyLink?: string | null
  showJoinPending?: boolean
  joinEligibility?: LobbyJoinEligibilitySnapshot
  onLobbyStarted?: (matchId: string, steamLobbyLink: string | null, roomAccessToken: string | null) => void
  onSwitchTarget?: () => void
}

interface LobbyEditableDraftConfig extends DraftTimerConfig {
  leaderPoolSize: number | null
  leaderDataVersion: 'live' | 'beta'
  blindBans: boolean
  simultaneousPick: boolean
  redDeath: boolean
  dealOptionsSize: number | null
  randomDraft: boolean
  duplicateFactions: boolean
}

type EditableConfigField = 'ban' | 'pick' | 'leaderPool'

const CONFIG_MESSAGE_TIMEOUT_MS = 4000

function sameLobbyDraftConfig(a: LobbyEditableDraftConfig, b: LobbyEditableDraftConfig): boolean {
  return a.banTimerSeconds === b.banTimerSeconds
    && a.pickTimerSeconds === b.pickTimerSeconds
    && a.leaderPoolSize === b.leaderPoolSize
    && a.leaderDataVersion === b.leaderDataVersion
    && a.blindBans === b.blindBans
    && a.simultaneousPick === b.simultaneousPick
    && a.redDeath === b.redDeath
    && a.dealOptionsSize === b.dealOptionsSize
    && a.randomDraft === b.randomDraft
    && a.duplicateFactions === b.duplicateFactions
}

/** Pre-draft setup screen (lobby waiting + room waiting). */
export function ConfigScreen(props: ConfigScreenProps) {
  const state = () => draftStore.state
  const [lobbyState, setLobbyState] = createSignal<LobbySnapshot | null>(props.lobby ?? null)
  const [banMinutes, setBanMinutes] = createSignal('')
  const [pickMinutes, setPickMinutes] = createSignal('')
  const [leaderPoolInput, setLeaderPoolInput] = createSignal('')
  const [editingField, setEditingField] = createSignal<EditableConfigField | null>(null)
  const [configMessage, setConfigMessage] = createSignal<string | null>(null)
  const [configMessageTone, setConfigMessageTone] = createSignal<'error' | 'info' | null>(null)
  const [cancelPending, setCancelPending] = createSignal(false)
  const [startPending, setStartPending] = createSignal(false)
  const [lobbyActionPending, setLobbyActionPending] = createSignal(false)
  const [leaderDataVersionPending, setLeaderDataVersionPending] = createSignal(false)
  const [blindBansPending, setBlindBansPending] = createSignal(false)
  const [simultaneousPickPending, setSimultaneousPickPending] = createSignal(false)
  const [redDeathPending, setRedDeathPending] = createSignal(false)
  const [randomDraftPending, setRandomDraftPending] = createSignal(false)
  const [duplicateFactionsPending, setDuplicateFactionsPending] = createSignal(false)
  const [pendingPlaceSelfSlot, setPendingPlaceSelfSlot] = createSignal<number | null>(null)
  const [draggingPlayerId, setDraggingPlayerId] = createSignal<string | null>(null)
  const [dragOverSlot, setDragOverSlot] = createSignal<number | null>(null)
  const [optimisticLobbyAction, setOptimisticLobbyAction] = createSignal<OptimisticLobbyAction | null>(null)
  let optimisticLobbyActionTimeout: ReturnType<typeof setTimeout> | null = null
  let configMessageTimeout: ReturnType<typeof setTimeout> | null = null
  let clampedField: EditableConfigField | null = null
  const [lobbyTimerConfig, setLobbyTimerConfig] = createSignal<LobbyEditableDraftConfig | null>(
    props.lobby
      ? {
          banTimerSeconds: props.lobby.draftConfig.banTimerSeconds,
          pickTimerSeconds: props.lobby.draftConfig.pickTimerSeconds,
          leaderPoolSize: props.lobby.draftConfig.leaderPoolSize,
          leaderDataVersion: props.lobby.draftConfig.leaderDataVersion,
          blindBans: props.lobby.draftConfig.blindBans,
          simultaneousPick: props.lobby.draftConfig.simultaneousPick,
          redDeath: props.lobby.draftConfig.redDeath,
          dealOptionsSize: props.lobby.draftConfig.dealOptionsSize,
          randomDraft: props.lobby.draftConfig.randomDraft,
          duplicateFactions: props.lobby.draftConfig.duplicateFactions,
        }
      : null,
  )
  const [rankedRoleOptions, setRankedRoleOptions] = createSignal<RankedRoleOptionSnapshot[]>([])
  const [fillTestPlayersAvailable, setFillTestPlayersAvailable] = createSignal(false)
  const [rankRoleSetDetail, setRankRoleSetDetail] = createSignal<RankRoleSetDetail | null>(null)
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
      leaderDataVersion: lobby.draftConfig.leaderDataVersion,
      blindBans: lobby.draftConfig.blindBans,
      simultaneousPick: lobby.draftConfig.simultaneousPick,
      redDeath: lobby.draftConfig.redDeath,
      dealOptionsSize: lobby.draftConfig.dealOptionsSize,
      randomDraft: lobby.draftConfig.randomDraft,
      duplicateFactions: lobby.draftConfig.duplicateFactions,
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
  const lobbyBalance = createMemo(() => buildLobbyBalanceSummary(currentLobby()))
  const teamBalance = (team: number) => lobbyBalance()?.teams.find(summary => summary.team === team) ?? null
  const pendingSelfJoinSlot = () => resolvePendingJoinGhostSlot(
    currentLobby(),
    userId(),
    (props.showJoinPending === true) || pendingPlaceSelfSlot() != null,
    props.joinEligibility,
    pendingPlaceSelfSlot(),
  )
  const steamLobbyLink = () => currentLobby()?.steamLobbyLink ?? props.steamLobbyLink ?? null
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

    if (isUnrankedMode(inferGameMode(lobby.mode))) {
      setRankedRoleOptions([])
      return
    }

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
    if (lobby) return formatModeLabel(lobby.mode, 'DRAFT', { redDeath: draftConfig().redDeath, targetSize: lobby.targetSize })
    return formatModeLabel(inferGameMode(state()?.formatId), 'DRAFT', { redDeath: isRedDeathDraft(), targetSize: state()?.seats.length })
  }
  const miniFormatId = () => {
    const lobby = currentLobby()
    if (lobby) return formatModeLabel(lobby.mode, 'DRAFT', { redDeath: draftConfig().redDeath, compactRedDeath: true, targetSize: lobby.targetSize })
    return formatModeLabel(inferGameMode(state()?.formatId), 'DRAFT', { redDeath: isRedDeathDraft(), compactRedDeath: true, targetSize: state()?.seats.length })
  }
  const isTeamMode = () => {
    const lobby = currentLobby()
    if (lobby) return inferGameMode(lobby.mode) !== 'ffa'
    return state()?.seats.some(s => s.team != null) ?? false
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

  const draftConfig = (): LobbyEditableDraftConfig => {
    const lobby = currentLobby()
    if (lobby) {
      return lobbyTimerConfig() ?? {
        banTimerSeconds: lobby.draftConfig.banTimerSeconds,
        pickTimerSeconds: lobby.draftConfig.pickTimerSeconds,
        leaderPoolSize: lobby.draftConfig.leaderPoolSize,
        leaderDataVersion: lobby.draftConfig.leaderDataVersion,
        blindBans: lobby.draftConfig.blindBans,
        simultaneousPick: lobby.draftConfig.simultaneousPick,
        redDeath: lobby.draftConfig.redDeath,
        dealOptionsSize: lobby.draftConfig.dealOptionsSize,
        randomDraft: lobby.draftConfig.randomDraft,
        duplicateFactions: lobby.draftConfig.duplicateFactions,
      }
    }
    return {
      ...getTimerConfigFromDraft(state()),
      leaderPoolSize: null,
      leaderDataVersion: 'live',
      blindBans: true,
      simultaneousPick: state()?.formatId === 'default-ffa-simultaneous',
      redDeath: isRedDeathDraft(),
      dealOptionsSize: null,
      randomDraft: false,
      duplicateFactions: false,
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
  const lobbyMaxRoleValue = () => currentLobby()?.maxRole ?? ''
  const formattedLobbyMaxRole = () => formatLobbyMaxRole(currentLobby()?.maxRole ?? null, rankedRoleOptions())
  const leaderPoolPlayerCount = () => {
    const lobby = currentLobby()
    if (lobby) return lobby.entries.filter(entry => entry != null).length
    return state()?.seats.length ?? 0
  }
  const leaderPoolValidationCount = () => {
    const lobby = currentLobby()
    if (lobby) return lobby.targetSize
    return state()?.seats.length ?? leaderPoolPlayerCount()
  }
  const leaderPoolMinimumValue = () => getLeaderPoolSizeMinimum(lobbyMode(), leaderPoolValidationCount())
  const isRedDeathLobbyMode = () => currentLobby() ? optimisticDraftConfig().redDeath : isRedDeathDraft()
  const leaderPoolPlaceholderValue = () => isRedDeathLobbyMode()
    ? String(draftConfig().dealOptionsSize ?? 2)
    : leaderPoolSizePlaceholder(lobbyMode(), leaderPoolPlayerCount(), currentLobby()?.targetSize)
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
    if (isRedDeathLobbyMode()) return String(draftConfig().dealOptionsSize ?? 2)
    const lobby = currentLobby()
    if (lobby) return formatLeaderPoolValue(draftConfig().leaderPoolSize, inferGameMode(lobby.mode), leaderPoolPlayerCount(), lobby.targetSize)
    const size = currentDraftLeaderPoolSize()
    return size == null ? 'Unknown' : String(size)
  }
  const buildRoleDropdownOptions = (clearLabel: string) => [
    {
      value: '',
      label: clearLabel,
      render: () => (
        <span class="flex gap-2 items-center">
          <span class="rounded-full bg-white/25 h-2.5 w-2.5" />
          {clearLabel}
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
  const minRoleDropdownOptions = () => buildRoleDropdownOptions('Anyone')
  const maxRoleDropdownOptions = () => buildRoleDropdownOptions('Anyone')

  const banTimerPlaceholder = () => timerSecondsToMinutesPlaceholder(serverDefaultTimerConfig().banTimerSeconds)
  const pickTimerPlaceholder = () => timerSecondsToMinutesPlaceholder(serverDefaultTimerConfig().pickTimerSeconds)
  const timerInputStep = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed) return '1'

    const numeric = Number(trimmed)
    if (!Number.isFinite(numeric)) return '0.1'
    return numeric >= 1 && Number.isInteger(numeric) ? '1' : '0.1'
  }

  const optimisticTimerConfig = createOptimisticState(draftConfig, {
    equals: sameLobbyDraftConfig,
  })
  const optimisticDraftConfig = () => optimisticTimerConfig.value()
  const formattedBbgVersion = () => normalizeAvailableLeaderDataVersion(draftConfig().leaderDataVersion) === 'beta' ? 'Beta' : 'Live'
  const formattedBlindBans = () => draftConfig().blindBans ? 'On' : 'Off'
  const formattedSimultaneousPick = () => draftConfig().simultaneousPick ? 'On' : 'Off'
  const formattedRandomDraft = () => draftConfig().randomDraft ? 'On' : 'Off'
  const duplicateFactionsLocked = () => isRedDeathLobbyMode() && requiresRedDeathDuplicateFactions(lobbyMode())
  const draftDuplicateFactions = () => duplicateFactionsLocked() ? true : draftConfig().duplicateFactions
  const optimisticDuplicateFactions = () => duplicateFactionsLocked() ? true : optimisticDraftConfig().duplicateFactions
  const duplicateOptionLabel = () => isRedDeathLobbyMode() ? 'Duplicate factions' : 'Duplicate leaders'
  const formattedDuplicateFactions = () => draftDuplicateFactions() ? 'On' : 'Off'
  const poolInputLabel = () => isRedDeathLobbyMode() ? 'Factions' : 'Leaders'
  const modeLabelClass = () => isRedDeathLobbyMode() ? 'text-[#f97316]' : 'text-accent'

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

  const configFieldRangeMessage = (field: EditableConfigField | null): string => {
    switch (field) {
      case 'ban':
        return `Ban timer can be 0-${MAX_TIMER_MINUTES} minutes, or blank for the server default.`
      case 'pick':
        return `Pick timer can be 0-${MAX_TIMER_MINUTES} minutes, or blank for the server default.`
      case 'leaderPool': {
        const leaderPoolMinimum = leaderPoolMinimumValue()
        return isRedDeathLobbyMode()
          ? 'Factions can be 2-10, or blank for the default.'
          : `Leaders can be ${leaderPoolMinimum}-${MAX_LEADER_POOL_INPUT}, or blank for the default.`
      }
      default:
        return 'Value is out of range.'
    }
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
    if (configMessageTimeout) clearTimeout(configMessageTimeout)
  })

  createEffect(() => {
    const config = optimisticTimerConfig.value()
    if (editingField() !== 'ban') setBanMinutes(timerSecondsToMinutesInput(config.banTimerSeconds))
    if (editingField() !== 'pick') setPickMinutes(timerSecondsToMinutesInput(config.pickTimerSeconds))
    if (editingField() !== 'leaderPool') setLeaderPoolInput(leaderPoolSizeToInput(isRedDeathLobbyMode() ? config.dealOptionsSize : config.leaderPoolSize))
  })

  createEffect(() => {
    const status = optimisticTimerConfig.status()
    if (status === 'error') {
      showErrorMessage(optimisticTimerConfig.error() ?? 'Failed to save changes.')
    }
  })

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

  const teamRows = (team: number): PlayerRow[] => {
    const lobby = currentLobby()
    if (lobby) {
      const mode = inferGameMode(lobby.mode)
      const rows: PlayerRow[] = []
      for (let slot = 0; slot < lobby.entries.length; slot++) {
        if (slotToTeamIndex(mode, slot, lobby.targetSize) !== team) continue
        rows.push(buildLobbyRow(slot, lobby.entries[slot] ?? null, `lobby-${slot}`))
      }
      return rows
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

  const arrangeTargetLabel = (mode: LobbyModeValue) => isTeamGameMode(mode) ? 'teams' : 'seat order'
  const arrangeTargetTitle = (mode: LobbyModeValue) => isTeamGameMode(mode) ? 'Teams' : 'Seat order'

  const filledSlots = () => {
    const lobby = currentLobby()
    if (!lobby) return 0
    return lobby.entries.filter(entry => entry != null).length
  }

  const lobbyModeOptions = () => {
    const playerCount = filledSlots()
    return GAME_MODE_CHOICES.map(choice => ({
      value: choice.value,
      label: choice.name,
      disabled: playerCount > ((choice.value === 'ffa' && optimisticDraftConfig().redDeath) ? 10 : maxPlayerCount(choice.value)),
    }))
  }

  const canStartLobby = () => {
    const lobby = currentLobby()
    if (!lobby) return false
    return canStartWithPlayerCount(inferGameMode(lobby.mode), filledSlots(), lobby.targetSize, {
      redDeath: optimisticDraftConfig().redDeath,
    })
  }

  const show2v2TeamCountToggle = () => isLobbyMode() && lobbyMode() === '2v2'
  const hasExpanded2v2Teams = () => currentLobby()?.targetSize === 8
  const extra2v2SeatsOccupied = () => (currentLobby()?.entries.slice(4) ?? []).some(entry => entry != null)
  const canToggle2v2Teams = () => amHost() && !lobbyActionPending() && (!hasExpanded2v2Teams() || !extra2v2SeatsOccupied())
  const twoVTwoTeamCountToggleLabel = () => hasExpanded2v2Teams() ? 'Remove extra teams' : 'Add two extra teams'
  const twoVTwoTeamCountToggleTitle = () => {
    if (hasExpanded2v2Teams() && extra2v2SeatsOccupied()) return 'Clear Teams C and D before removing them.'
    return twoVTwoTeamCountToggleLabel()
  }

  const isLargeTeamLobbyMode = () => isLobbyMode() && (lobbyMode() === '5v5' || lobbyMode() === '6v6')

  const redDeathExtraFfaSeatsOccupied = () => {
    const lobby = currentLobby()
    if (!lobby || lobby.mode !== 'ffa' || !optimisticDraftConfig().redDeath) return false
    return (lobby.entries.slice(8) ?? []).some(entry => entry != null)
  }

  const canToggleRedDeath = () => !redDeathExtraFfaSeatsOccupied()
  const supportsBlindBansToggle = () => {
    return isLobbyMode() && supportsBlindBansControl(lobbyMode(), {
      redDeath: isRedDeathLobbyMode(),
      targetSize: currentLobby()?.targetSize,
    })
  }

  const currentUserLobbySlot = createMemo(() => {
    const id = userId()
    if (!id) return null
    const slot = currentLobby()?.entries.findIndex(entry => entry?.playerId === id) ?? -1
    return slot >= 0 ? slot : null
  })

  const isCurrentUserSlotted = () => currentUserLobbySlot() != null

  const currentUserLinkedPartySize = () => {
    const id = userId()
    if (!id) return 0
    const entry = currentLobby()?.entries.find(candidate => candidate?.playerId === id)
    return entry?.partyIds?.length ?? 0
  }

  const canCurrentUserPlaceSelf = () => {
    if (!isLobbyMode()) return false
    if (!userId()) return false
    if (props.showJoinPending && !isCurrentUserSlotted()) return false
    if (props.joinEligibility && !props.joinEligibility.canJoin && !isCurrentUserSlotted()) return false
    if (!amHost() && currentUserLinkedPartySize() > 0) return false
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

  const canJoinSlot = (row: PlayerRow) => {
    if (!row.empty) return false
    return canCurrentUserPlaceSelf()
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

  const commitDraftConfig = async (
    nextConfig: LobbyEditableDraftConfig,
    options: { preserveConfigMessage?: boolean, targetSize?: number } = {},
  ) => {
    const currentUserId = userId()
    if (!currentUserId) {
      optimisticTimerConfig.clearError()
      showErrorMessage('Could not identify your Discord user. Reopen the activity.')
      return false
    }

    if (!options.preserveConfigMessage) clearConfigMessage()
    await optimisticTimerConfig.commit(nextConfig, async () => {
      const lobby = currentLobby()
      if (lobby) {
        const result = await updateLobbyConfig(lobby.mode, lobby.id, currentUserId, {
          banTimerSeconds: nextConfig.banTimerSeconds,
          pickTimerSeconds: nextConfig.pickTimerSeconds,
          leaderPoolSize: nextConfig.leaderPoolSize,
          leaderDataVersion: nextConfig.leaderDataVersion,
          blindBans: nextConfig.blindBans,
          simultaneousPick: nextConfig.simultaneousPick,
          redDeath: nextConfig.redDeath,
          dealOptionsSize: nextConfig.dealOptionsSize,
          randomDraft: nextConfig.randomDraft,
          duplicateFactions: nextConfig.duplicateFactions,
          targetSize: options.targetSize,
          minRole: lobby.minRole,
          maxRole: lobby.maxRole,
        })
        if (!result.ok) throw new Error(result.error)
        return
      }

      await sendConfig(nextConfig.banTimerSeconds, nextConfig.pickTimerSeconds)
    }, {
      syncTimeoutMs: currentLobby() ? 9000 : 5000,
      syncTimeoutMessage: 'Save not confirmed. Please try again.',
    })
    return true
  }

  const saveConfigOnBlur = async () => {
    const isHostUser = amHost()
    const nextBanMinutes = banMinutes()
    const nextPickMinutes = pickMinutes()
    const activeField = editingField()

    try {
      if (!isHostUser) return

      const parsedBan = parseTimerMinutesInput(nextBanMinutes)
      const parsedPick = parseTimerMinutesInput(nextPickMinutes)
      const leaderPoolMinimum = leaderPoolMinimumValue()
      const parsedLeaderPool = isRedDeathLobbyMode()
        ? parseLeaderPoolSizeInput(leaderPoolInput(), 2, 10)
        : parseLeaderPoolSizeInput(leaderPoolInput(), leaderPoolMinimum)
      const preserveClampMessage = activeField != null && clampedField === activeField
      if (parsedBan === undefined || parsedPick === undefined || parsedLeaderPool === undefined) {
        optimisticTimerConfig.clearError()
        showErrorMessage(configFieldRangeMessage(activeField))
        const current = optimisticTimerConfig.value()
        setBanMinutes(timerSecondsToMinutesInput(current.banTimerSeconds))
        setPickMinutes(timerSecondsToMinutesInput(current.pickTimerSeconds))
        setLeaderPoolInput(leaderPoolSizeToInput(isRedDeathLobbyMode() ? current.dealOptionsSize : current.leaderPoolSize))
        return
      }

      const banTimerSeconds = parsedBan == null ? null : Math.round(parsedBan * 60)
      const pickTimerSeconds = parsedPick == null ? null : Math.round(parsedPick * 60)
      const current = optimisticTimerConfig.value()
      const leaderPoolSize = isRedDeathLobbyMode() ? current.leaderPoolSize : parsedLeaderPool
      const leaderDataVersion = current.leaderDataVersion
      const blindBans = current.blindBans
      const simultaneousPick = current.simultaneousPick
      const redDeath = current.redDeath
      const dealOptionsSize = isRedDeathLobbyMode() ? parsedLeaderPool : current.dealOptionsSize
      const randomDraft = current.randomDraft
      const duplicateFactions = current.duplicateFactions

      if (
        banTimerSeconds === current.banTimerSeconds
        && pickTimerSeconds === current.pickTimerSeconds
        && leaderPoolSize === current.leaderPoolSize
        && dealOptionsSize === current.dealOptionsSize
      ) {
        optimisticTimerConfig.clearError()
        return
      }

      await commitDraftConfig(
        { banTimerSeconds, pickTimerSeconds, leaderPoolSize, leaderDataVersion, blindBans, simultaneousPick, redDeath, dealOptionsSize, randomDraft, duplicateFactions },
        { preserveConfigMessage: preserveClampMessage },
      )
    }
    finally {
      if (activeField != null && clampedField === activeField) clampedField = null
      setEditingField(current => current === activeField ? null : current)
    }
  }

  const handleLeaderDataVersionChange = async (checked: boolean) => {
    if (!isLobbyMode() || !amHost() || lobbyActionPending() || leaderDataVersionPending()) return
    const current = optimisticTimerConfig.value()
    const leaderDataVersion = checked ? 'beta' : 'live'
    if (leaderDataVersion === current.leaderDataVersion) return
    setLeaderDataVersionPending(true)
    try {
      await commitDraftConfig({
        banTimerSeconds: current.banTimerSeconds,
        pickTimerSeconds: current.pickTimerSeconds,
        leaderPoolSize: current.leaderPoolSize,
        leaderDataVersion,
        blindBans: current.blindBans,
        simultaneousPick: current.simultaneousPick,
        redDeath: current.redDeath,
        dealOptionsSize: current.dealOptionsSize,
        randomDraft: current.randomDraft,
        duplicateFactions: current.duplicateFactions,
      })
    }
    finally {
      setLeaderDataVersionPending(false)
    }
  }

  const handleBlindBansChange = async (checked: boolean) => {
    if (!isLobbyMode() || !amHost() || lobbyActionPending() || blindBansPending() || !supportsBlindBansToggle()) return
    const current = optimisticTimerConfig.value()
    if (checked === current.blindBans) return
    setBlindBansPending(true)
    try {
      await commitDraftConfig({
        banTimerSeconds: current.banTimerSeconds,
        pickTimerSeconds: current.pickTimerSeconds,
        leaderPoolSize: current.leaderPoolSize,
        leaderDataVersion: current.leaderDataVersion,
        blindBans: checked,
        simultaneousPick: current.simultaneousPick,
        redDeath: current.redDeath,
        dealOptionsSize: current.dealOptionsSize,
        randomDraft: current.randomDraft,
        duplicateFactions: current.duplicateFactions,
      })
    }
    finally {
      setBlindBansPending(false)
    }
  }

  const handleSimultaneousPickChange = async (checked: boolean) => {
    if (!isLobbyMode() || !amHost() || lobbyActionPending() || simultaneousPickPending() || lobbyMode() !== 'ffa') return
    const current = optimisticTimerConfig.value()
    if (checked === current.simultaneousPick) return
    setSimultaneousPickPending(true)
    try {
      await commitDraftConfig({
        banTimerSeconds: current.banTimerSeconds,
        pickTimerSeconds: current.pickTimerSeconds,
        leaderPoolSize: current.leaderPoolSize,
        leaderDataVersion: current.leaderDataVersion,
        blindBans: current.blindBans,
        simultaneousPick: checked,
        redDeath: current.redDeath,
        dealOptionsSize: current.dealOptionsSize,
        randomDraft: current.randomDraft,
        duplicateFactions: current.duplicateFactions,
      })
    }
    finally {
      setSimultaneousPickPending(false)
    }
  }

  const handleRedDeathChange = async (checked: boolean) => {
    if (!isLobbyMode() || !amHost() || lobbyActionPending() || redDeathPending()) return
    const lobby = currentLobby()
    const current = optimisticTimerConfig.value()
    if (checked === current.redDeath) return
    if (!checked && redDeathExtraFfaSeatsOccupied()) return

    setRedDeathPending(true)
    try {
      await commitDraftConfig({
        banTimerSeconds: current.banTimerSeconds,
        pickTimerSeconds: current.pickTimerSeconds,
        leaderPoolSize: checked ? null : current.leaderPoolSize,
        leaderDataVersion: checked ? 'live' : current.leaderDataVersion,
        blindBans: checked ? true : current.blindBans,
        simultaneousPick: checked ? false : current.simultaneousPick,
        redDeath: checked,
        dealOptionsSize: checked ? current.dealOptionsSize : null,
        randomDraft: current.randomDraft,
        duplicateFactions: checked && requiresRedDeathDuplicateFactions(lobbyMode())
          ? true
          : current.duplicateFactions,
      }, {
        targetSize: lobby?.mode === 'ffa' ? (checked ? 10 : 8) : undefined,
      })
      showInfoMessage(checked ? 'Red Death enabled.' : 'Red Death disabled.')
    }
    finally {
      setRedDeathPending(false)
    }
  }

  const handleRandomDraftChange = async (checked: boolean) => {
    if (!isLobbyMode() || !amHost() || lobbyActionPending() || randomDraftPending()) return
    const current = optimisticTimerConfig.value()
    if (checked === current.randomDraft) return
    setRandomDraftPending(true)
    try {
      await commitDraftConfig({
        banTimerSeconds: current.banTimerSeconds,
        pickTimerSeconds: current.pickTimerSeconds,
        leaderPoolSize: current.leaderPoolSize,
        leaderDataVersion: current.leaderDataVersion,
        blindBans: current.blindBans,
        simultaneousPick: current.simultaneousPick,
        redDeath: current.redDeath,
        dealOptionsSize: current.dealOptionsSize,
        randomDraft: checked,
        duplicateFactions: current.duplicateFactions,
      })
    }
    finally {
      setRandomDraftPending(false)
    }
  }

  const handleDuplicateFactionsChange = async (checked: boolean) => {
    if (!isLobbyMode() || !amHost() || lobbyActionPending() || duplicateFactionsPending() || duplicateFactionsLocked()) return
    const current = optimisticTimerConfig.value()
    if (checked === current.duplicateFactions) return
    setDuplicateFactionsPending(true)
    try {
      await commitDraftConfig({
        banTimerSeconds: current.banTimerSeconds,
        pickTimerSeconds: current.pickTimerSeconds,
        leaderPoolSize: current.leaderPoolSize,
        leaderDataVersion: current.leaderDataVersion,
        blindBans: current.blindBans,
        simultaneousPick: current.simultaneousPick,
        redDeath: current.redDeath,
        dealOptionsSize: current.dealOptionsSize,
        randomDraft: current.randomDraft,
        duplicateFactions: checked,
      })
    }
    finally {
      setDuplicateFactionsPending(false)
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
      showInfoMessage(`Game mode changed to ${formatModeLabel(nextMode, nextMode, { redDeath: draftConfig().redDeath })}.`)
    }
    finally {
      setLobbyActionPending(false)
    }
  }

  const handle2v2TeamCountToggle = async () => {
    const lobby = currentLobby()
    const currentUserId = userId()
    if (!lobby || !currentUserId || !amHost()) return
    if (lobby.mode !== '2v2' || lobbyActionPending()) return

    const nextTargetSize = lobby.targetSize > 4 ? 4 : 8
    setLobbyActionPending(true)
    clearConfigMessage()
    try {
      const result = await updateLobbyConfig(lobby.mode, lobby.id, currentUserId, { targetSize: nextTargetSize })
      if (!result.ok) {
        showErrorMessage(result.error)
        return
      }

      showInfoMessage(nextTargetSize === 8 ? 'Added two extra teams.' : 'Removed the extra teams.')
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

    const nextMinRole = normalizeLobbyRankRoleValue(value)
    const nextBounds = normalizeCompetitiveTierBounds(nextMinRole, lobby.maxRole)
    if (lobby.minRole === nextBounds.minimum && lobby.maxRole === nextBounds.maximum) return

    setLobbyActionPending(true)
    clearConfigMessage()
    try {
      const result = await updateLobbyConfig(lobby.mode, lobby.id, currentUserId, {
        banTimerSeconds: timerConfig().banTimerSeconds,
        pickTimerSeconds: timerConfig().pickTimerSeconds,
        leaderPoolSize: draftConfig().leaderPoolSize,
        minRole: nextBounds.minimum,
        maxRole: nextBounds.maximum,
      })
      if (!result.ok) {
        showErrorMessage(result.error)
        return
      }

      const refreshedOptions = await fetchLobbyRankedRoles(lobby.mode, lobby.id)
      if (refreshedOptions?.options?.length) setRankedRoleOptions(refreshedOptions.options)
      const optionSource = refreshedOptions?.options?.length ? refreshedOptions.options : rankedRoleOptions()
      const selectedMinRole = nextBounds.minimum ? findRankedRoleOptionByTier(optionSource, nextBounds.minimum) : null
      if (nextBounds.swapped) {
        showInfoMessage('Min and max ranks swapped to keep the range valid.')
      }
      else if (nextBounds.minimum) {
        showRankRoleSetMessage({
          boundLabel: 'Min rank',
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

  const handleLobbyMaxRoleChange = async (value: string) => {
    const lobby = currentLobby()
    const currentUserId = userId()
    if (!lobby || !currentUserId || !amHost()) return
    if (lobbyActionPending()) return

    const nextMaxRole = normalizeLobbyRankRoleValue(value)
    const nextBounds = normalizeCompetitiveTierBounds(lobby.minRole, nextMaxRole)
    if (lobby.minRole === nextBounds.minimum && lobby.maxRole === nextBounds.maximum) return

    setLobbyActionPending(true)
    clearConfigMessage()
    try {
      const result = await updateLobbyConfig(lobby.mode, lobby.id, currentUserId, {
        banTimerSeconds: timerConfig().banTimerSeconds,
        pickTimerSeconds: timerConfig().pickTimerSeconds,
        leaderPoolSize: draftConfig().leaderPoolSize,
        minRole: nextBounds.minimum,
        maxRole: nextBounds.maximum,
      })
      if (!result.ok) {
        showErrorMessage(result.error)
        return
      }

      const refreshedOptions = await fetchLobbyRankedRoles(lobby.mode, lobby.id)
      if (refreshedOptions?.options?.length) setRankedRoleOptions(refreshedOptions.options)
      const optionSource = refreshedOptions?.options?.length ? refreshedOptions.options : rankedRoleOptions()
      const selectedMaxRole = nextBounds.maximum ? findRankedRoleOptionByTier(optionSource, nextBounds.maximum) : null
      if (nextBounds.swapped) {
        showInfoMessage('Min and max ranks swapped to keep the range valid.')
      }
      else if (nextBounds.maximum) {
        showRankRoleSetMessage({
          boundLabel: 'Max rank',
          roleLabel: selectedMaxRole?.label ?? 'Unranked',
          roleColor: selectedMaxRole?.color ?? null,
        })
      }
      else {
        showInfoMessage('Max rank cleared')
      }
    }
    finally {
      setLobbyActionPending(false)
    }
  }

  const handleSaveSteamLink = async (link: string | null) => {
    const lobby = currentLobby()
    const currentUserId = userId()
    if (!lobby || !currentUserId || !amHost()) return
    if (lobbyActionPending()) return
    if (link === lobby.steamLobbyLink) return

    setLobbyActionPending(true)
    clearConfigMessage()
    try {
      const result = await updateLobbyConfig(lobby.mode, lobby.id, currentUserId, {
        banTimerSeconds: timerConfig().banTimerSeconds,
        pickTimerSeconds: timerConfig().pickTimerSeconds,
        leaderPoolSize: draftConfig().leaderPoolSize,
        steamLobbyLink: link,
        minRole: lobby.minRole,
        maxRole: lobby.maxRole,
      })
      if (!result.ok) {
        showErrorMessage(result.error)
        return
      }

      showInfoMessage(link ? 'Steam lobby link updated.' : 'Steam lobby link cleared.')
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

    const optimisticAction = resolveOptimisticLobbyPlacementAction(
      lobby,
      currentUserId,
      currentUserId,
      slot,
      amHost(),
    )

    if (!isCurrentUserSlotted() && props.joinEligibility?.canJoin !== false) {
      setPendingPlaceSelfSlot(slot)
    }

    if (optimisticAction) {
      startOptimisticLobbyAction(optimisticAction)
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
        setPendingPlaceSelfSlot(null)
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

    const optimisticAction = resolveOptimisticLobbyPlacementAction(
      lobby,
      currentUserId,
      draggedPlayerId,
      slot,
      amHost(),
    )

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
      }
      else if (result.transferNotice) {
        showInfoMessage(result.transferNotice)
      }
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
      }
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
    if (!lobby || !currentUserId || !amHost()) return
    const mode = inferGameMode(lobby.mode)
    if (lobbyActionPending() || startPending() || cancelPending()) return

    setLobbyActionPending(true)
    clearConfigMessage()
    try {
      const result = await arrangeLobbySlots(lobby.mode, lobby.id, currentUserId, strategy)
      if (!result.ok) {
        showErrorMessage(result.error)
        return
      }

      const target = arrangeTargetTitle(mode)
      showInfoMessage(strategy === 'randomize' ? `${target} randomized.` : `${target} auto-balanced.`)
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
    if (!isTeamGameMode(mode)) return
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

  const teamColumnsClass = () => isLargeTeamLobbyMode()
    ? 'flex flex-col gap-4 lg:flex-row lg:overflow-x-auto lg:pb-1'
    : cn('gap-4 grid', teamIndices().length > 2 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-2')

  const teamSectionClass = () => isLargeTeamLobbyMode() ? 'min-w-0 lg:min-w-[280px] lg:flex-1' : undefined

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
    name: row.empty ? '[empty]' : row.name,
    avatarUrl: row.avatarUrl ?? null,
    team,
    empty: row.empty,
  })

  const miniColumns = () => {
    if (isTeamMode()) {
      const teamCols = teamIndices().map(team => teamRows(team).map(row => toMiniSeatItem(row, team)))

      if (teamCols.length > 2) {
        const midpoint = Math.ceil(teamCols.length / 2)
        return [
          teamCols.slice(0, midpoint).flat(),
          teamCols.slice(midpoint).flat(),
        ]
      }

      return teamCols
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

  const desktopSetupPanelMaxHeightClass = () => {
    if (amHost()) return 'lg:max-h-[432px]'
    if (isCurrentUserSlotted() && lobbyMode() === '6v6') return 'lg:max-h-[368px]'
    return 'lg:max-h-[336px]'
  }

  return (
    <Show
      when={isMiniView()}
      fallback={(
        <div class="text-fg font-sans bg-bg relative overflow-y-auto min-h-dvh">
          <Show when={props.onSwitchTarget}>
            <button
              type="button"
              class={cn(
                'text-fg-muted border border-border-subtle rounded-md flex h-9 w-9 cursor-pointer transition-colors items-center justify-center z-20 absolute hover:text-fg hover:bg-bg-muted',
                isMobileLayout() ? 'top-12 right-4' : 'top-4 right-6',
              )}
              title="Lobby Overview"
              aria-label="Lobby Overview"
              onClick={() => props.onSwitchTarget?.()}
            >
              <span class="i-ph-squares-four-bold text-base" />
            </button>
          </Show>
          <SteamLobbyButton
            steamLobbyLink={steamLobbyLink()}
            isHost={amHost()}
            onSaveSteamLink={isLobbyMode() ? handleSaveSteamLink : undefined}
            savePending={lobbyActionPending()}
            class={cn(
              'z-20 absolute',
              isMobileLayout() ? 'top-12 left-4 h-9 w-9' : 'top-4 left-6 h-9 w-9',
            )}
          />
          <div class={cn('mx-auto px-6 py-4 flex min-h-dvh flex-col gap-6 max-w-5xl w-full lg:h-dvh lg:overflow-hidden', isMobileLayout() && 'pt-12')}>
            <div class="grid grid-cols-[2.25rem_minmax(0,1fr)_2.25rem] items-center">
              <div class="h-9 w-9" />
              <div class="text-center">
                <h1 class="text-2xl text-heading mb-1">Draft Setup</h1>
                <span class={cn('text-sm font-medium', modeLabelClass())}>{formatId()}</span>
              </div>
              <div class="h-9 w-9" />
            </div>

            <div class={cn(
              'gap-4 grid grid-cols-1 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_320px] lg:grid-rows-[minmax(0,1fr)]',
              desktopSetupPanelMaxHeightClass(),
            )}
            >
              <div class="p-4 rounded-lg bg-bg-subtle flex flex-col min-h-0 overflow-hidden lg:h-full">
                <div class="mb-3 flex items-center justify-between gap-3 text-xs text-fg-subtle tracking-widest font-bold uppercase">
                  <span>Players</span>
                  <Show when={lobbyBalance()?.lowConfidence}>
                    <span class="inline-flex items-center gap-1 text-[11px] text-fg-subtle/70 font-medium tracking-normal normal-case">
                      <span class="i-ph-warning-circle text-xs" />
                      low confidence
                    </span>
                  </Show>
                </div>

                <div class="pr-1 flex-1 min-h-0 overflow-y-auto">
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
                    <div class={teamColumnsClass()}>
                      <For each={teamIndices()}>
                        {team => (
                          <div class={teamSectionClass()}>
                            <div class="mb-2 flex items-center justify-between gap-3">
                              <div class="text-xs text-accent tracking-wider font-bold">
                                Team
                                {' '}
                                {String.fromCharCode(65 + team)}
                              </div>
                              <Show when={teamBalance(team)}>
                                {(summary) => (
                                  <div class="text-[11px] text-right text-accent font-semibold whitespace-nowrap">
                                    {Math.round(summary().probability * 100)}%
                                    <Show when={summary().uncertainty >= 0.01}>
                                      <span class="ml-1 text-fg-subtle font-normal">
                                        ±{Math.round(summary().uncertainty * 100)}
                                      </span>
                                    </Show>
                                  </div>
                                )}
                              </Show>
                            </div>
                            {renderTeamColumn(teamRows(team))}
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>

                  <Show when={show2v2TeamCountToggle()}>
                    <div class="mt-4 flex flex-col gap-2">
                      <div class="flex gap-3 items-center justify-center">
                        <div class="h-px flex-1 bg-border-subtle" />
                        <button
                          type="button"
                          class={cn(
                            'border rounded-full flex h-8 w-8 items-center justify-center transition-colors',
                            canToggle2v2Teams()
                              ? 'border-border text-fg-muted hover:text-fg hover:border-border-hover hover:bg-bg-muted/40 cursor-pointer'
                              : 'border-border-subtle text-fg-subtle/60 cursor-default',
                          )}
                          disabled={!canToggle2v2Teams()}
                          title={twoVTwoTeamCountToggleTitle()}
                          aria-label={twoVTwoTeamCountToggleLabel()}
                          onClick={() => void handle2v2TeamCountToggle()}
                        >
                          <span class={cn(hasExpanded2v2Teams() ? 'i-ph-minus-bold' : 'i-ph-plus-bold', 'text-sm')} />
                        </button>
                        <div class="h-px flex-1 bg-border-subtle" />
                      </div>
                    </div>
                  </Show>

                </div>
              </div>

              <div class="p-4 rounded-lg bg-bg-subtle flex flex-col gap-3 min-h-0 overflow-hidden lg:h-full">
                <div class="text-xs text-fg-subtle tracking-widest font-bold flex uppercase items-center justify-between">
                  <span>Config</span>
                  <span class="flex h-4 w-4 items-center justify-center">
                    <Show when={props.showJoinPending || optimisticTimerConfig.status() === 'pending' || lobbyActionPending() || startPending()}>
                      <span class="i-gg:spinner text-sm text-accent animate-spin" />
                    </Show>
                  </span>
                </div>

                <div class="pr-4 flex flex-1 flex-col gap-3 min-h-0 overflow-y-auto -mr-3">
                  <Show when={isLobbyMode() && amHost() && supportsBlindBansToggle()}>
                    <div class="px-1 flex gap-3 items-center justify-between">
                      <span class={cn('text-sm font-medium', optimisticDraftConfig().blindBans ? 'text-accent' : 'text-fg-muted')}>
                        Blind Bans
                      </span>
                      <Switch
                        checked={optimisticDraftConfig().blindBans}
                        disabled={lobbyActionPending() || blindBansPending()}
                        class="w-auto"
                        onChange={checked => void handleBlindBansChange(checked)}
                      />
                    </div>
                  </Show>

                  <Show when={isLobbyMode() && amHost() && !isRedDeathLobbyMode() && hasBetaLeaderData}>
                    <div class="px-1 flex gap-3 items-center justify-between">
                      <span class={cn('text-sm font-medium', normalizeAvailableLeaderDataVersion(optimisticDraftConfig().leaderDataVersion) === 'beta' ? 'text-accent' : 'text-fg-muted')}>
                        BBG Beta
                      </span>
                      <Switch
                        checked={normalizeAvailableLeaderDataVersion(optimisticDraftConfig().leaderDataVersion) === 'beta'}
                        disabled={lobbyActionPending() || leaderDataVersionPending()}
                        class="w-auto"
                        onChange={checked => void handleLeaderDataVersionChange(checked)}
                      />
                    </div>
                  </Show>

                  <Show when={isLobbyMode() && amHost() && lobbyMode() === 'ffa' && !isRedDeathLobbyMode()}>
                    <div class="px-1 flex gap-3 items-center justify-between">
                      <span class={cn('text-sm font-medium', optimisticDraftConfig().simultaneousPick ? 'text-accent' : 'text-fg-muted')}>
                        Simultaneous pick
                      </span>
                      <Switch
                        checked={optimisticDraftConfig().simultaneousPick}
                        disabled={lobbyActionPending() || simultaneousPickPending()}
                        class="w-auto"
                        onChange={checked => void handleSimultaneousPickChange(checked)}
                      />
                    </div>
                  </Show>

                  <Show when={isLobbyMode() && amHost()}>
                    <Dropdown
                      label="Game Mode"
                      value={lobbyMode()}
                      disabled={lobbyActionPending()}
                      options={lobbyModeOptions()}
                      onChange={value => void handleLobbyModeChange(inferGameMode(value))}
                    />
                  </Show>

                  <Show
                    when={amHost()}
                    fallback={(
                      <div class="flex flex-col gap-2">
                        <Show when={isLobbyMode() && supportsBlindBansToggle()}>
                          <ReadonlyTimerRow
                            label="Blind bans"
                            value={formattedBlindBans()}
                            valueClass={draftConfig().blindBans ? 'text-accent' : undefined}
                          />
                        </Show>
                        <Show when={!isRedDeathLobbyMode() && hasBetaLeaderData}>
                          <ReadonlyTimerRow
                            label="BBG"
                            value={formattedBbgVersion()}
                            valueClass={normalizeAvailableLeaderDataVersion(draftConfig().leaderDataVersion) === 'beta' ? 'text-accent' : undefined}
                          />
                        </Show>
                        <Show when={isLobbyMode() && lobbyMode() === 'ffa' && !isRedDeathLobbyMode()}>
                          <ReadonlyTimerRow
                            label="Simultaneous pick"
                            value={formattedSimultaneousPick()}
                            valueClass={draftConfig().simultaneousPick ? 'text-accent' : undefined}
                          />
                        </Show>
                        <Show when={isLobbyMode() && !isUnrankedMode(lobbyMode())}>
                          <>
                            <ReadonlyTimerRow
                              label="Min rank"
                              value={formattedLobbyMinRole()}
                            />
                            <ReadonlyTimerRow
                              label="Max rank"
                              value={formattedLobbyMaxRole()}
                            />
                          </>
                        </Show>
                        <ReadonlyTimerRow
                          label={poolInputLabel()}
                          value={formattedLeaderPool()}
                        />
                        <Show when={!isRedDeathLobbyMode()}>
                          <ReadonlyTimerRow
                            label="Ban timer"
                            value={formatTimerValue(timerConfig().banTimerSeconds, serverDefaultTimerConfig().banTimerSeconds)}
                          />
                        </Show>
                        <ReadonlyTimerRow
                          label="Pick timer"
                          value={formatTimerValue(timerConfig().pickTimerSeconds, serverDefaultTimerConfig().pickTimerSeconds)}
                        />
                        <Show when={isLobbyMode()}>
                          <ReadonlyTimerRow
                            label="Random draft"
                            value={formattedRandomDraft()}
                            valueClass={draftConfig().randomDraft ? 'text-accent' : undefined}
                          />
                          <ReadonlyTimerRow
                            label={duplicateOptionLabel()}
                            value={formattedDuplicateFactions()}
                            valueClass={draftDuplicateFactions() ? 'text-accent' : undefined}
                          />
                        </Show>
                      </div>
                    )}
                  >
                    <div class="flex flex-col gap-2">
                      <Show when={isLobbyMode() && !isUnrankedMode(lobbyMode())}>
                        <div class="flex flex-col gap-1.5">
                          <div class="text-[11px] text-fg-subtle tracking-wider font-semibold pl-0.5 uppercase">Min and max matchmaking rank</div>
                          <div class="gap-2 grid grid-cols-1 sm:grid-cols-2">
                            <Dropdown
                              ariaLabel="Minimum matchmaking rank"
                              value={lobbyMinRoleValue()}
                              disabled={lobbyActionPending()}
                              options={minRoleDropdownOptions()}
                              onChange={value => void handleLobbyMinRoleChange(value)}
                            />
                            <Dropdown
                              ariaLabel="Maximum matchmaking rank"
                              value={lobbyMaxRoleValue()}
                              disabled={lobbyActionPending()}
                              options={maxRoleDropdownOptions()}
                              onChange={value => void handleLobbyMaxRoleChange(value)}
                            />
                          </div>
                        </div>
                      </Show>

                      <Show when={isLobbyMode()}>
                        <TextInput
                          type="number"
                          label={poolInputLabel()}
                          min={isRedDeathLobbyMode() ? '2' : String(leaderPoolMinimumValue())}
                          max={isRedDeathLobbyMode() ? '10' : String(MAX_LEADER_POOL_INPUT)}
                          step="1"
                          value={leaderPoolInput()}
                          placeholder={leaderPoolPlaceholderValue()}
                          onFocus={() => setEditingField('leaderPool')}
                          onClamp={() => {
                            clampedField = 'leaderPool'
                            showErrorMessage(configFieldRangeMessage('leaderPool'))
                          }}
                          onInput={(event) => {
                            optimisticTimerConfig.clearError()
                            clearConfigMessage()
                            setLeaderPoolInput(event.currentTarget.value)
                          }}
                          onBlur={() => void saveConfigOnBlur()}
                          />
                        </Show>

                      <Show when={!isRedDeathLobbyMode()}>
                        <TextInput
                          type="number"
                          label="Ban Timer (minutes)"
                          min="0"
                          max={String(MAX_TIMER_MINUTES)}
                          step={timerInputStep(banMinutes())}
                          roundOnBlur={false}
                          value={banMinutes()}
                          placeholder={banTimerPlaceholder()}
                          onFocus={() => setEditingField('ban')}
                          onClamp={() => {
                            clampedField = 'ban'
                            showErrorMessage(configFieldRangeMessage('ban'))
                          }}
                          onInput={(event) => {
                            optimisticTimerConfig.clearError()
                            clearConfigMessage()
                            setBanMinutes(event.currentTarget.value)
                          }}
                          onBlur={() => void saveConfigOnBlur()}
                        />
                      </Show>

                      <TextInput
                        type="number"
                        label="Pick Timer (minutes)"
                        min="0"
                        max={String(MAX_TIMER_MINUTES)}
                        step={timerInputStep(pickMinutes())}
                        roundOnBlur={false}
                        value={pickMinutes()}
                        placeholder={pickTimerPlaceholder()}
                        onFocus={() => setEditingField('pick')}
                        onClamp={() => {
                          clampedField = 'pick'
                          showErrorMessage(configFieldRangeMessage('pick'))
                        }}
                        onInput={(event) => {
                          optimisticTimerConfig.clearError()
                          clearConfigMessage()
                          setPickMinutes(event.currentTarget.value)
                        }}
                          onBlur={() => void saveConfigOnBlur()}
                        />

                        <Show when={isLobbyMode()}>
                          <div class="px-1 flex gap-3 items-center justify-between">
                            <span class={cn('text-sm font-medium', optimisticDraftConfig().randomDraft ? 'text-accent' : 'text-fg-muted')}>
                              Random draft
                            </span>
                            <Switch
                              checked={optimisticDraftConfig().randomDraft}
                              disabled={lobbyActionPending() || randomDraftPending()}
                              class="w-auto"
                              onChange={checked => void handleRandomDraftChange(checked)}
                            />
                          </div>

                          <div class="px-1 flex gap-3 items-center justify-between">
                            <span class={cn('text-sm font-medium', optimisticDuplicateFactions() ? 'text-accent' : 'text-fg-muted')}>
                              {duplicateOptionLabel()}
                            </span>
                            <Switch
                              checked={optimisticDuplicateFactions()}
                              disabled={lobbyActionPending() || duplicateFactionsPending() || duplicateFactionsLocked()}
                              class="w-auto"
                              onChange={checked => void handleDuplicateFactionsChange(checked)}
                            />
                          </div>

                          <div class="mt-1 pt-3 border-t border-border-subtle px-1 flex gap-3 items-center justify-between">
                            <span class={cn('text-sm font-medium', optimisticDraftConfig().redDeath ? 'text-[#f97316]' : 'text-fg-muted')}>
                              Red Death
                            </span>
                            <Switch
                              checked={optimisticDraftConfig().redDeath}
                              disabled={lobbyActionPending() || redDeathPending() || !canToggleRedDeath()}
                              class="w-auto"
                              tone="orange"
                              onChange={checked => void handleRedDeathChange(checked)}
                            />
                          </div>
                        </Show>
                      </div>
                    </Show>
                </div>

                <div class="min-h-5 shrink-0">
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
                        when={configMessageTone() === 'info' && rankRoleSetDetail()}
                        fallback={<span class="leading-relaxed">{configMessage()}</span>}
                      >
                        <RankRoleSetNotice detail={rankRoleSetDetail()!} />
                      </Show>
                    </div>
                  </Show>
                </div>
              </div>
            </div>

            <div class="shrink-0 flex justify-center">
              <Show
                when={amHost()}
                fallback={(
                  <div class="flex flex-col gap-2 items-center">
                    <Show when={isLobbyMode() && (!isCurrentUserSlotted() || canLeaveLobby())}>
                      <div class="flex flex-wrap gap-3 items-center justify-center">
                        <Show when={!isCurrentUserSlotted()}>
                          <button
                            class="text-sm text-bg font-bold px-8 py-2.5 rounded-lg bg-accent cursor-pointer transition-colors disabled:opacity-60 disabled:cursor-default hover:brightness-110"
                            title={joinLobbyButtonTitle()}
                            aria-label="Join Lobby"
                            disabled={!canJoinLobby() || lobbyActionPending()}
                            onClick={() => {
                              const slot = joinLobbyTargetSlot()
                              if (slot == null) return
                              void handlePlaceSelf(slot)
                            }}
                          >
                            Join Lobby
                          </button>
                        </Show>

                        <Show when={canLeaveLobby()}>
                          <button
                            class="text-sm text-fg-muted px-6 py-2.5 border border-border rounded-lg bg-bg-muted/25 cursor-pointer transition-colors hover:text-fg hover:border-border-hover hover:bg-bg-muted/50 disabled:opacity-60 disabled:cursor-default"
                            title="Leave Lobby"
                            aria-label="Leave Lobby"
                            disabled={lobbyActionPending()}
                            onClick={() => {
                              const slot = currentUserLobbySlot()
                              if (slot == null) return
                              void handleRemoveFromSlot(slot)
                            }}
                          >
                            Leave Lobby
                          </button>
                        </Show>
                      </div>
                    </Show>

                    <span class="text-sm text-fg-subtle">{setupStatusText()}</span>
                  </div>
                )}
              >
                <Show
                  when={!isLobbyMode()}
                  fallback={(
                    <div class="flex gap-3 items-center">
                      <button
                        class="text-sm text-bg font-bold px-8 py-2.5 rounded-lg bg-accent cursor-pointer transition-colors disabled:opacity-60 disabled:cursor-default hover:brightness-110"
                        disabled={!canStartLobby() || startPending() || lobbyActionPending()}
                        onClick={() => void handleStartLobbyDraftAction()}
                      >
                        {startPending() ? 'Starting' : 'Start Draft'}
                      </button>
                      <button
                        class="text-sm text-fg-muted px-6 py-2.5 border border-border rounded-lg bg-bg-muted/25 cursor-pointer transition-colors hover:text-fg hover:border-border-hover hover:bg-bg-muted/50 disabled:opacity-60 disabled:cursor-default"
                        disabled={cancelPending() || startPending() || lobbyActionPending()}
                        onClick={() => void handleCancelAction()}
                      >
                        {cancelPending() ? 'Cancelling' : 'Cancel Lobby'}
                      </button>
                      <button
                        class="text-fg-muted border border-border rounded-lg bg-bg-muted/25 flex h-10 w-10 cursor-pointer transition-colors items-center justify-center hover:text-fg hover:border-border-hover hover:bg-bg-muted/50 disabled:opacity-60 disabled:cursor-default"
                        title={`Randomize ${arrangeTargetLabel(lobbyMode())}`}
                        aria-label={`Randomize ${arrangeTargetLabel(lobbyMode())}`}
                        disabled={cancelPending() || startPending() || lobbyActionPending()}
                        onClick={() => void handleArrangeLobby('randomize')}
                      >
                        <span class="i-ph:shuffle-simple-bold text-lg" />
                      </button>
                      <button
                        class="text-fg-muted border border-border rounded-lg bg-bg-muted/25 flex h-10 w-10 cursor-pointer transition-colors items-center justify-center hover:text-fg hover:border-border-hover hover:bg-bg-muted/50 disabled:opacity-60 disabled:cursor-default"
                        title={`Auto-balance ${arrangeTargetLabel(lobbyMode())}`}
                        aria-label={`Auto-balance ${arrangeTargetLabel(lobbyMode())}`}
                        disabled={cancelPending() || startPending() || lobbyActionPending()}
                        onClick={() => void handleArrangeLobby('balance')}
                      >
                        <span class="i-ph:scales-bold text-lg" />
                      </button>
                      <Show when={fillTestPlayersAvailable()}>
                        <button
                          class="text-sm text-fg-muted px-6 py-2.5 border border-border rounded-lg bg-bg-muted/25 cursor-pointer transition-colors hover:text-fg hover:border-border-hover hover:bg-bg-muted/50 disabled:opacity-60 disabled:cursor-default"
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
        modeLabel={miniFormatId()}
        title="Draft Setup"
        titleAccent={isRedDeathLobbyMode() ? 'orange' : 'gold'}
        rightLabel={currentLobby() ? `${filledSlots()}/${currentLobby()!.targetSize}` : null}
      >
        <MiniSeatGrid
          columns={miniColumns()}
        />
      </MiniFrame>
    </Show>
  )
}
