import type { Accessor, Setter } from 'solid-js'
import type { DraftTimerConfig, LobbyModeValue, RankRoleSetDetail } from './helpers'
import type { DraftSetupPageProps, EditableConfigField, LobbyEditableDraftConfig } from './types'
import type { LobbySnapshot, RankedRoleOptionSnapshot } from '~/client/stores'
import { canStartWithPlayerCount, CIV_BLITZ_DEFAULT_OPTION_COUNT, CIV_BLITZ_MAX_OPTION_COUNT, CIV_BLITZ_MIN_OPTION_COUNT, formatModeLabel, GAME_MODE_CHOICES, inferGameMode, isMapVoteSupportedForMode, isUnrankedMode, maxPlayerCount, normalizeAvailableLeaderDataVersion, normalizeCompetitiveTierBounds, requiresRedDeathDuplicateFactions } from '@civup/game'
import { createEffect, createSignal, onCleanup } from 'solid-js'
import { createOptimisticState } from '~/client/lib/optimistic-state'
import {
  canFillLobbyWithTestPlayers,
  draftStore,
  fetchLobbyRankedRoles,
  isRedDeathDraft,
  sendConfig,
  updateLobbyConfig,
  updateLobbyMode,
  userId,
} from '~/client/stores'
import {
  findRankedRoleOptionByTier,
  formatLeaderPoolValue,
  formatLobbyMaxRole,
  formatLobbyMinRole,
  formatTimerValue,
  getLeaderPoolSizeMaximum,
  getLeaderPoolSizeMinimum,
  getTimerConfigFromDraft,
  leaderPoolSizePlaceholder,
  leaderPoolSizeToInput,
  MAX_TIMER_MINUTES,
  normalizeLobbyRankRoleValue,
  parseLeaderPoolSizeInput,
  parseTimerMinutesInput,
  supportsBlindBansControl,
  timerSecondsToMinutesInput,
  timerSecondsToMinutesPlaceholder,
} from './helpers'

function sameLobbyDraftConfig(a: LobbyEditableDraftConfig, b: LobbyEditableDraftConfig): boolean {
  return a.banTimerSeconds === b.banTimerSeconds
    && a.pickTimerSeconds === b.pickTimerSeconds
    && a.leaderPoolSize === b.leaderPoolSize
    && a.leaderDataVersion === b.leaderDataVersion
    && a.mapVoteEnabled === b.mapVoteEnabled
    && a.blindBans === b.blindBans
    && a.blindPicks === b.blindPicks
    && a.simultaneousPick === b.simultaneousPick
    && a.permanentAlly === b.permanentAlly
    && a.redDeath === b.redDeath
    && a.dealOptionsSize === b.dealOptionsSize
    && a.civBlitz === b.civBlitz
    && a.civBlitzOptionCount === b.civBlitzOptionCount
    && a.civBlitzExcludeBbgExpanded === b.civBlitzExcludeBbgExpanded
    && a.randomDraft === b.randomDraft
    && a.hiddenDraft === b.hiddenDraft
    && a.duplicateFactions === b.duplicateFactions
    && a.closed === b.closed
}

export function useDraftSetupConfigState(input: {
  props: DraftSetupPageProps
  currentLobby: Accessor<LobbySnapshot | null>
  amHost: Accessor<boolean>
  canSaveSteamLobbyLink: Accessor<boolean>
  isLobbyMode: Accessor<boolean>
  lobbyMode: Accessor<LobbyModeValue>
  filledSlots: Accessor<number>
  lobbyActionPending: Accessor<boolean>
  setLobbyActionPending: Setter<boolean>
  startPending: Accessor<boolean>
  clearConfigMessage: () => void
  showErrorMessage: (message: string) => void
  showInfoMessage: (message: string) => void
  showRankRoleSetMessage: (detail: RankRoleSetDetail) => void
}) {
  const state = () => draftStore.state
  const [banMinutes, setBanMinutes] = createSignal('')
  const [pickMinutes, setPickMinutes] = createSignal('')
  const [leaderPoolInput, setLeaderPoolInput] = createSignal('')
  const [editingField, setEditingField] = createSignal<EditableConfigField | null>(null)
  const [leaderDataVersionPending, setLeaderDataVersionPending] = createSignal(false)
  const [mapVoteEnabledPending, setMapVoteEnabledPending] = createSignal(false)
  const [blindBansPending, setBlindBansPending] = createSignal(false)
  const [blindPicksPending, setBlindPicksPending] = createSignal(false)
  const [simultaneousPickPending, setSimultaneousPickPending] = createSignal(false)
  const [permanentAllyPending, setPermanentAllyPending] = createSignal(false)
  const [redDeathPending, setRedDeathPending] = createSignal(false)
  const [civBlitzPending, setCivBlitzPending] = createSignal(false)
  const [civBlitzExcludeBbgExpandedPending, setCivBlitzExcludeBbgExpandedPending] = createSignal(false)
  const [randomDraftPending, setRandomDraftPending] = createSignal(false)
  const [hiddenDraftPending, setHiddenDraftPending] = createSignal(false)
  const [duplicateFactionsPending, setDuplicateFactionsPending] = createSignal(false)
  const [closedPending, setClosedPending] = createSignal(false)
  const [closedOverride, setClosedOverride] = createSignal<boolean | null>(null)
  const [lobbyTimerConfig, setLobbyTimerConfig] = createSignal<LobbyEditableDraftConfig | null>(input.props.lobby ? buildEditableLobbyDraftConfig(input.props.lobby) : null)
  const [rankedRoleOptions, setRankedRoleOptions] = createSignal<RankedRoleOptionSnapshot[]>(input.props.prefetchedRankedRoleOptions ?? [])
  const [fillTestPlayersAvailable, setFillTestPlayersAvailable] = createSignal(input.props.prefetchedFillTestPlayersAvailable ?? false)
  let fillTestPlayersAvailabilityKey: string | null = null
  let rankedRoleOptionsFetchKey: string | null = null
  let clampedField: EditableConfigField | null = null
  let configPersistQueue: Promise<void> = Promise.resolve()
  let editingFocusVersion = 0

  createEffect(() => {
    const lobby = input.currentLobby()
    if (!lobby) {
      setLobbyTimerConfig(null)
      return
    }

    setLobbyTimerConfig(buildEditableLobbyDraftConfig(lobby))
  })

  createEffect(() => {
    if (input.props.prefetchedRankedRoleOptions == null) return
    setRankedRoleOptions(input.props.prefetchedRankedRoleOptions)
  })

  createEffect(() => {
    const lobby = input.currentLobby()
    if (!lobby) {
      rankedRoleOptionsFetchKey = null
      setRankedRoleOptions([])
      return
    }
    if (input.props.prefetchedRankedRoleOptions != null) {
      rankedRoleOptionsFetchKey = null
      setRankedRoleOptions(input.props.prefetchedRankedRoleOptions)
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
    onCleanup(() => { cancelled = true })
  })

  createEffect(() => {
    if (input.props.prefetchedFillTestPlayersAvailable == null) return
    setFillTestPlayersAvailable(input.props.prefetchedFillTestPlayersAvailable)
  })

  createEffect(() => {
    const lobby = input.currentLobby()
    if (!lobby) {
      fillTestPlayersAvailabilityKey = null
      setFillTestPlayersAvailable(false)
      return
    }
    if (input.props.prefetchedFillTestPlayersAvailable != null) {
      fillTestPlayersAvailabilityKey = null
      setFillTestPlayersAvailable(input.props.prefetchedFillTestPlayersAvailable)
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
    onCleanup(() => { cancelled = true })
  })

  const draftConfig = (): LobbyEditableDraftConfig => {
    const lobby = input.currentLobby()
    if (lobby) return lobbyTimerConfig() ?? buildEditableLobbyDraftConfig(lobby)

    return {
      ...getTimerConfigFromDraft(state()),
      leaderPoolSize: null,
      leaderDataVersion: 'live',
      mapVoteEnabled: false,
      blindBans: true,
      blindPicks: false,
      simultaneousPick: state()?.formatId === 'default-ffa-simultaneous',
      permanentAlly: true,
      redDeath: isRedDeathDraft(),
      dealOptionsSize: null,
      civBlitz: false,
      civBlitzOptionCount: CIV_BLITZ_DEFAULT_OPTION_COUNT,
      civBlitzExcludeBbgExpanded: true,
      randomDraft: false,
      hiddenDraft: false,
      duplicateFactions: false,
      closed: false,
    }
  }

  const timerConfig = (): DraftTimerConfig => ({
    banTimerSeconds: draftConfig().banTimerSeconds,
    pickTimerSeconds: draftConfig().pickTimerSeconds,
  })

  const serverDefaultTimerConfig = (): DraftTimerConfig => {
    const lobby = input.currentLobby()
    return lobby
      ? { banTimerSeconds: lobby.serverDefaults.banTimerSeconds, pickTimerSeconds: lobby.serverDefaults.pickTimerSeconds }
      : { banTimerSeconds: null, pickTimerSeconds: null }
  }

  const leaderPoolPlayerCount = () => input.currentLobby()?.entries.filter(entry => entry != null).length ?? state()?.seats.length ?? 0
  const leaderPoolValidationCount = () => input.currentLobby()?.targetSize ?? state()?.seats.length ?? leaderPoolPlayerCount()
  const leaderPoolMinimumValue = () => isCivBlitzLobbyMode() ? CIV_BLITZ_MIN_OPTION_COUNT : getLeaderPoolSizeMinimum(input.lobbyMode(), leaderPoolValidationCount())
  const leaderPoolMaximumValue = () => isCivBlitzLobbyMode() ? CIV_BLITZ_MAX_OPTION_COUNT : getLeaderPoolSizeMaximum(optimisticDraftConfig().leaderDataVersion)
  const lobbyLeaderPoolDefaultSize = () => input.currentLobby()?.lobbyRank?.leaderPoolSize ?? null
  const isRedDeathLobbyMode = () => input.currentLobby() ? optimisticDraftConfig().redDeath : isRedDeathDraft()
  const isCivBlitzLobbyMode = () => input.currentLobby() ? optimisticDraftConfig().civBlitz : false
  const leaderPoolPlaceholderValue = () => {
    if (isCivBlitzLobbyMode()) return String(draftConfig().civBlitzOptionCount ?? CIV_BLITZ_DEFAULT_OPTION_COUNT)
    if (isRedDeathLobbyMode()) return String(draftConfig().dealOptionsSize ?? 2)
    const defaultSize = lobbyLeaderPoolDefaultSize()
    return defaultSize == null ? leaderPoolSizePlaceholder(input.lobbyMode(), leaderPoolPlayerCount(), input.currentLobby()?.targetSize) : String(defaultSize)
  }
  const currentDraftLeaderPoolSize = () => {
    const draftState = state()
    if (!draftState) return null
    return new Set([...draftState.availableCivIds, ...draftState.bans.map(selection => selection.civId), ...draftState.picks.map(selection => selection.civId)]).size
  }
  const formattedLeaderPool = () => {
    if (isCivBlitzLobbyMode()) return String(draftConfig().civBlitzOptionCount ?? CIV_BLITZ_DEFAULT_OPTION_COUNT)
    if (isRedDeathLobbyMode()) return String(draftConfig().dealOptionsSize ?? 2)
    const lobby = input.currentLobby()
    if (lobby) {
      const leaderPoolSize = draftConfig().leaderPoolSize
      if (leaderPoolSize != null) return String(leaderPoolSize)
      const defaultSize = lobbyLeaderPoolDefaultSize()
      return defaultSize == null ? formatLeaderPoolValue(null, inferGameMode(lobby.mode), leaderPoolPlayerCount(), lobby.targetSize) : String(defaultSize)
    }
    const size = currentDraftLeaderPoolSize()
    return size == null ? 'Unknown' : String(size)
  }
  const banTimerPlaceholder = () => timerSecondsToMinutesPlaceholder(serverDefaultTimerConfig().banTimerSeconds)
  const pickTimerPlaceholder = () => timerSecondsToMinutesPlaceholder(serverDefaultTimerConfig().pickTimerSeconds)
  const timerInputStep = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed) return '1'
    const numeric = Number(trimmed)
    if (!Number.isFinite(numeric)) return '0.1'
    return numeric >= 1 && Number.isInteger(numeric) ? '1' : '0.1'
  }

  const optimisticTimerConfig = createOptimisticState(draftConfig, { equals: sameLobbyDraftConfig })
  const optimisticDraftConfig = () => optimisticTimerConfig.value()
  const formattedMapVote = () => draftConfig().mapVoteEnabled ? 'On' : 'Off'
  const formattedBbgVersion = () => normalizeAvailableLeaderDataVersion(draftConfig().leaderDataVersion) === 'beta' ? 'Beta' : 'Live'
  const formattedBlindBans = () => draftConfig().blindBans ? 'Blind' : 'Draft'
  const formattedBlindPicks = () => draftConfig().blindPicks ? 'Blind' : 'Draft'
  const formattedSimultaneousPick = () => draftConfig().simultaneousPick ? 'On' : 'Off'
  const formattedPermanentAlly = () => draftConfig().permanentAlly ? 'On' : 'Off'
  const formattedRandomDraft = () => draftConfig().randomDraft ? 'On' : 'Off'
  const formattedHiddenDraft = () => draftConfig().hiddenDraft ? 'On' : 'Off'
  const formattedCivBlitz = () => draftConfig().civBlitz ? 'On' : 'Off'
  const formattedCivBlitzExcludeBbgExpanded = () => draftConfig().civBlitzExcludeBbgExpanded ? 'On' : 'Off'
  const duplicateFactionsLocked = () => isRedDeathLobbyMode() && requiresRedDeathDuplicateFactions(input.lobbyMode())
  const draftDuplicateFactions = () => duplicateFactionsLocked() ? true : draftConfig().duplicateFactions
  const optimisticDuplicateFactions = () => duplicateFactionsLocked() ? true : optimisticDraftConfig().duplicateFactions
  const duplicateOptionLabel = () => isRedDeathLobbyMode() ? 'Duplicate factions' : 'Duplicate leaders'
  const formattedDuplicateFactions = () => draftDuplicateFactions() ? 'On' : 'Off'
  const poolInputLabel = () => isCivBlitzLobbyMode() ? 'Options' : isRedDeathLobbyMode() ? 'Factions' : 'Leaders'
  const modeLabelClass = () => isCivBlitzLobbyMode() ? 'text-cyan-300' : isRedDeathLobbyMode() ? 'text-[#f97316]' : 'text-accent'
  const formattedBanTimer = () => formatTimerValue(timerConfig().banTimerSeconds, serverDefaultTimerConfig().banTimerSeconds)
  const formattedPickTimer = () => formatTimerValue(timerConfig().pickTimerSeconds, serverDefaultTimerConfig().pickTimerSeconds)
  const isTournamentLobby = () => input.currentLobby()?.tournament?.configLocked === true
  const isUnrankedLobbyMode = () => isUnrankedMode(input.lobbyMode()) || optimisticDraftConfig().civBlitz
  const canStartLobby = () => {
    const lobby = input.currentLobby()
    if (!lobby) return false
    return canStartWithPlayerCount(inferGameMode(lobby.mode), input.filledSlots(), lobby.targetSize, { redDeath: optimisticDraftConfig().redDeath, permanentAlly: optimisticDraftConfig().permanentAlly })
  }
  const lobbyMinRoleValue = () => input.currentLobby()?.minRole ?? ''
  const formattedLobbyMinRole = () => formatLobbyMinRole(input.currentLobby()?.minRole ?? null, rankedRoleOptions())
  const lobbyMaxRoleValue = () => input.currentLobby()?.maxRole ?? ''
  const formattedLobbyMaxRole = () => formatLobbyMaxRole(input.currentLobby()?.maxRole ?? null, rankedRoleOptions())
  const lobbyModeOptions = () => GAME_MODE_CHOICES.map(choice => ({
    value: choice.value,
    label: choice.name,
    disabled: input.filledSlots() > ((choice.value === 'ffa' && optimisticDraftConfig().redDeath) ? 10 : maxPlayerCount(choice.value)),
  }))
  const redDeathExtraFfaSeatsOccupied = () => {
    const lobby = input.currentLobby()
    return Boolean(lobby && lobby.mode === 'ffa' && !optimisticDraftConfig().redDeath && (lobby.entries.slice(10) ?? []).some(entry => entry != null))
  }
  const regularFfaExtraSeatsOccupied = () => {
    const lobby = input.currentLobby()
    return Boolean(lobby && lobby.mode === 'ffa' && (lobby.entries.slice(8) ?? []).some(entry => entry != null))
  }
  const canToggleRedDeath = () => !isTournamentLobby() && !redDeathExtraFfaSeatsOccupied()
  const supportsMapVoteToggle = () => input.isLobbyMode() && !isTournamentLobby() && isMapVoteSupportedForMode(input.lobbyMode(), { redDeath: isRedDeathLobbyMode() })
  const supportsBlindBansToggle = () => input.isLobbyMode() && !isTournamentLobby() && supportsBlindBansControl(input.lobbyMode(), { redDeath: isRedDeathLobbyMode(), targetSize: input.currentLobby()?.targetSize })
  const supportsBlindPicksToggle = () => input.isLobbyMode() && !isTournamentLobby()
  const focusedTextInputField = (): EditableConfigField | null => {
    if (typeof document === 'undefined') return null
    const activeElement = document.activeElement
    if (!(activeElement instanceof HTMLInputElement)) return null
    const ariaLabel = activeElement.getAttribute('aria-label')
    if (ariaLabel === 'Ban Timer (minutes)') return 'ban'
    if (ariaLabel === 'Pick Timer (minutes)') return 'pick'
    if (ariaLabel === poolInputLabel()) return 'leaderPool'
    return null
  }

  createEffect(() => {
    const config = optimisticTimerConfig.value()
    const activeField = editingField() ?? focusedTextInputField()
    if (activeField !== 'ban') setBanMinutes(timerSecondsToMinutesInput(config.banTimerSeconds))
    if (activeField !== 'pick') setPickMinutes(timerSecondsToMinutesInput(config.pickTimerSeconds))
    if (activeField !== 'leaderPool') setLeaderPoolInput(leaderPoolSizeToInput(isCivBlitzLobbyMode() ? config.civBlitzOptionCount : isRedDeathLobbyMode() ? config.dealOptionsSize : config.leaderPoolSize))
  })
  createEffect(() => {
    if (optimisticTimerConfig.status() === 'error') input.showErrorMessage(optimisticTimerConfig.error() ?? 'Failed to save changes.')
  })
  createEffect(() => {
    const override = closedOverride()
    if (override == null) return
    if (draftConfig().closed === override) setClosedOverride(null)
  })
  const enqueueConfigPersist = (persist: () => Promise<void>) => {
    const queued = configPersistQueue.catch(() => {}).then(persist)
    configPersistQueue = queued.catch(() => {})
    return queued
  }
  const handleEditingFieldFocus = (field: EditableConfigField) => {
    editingFocusVersion += 1
    setEditingField(field)
  }

  const commitDraftConfig = async (nextConfig: LobbyEditableDraftConfig, options: { preserveConfigMessage?: boolean, targetSize?: number } = {}) => {
    const currentUserId = userId()
    if (!currentUserId) {
      optimisticTimerConfig.clearError()
      input.showErrorMessage('Could not identify your Discord user. Reopen the activity.')
      return false
    }
    if (!options.preserveConfigMessage) input.clearConfigMessage()
    const committed = await optimisticTimerConfig.commit(nextConfig, () => enqueueConfigPersist(async () => {
      const lobby = input.currentLobby()
      if (lobby) {
        const payload = isTournamentLobby()
          ? {
              banTimerSeconds: nextConfig.banTimerSeconds,
              pickTimerSeconds: nextConfig.pickTimerSeconds,
              leaderDataVersion: nextConfig.leaderDataVersion,
              closed: nextConfig.closed,
            }
          : {
              banTimerSeconds: nextConfig.banTimerSeconds,
              pickTimerSeconds: nextConfig.pickTimerSeconds,
              leaderPoolSize: nextConfig.leaderPoolSize,
              leaderDataVersion: nextConfig.leaderDataVersion,
              mapVoteEnabled: nextConfig.mapVoteEnabled,
              blindBans: nextConfig.blindBans,
              blindPicks: nextConfig.blindPicks,
              simultaneousPick: nextConfig.simultaneousPick,
              permanentAlly: nextConfig.permanentAlly,
              redDeath: nextConfig.redDeath,
              dealOptionsSize: nextConfig.dealOptionsSize,
              civBlitz: nextConfig.civBlitz,
              civBlitzOptionCount: nextConfig.civBlitzOptionCount,
              civBlitzExcludeBbgExpanded: nextConfig.civBlitzExcludeBbgExpanded,
              randomDraft: nextConfig.randomDraft,
              hiddenDraft: nextConfig.hiddenDraft,
              duplicateFactions: nextConfig.duplicateFactions,
              closed: nextConfig.closed,
              targetSize: options.targetSize,
              minRole: nextConfig.civBlitz ? null : lobby.minRole,
              maxRole: nextConfig.civBlitz ? null : lobby.maxRole,
            }
        const result = await updateLobbyConfig(lobby.mode, lobby.id, currentUserId, {
          ...payload,
        })
        if (!result.ok) throw new Error(result.error)
        const savedConfig = buildEditableLobbyDraftConfig(result.lobby)
        if (sameLobbyDraftConfig(optimisticTimerConfig.value(), nextConfig)) setLobbyTimerConfig(savedConfig)
        return
      }
      await sendConfig(nextConfig.banTimerSeconds, nextConfig.pickTimerSeconds)
    }), {
      syncTimeoutMs: input.currentLobby() ? 9000 : 5000,
      syncTimeoutMessage: 'Save not confirmed. Please try again.',
    })
    return committed
  }

  const saveConfigEdits = async () => {
    const activeField = editingField()
    const activeFocusVersion = editingFocusVersion
    try {
      if (!input.amHost()) return true

      const parsedBan = parseTimerMinutesInput(banMinutes())
      const parsedPick = parseTimerMinutesInput(pickMinutes())
      const parsedLeaderPool = isRedDeathLobbyMode() || isCivBlitzLobbyMode() ? parseLeaderPoolSizeInput(leaderPoolInput(), leaderPoolMinimumValue(), leaderPoolMaximumValue()) : parseLeaderPoolSizeInput(leaderPoolInput(), leaderPoolMinimumValue(), leaderPoolMaximumValue())
      const preserveClampMessage = activeField != null && clampedField === activeField
      if (parsedBan === undefined || parsedPick === undefined || parsedLeaderPool === undefined) {
        optimisticTimerConfig.clearError()
        input.showErrorMessage(resolveConfigFieldRangeMessage(activeField, leaderPoolMinimumValue(), leaderPoolMaximumValue(), isRedDeathLobbyMode(), isCivBlitzLobbyMode()))
        const current = optimisticTimerConfig.value()
        setBanMinutes(timerSecondsToMinutesInput(current.banTimerSeconds))
        setPickMinutes(timerSecondsToMinutesInput(current.pickTimerSeconds))
        setLeaderPoolInput(leaderPoolSizeToInput(isCivBlitzLobbyMode() ? current.civBlitzOptionCount : isRedDeathLobbyMode() ? current.dealOptionsSize : current.leaderPoolSize))
        return false
      }

      const current = optimisticTimerConfig.value()
      const banTimerSeconds = parsedBan == null ? null : Math.round(parsedBan * 60)
      const pickTimerSeconds = parsedPick == null ? null : Math.round(parsedPick * 60)
      const leaderPoolSize = isRedDeathLobbyMode() || isCivBlitzLobbyMode() ? current.leaderPoolSize : parsedLeaderPool
      const dealOptionsSize = isRedDeathLobbyMode() ? parsedLeaderPool : current.dealOptionsSize
      const civBlitzOptionCount = isCivBlitzLobbyMode() ? parsedLeaderPool : current.civBlitzOptionCount

      if (banTimerSeconds === current.banTimerSeconds && pickTimerSeconds === current.pickTimerSeconds && leaderPoolSize === current.leaderPoolSize && dealOptionsSize === current.dealOptionsSize && civBlitzOptionCount === current.civBlitzOptionCount) {
        optimisticTimerConfig.clearError()
        return true
      }

      return await commitDraftConfig({
        banTimerSeconds,
        pickTimerSeconds,
        leaderPoolSize,
        leaderDataVersion: current.leaderDataVersion,
        mapVoteEnabled: current.mapVoteEnabled,
        blindBans: current.blindBans,
        blindPicks: current.blindPicks,
        simultaneousPick: current.simultaneousPick,
        permanentAlly: current.permanentAlly,
        redDeath: current.redDeath,
        dealOptionsSize,
        civBlitz: current.civBlitz,
        civBlitzOptionCount,
        civBlitzExcludeBbgExpanded: current.civBlitzExcludeBbgExpanded,
        randomDraft: current.randomDraft,
        hiddenDraft: current.hiddenDraft,
        duplicateFactions: current.duplicateFactions,
        closed: current.closed,
      }, { preserveConfigMessage: preserveClampMessage })
    }
    finally {
      if (activeField != null && clampedField === activeField) clampedField = null
      setEditingField(current => current === activeField && editingFocusVersion === activeFocusVersion ? null : current)
    }
  }
  const saveConfigOnBlur = () => saveConfigEdits()
  const flushPendingConfigEdits = async () => {
    const saved = await saveConfigEdits()
    if (!saved) return false
    await configPersistQueue
    return optimisticTimerConfig.status() !== 'error'
  }

  async function commitToggleConfigChange<T>(nextValue: T, currentValue: T, setPending: (value: boolean) => void, mapConfig: (current: LobbyEditableDraftConfig) => LobbyEditableDraftConfig) {
    if (!input.isLobbyMode() || !input.amHost() || input.lobbyActionPending()) return
    if (nextValue === currentValue) return
    setPending(true)
    try {
      const mapped = mapConfig(optimisticDraftConfig())
      await commitDraftConfig(mapped)
    }
    finally {
      setPending(false)
    }
  }

  const handleLeaderDataVersionChange = async (checked: boolean) => {
    const nextVersion = checked ? 'beta' : 'live'
    await commitToggleConfigChange(nextVersion, optimisticDraftConfig().leaderDataVersion, setLeaderDataVersionPending, current => ({
      ...current,
      leaderDataVersion: nextVersion,
      leaderPoolSize: current.leaderPoolSize == null ? null : Math.min(current.leaderPoolSize, getLeaderPoolSizeMaximum(nextVersion)),
    }))
  }
  const handleMapVoteEnabledChange = async (checked: boolean) => {
    if (!input.isLobbyMode() || isTournamentLobby() || !input.amHost() || input.lobbyActionPending() || mapVoteEnabledPending() || !supportsMapVoteToggle()) return
    await commitToggleConfigChange(checked, optimisticDraftConfig().mapVoteEnabled, setMapVoteEnabledPending, current => ({ ...current, mapVoteEnabled: checked }))
  }
  const handleBlindBansChange = async (checked: boolean) => {
    if (!input.isLobbyMode() || isTournamentLobby() || !input.amHost() || input.lobbyActionPending() || blindBansPending() || !supportsBlindBansToggle()) return
    await commitToggleConfigChange(checked, optimisticDraftConfig().blindBans, setBlindBansPending, current => ({ ...current, blindBans: checked }))
  }
  const handleBlindPicksChange = async (checked: boolean) => {
    if (!input.isLobbyMode() || isTournamentLobby() || !input.amHost() || input.lobbyActionPending() || blindPicksPending() || !supportsBlindPicksToggle()) return
    await commitToggleConfigChange(checked, optimisticDraftConfig().blindPicks, setBlindPicksPending, current => ({ ...current, blindPicks: checked, simultaneousPick: checked ? false : current.simultaneousPick }))
  }
  const handleSimultaneousPickChange = async (checked: boolean) => {
    if (!input.isLobbyMode() || isTournamentLobby() || !input.amHost() || input.lobbyActionPending() || simultaneousPickPending() || input.lobbyMode() !== 'ffa') return
    await commitToggleConfigChange(checked, optimisticDraftConfig().simultaneousPick, setSimultaneousPickPending, current => ({ ...current, simultaneousPick: checked, blindPicks: checked ? false : current.blindPicks }))
  }
  const handlePermanentAllyChange = async (checked: boolean) => {
    if (!input.isLobbyMode() || isTournamentLobby() || !input.amHost() || input.lobbyActionPending() || permanentAllyPending() || input.lobbyMode() !== 'ffa' || optimisticDraftConfig().redDeath) return
    await commitToggleConfigChange(checked, optimisticDraftConfig().permanentAlly, setPermanentAllyPending, current => ({ ...current, permanentAlly: checked }))
  }
  const handleRedDeathChange = async (checked: boolean) => {
    if (!input.isLobbyMode() || isTournamentLobby() || !input.amHost() || input.lobbyActionPending() || redDeathPending()) return
    const lobby = input.currentLobby()
    const current = optimisticDraftConfig()
    if (checked === current.redDeath || (checked && redDeathExtraFfaSeatsOccupied())) return
    setRedDeathPending(true)
    try {
      await commitDraftConfig({
        banTimerSeconds: current.banTimerSeconds,
        pickTimerSeconds: current.pickTimerSeconds,
        leaderPoolSize: checked ? null : current.leaderPoolSize,
        leaderDataVersion: checked ? 'live' : current.leaderDataVersion,
        mapVoteEnabled: checked ? false : current.mapVoteEnabled,
        blindBans: checked ? true : current.blindBans,
        blindPicks: current.blindPicks,
        simultaneousPick: checked ? false : current.simultaneousPick,
        permanentAlly: checked ? false : current.permanentAlly,
        redDeath: checked,
        dealOptionsSize: checked ? current.dealOptionsSize : null,
        civBlitz: checked ? false : current.civBlitz,
        civBlitzOptionCount: current.civBlitzOptionCount,
        civBlitzExcludeBbgExpanded: current.civBlitzExcludeBbgExpanded,
        randomDraft: current.randomDraft,
        hiddenDraft: current.hiddenDraft,
        duplicateFactions: checked && requiresRedDeathDuplicateFactions(input.lobbyMode()) ? true : current.duplicateFactions,
        closed: current.closed,
      }, { targetSize: lobby?.mode === 'ffa' ? (checked ? 10 : (regularFfaExtraSeatsOccupied() ? 12 : 8)) : undefined })
      input.showInfoMessage(checked ? 'Red Death enabled.' : 'Red Death disabled.')
    }
    finally {
      setRedDeathPending(false)
    }
  }
  const handleCivBlitzChange = async (checked: boolean) => {
    if (!input.isLobbyMode() || isTournamentLobby() || !input.amHost() || input.lobbyActionPending() || civBlitzPending()) return
    const current = optimisticDraftConfig()
    if (checked === current.civBlitz) return
    setCivBlitzPending(true)
    try {
      await commitDraftConfig({
        ...current,
        leaderPoolSize: checked ? null : current.leaderPoolSize,
        blindPicks: checked ? false : current.blindPicks,
        simultaneousPick: checked ? false : current.simultaneousPick,
        permanentAlly: checked ? false : current.permanentAlly,
        redDeath: checked ? false : current.redDeath,
        dealOptionsSize: checked ? null : current.dealOptionsSize,
        civBlitz: checked,
        civBlitzOptionCount: current.civBlitzOptionCount ?? CIV_BLITZ_DEFAULT_OPTION_COUNT,
        randomDraft: checked ? false : current.randomDraft,
        hiddenDraft: checked ? false : current.hiddenDraft,
        duplicateFactions: checked ? false : current.duplicateFactions,
      })
      input.showInfoMessage(checked ? 'CivBlitz enabled.' : 'CivBlitz disabled.')
    }
    finally {
      setCivBlitzPending(false)
    }
  }
  const handleCivBlitzExcludeBbgExpandedChange = async (checked: boolean) => {
    if (!input.isLobbyMode() || isTournamentLobby() || !input.amHost() || input.lobbyActionPending() || civBlitzExcludeBbgExpandedPending() || !optimisticDraftConfig().civBlitz) return
    await commitToggleConfigChange(checked, optimisticDraftConfig().civBlitzExcludeBbgExpanded, setCivBlitzExcludeBbgExpandedPending, current => ({ ...current, civBlitzExcludeBbgExpanded: checked }))
  }
  const handleRandomDraftChange = async (checked: boolean) => {
    if (!input.isLobbyMode() || isTournamentLobby() || !input.amHost() || input.lobbyActionPending() || randomDraftPending()) return
    await commitToggleConfigChange(checked, optimisticDraftConfig().randomDraft, setRandomDraftPending, current => ({ ...current, randomDraft: checked, hiddenDraft: checked ? false : current.hiddenDraft, civBlitz: checked ? false : current.civBlitz }))
  }
  const handleHiddenDraftChange = async (checked: boolean) => {
    if (!input.isLobbyMode() || isTournamentLobby() || !input.amHost() || input.lobbyActionPending() || hiddenDraftPending()) return
    await commitToggleConfigChange(checked, optimisticDraftConfig().hiddenDraft, setHiddenDraftPending, current => ({ ...current, hiddenDraft: checked, randomDraft: checked ? false : current.randomDraft, civBlitz: checked ? false : current.civBlitz }))
  }
  const handleDuplicateFactionsChange = async (checked: boolean) => {
    if (!input.isLobbyMode() || isTournamentLobby() || !input.amHost() || input.lobbyActionPending() || duplicateFactionsPending() || duplicateFactionsLocked()) return
    await commitToggleConfigChange(checked, optimisticDraftConfig().duplicateFactions, setDuplicateFactionsPending, current => ({ ...current, duplicateFactions: checked }))
  }
  const handleLobbyOpenChange = async (checked: boolean) => {
    if (!input.isLobbyMode() || !input.amHost() || input.lobbyActionPending() || closedPending()) return false
    const nextClosed = !checked
    const current = optimisticDraftConfig()
    if (nextClosed === (closedOverride() ?? current.closed)) return true
    setClosedPending(true)
    setClosedOverride(nextClosed)
    try {
      const saved = await commitDraftConfig({ ...current, closed: nextClosed })
      if (!saved) setClosedOverride(null)
      return saved
    }
    finally {
      setClosedPending(false)
    }
  }
  const handleLobbyModeChange = async (nextMode: LobbyModeValue) => {
    const lobby = input.currentLobby()
    const currentUserId = userId()
    if (!lobby || isTournamentLobby() || !currentUserId || !input.amHost() || lobby.mode === nextMode || input.lobbyActionPending()) return
    input.setLobbyActionPending(true)
    input.clearConfigMessage()
    try {
      const result = await updateLobbyMode(lobby.mode, lobby.id, currentUserId, nextMode)
      if (!result.ok) return input.showErrorMessage(result.error)
      input.showInfoMessage(`Game mode changed to ${formatModeLabel(nextMode, nextMode, { redDeath: draftConfig().redDeath, civBlitz: draftConfig().civBlitz })}.`)
    }
    finally {
      input.setLobbyActionPending(false)
    }
  }
  const handleLobbyMinRoleChange = async (value: string) => {
    const lobby = input.currentLobby()
    const currentUserId = userId()
    if (!lobby || isTournamentLobby() || !currentUserId || !input.amHost() || input.lobbyActionPending()) return
    const nextBounds = normalizeCompetitiveTierBounds(normalizeLobbyRankRoleValue(value), lobby.maxRole)
    if (lobby.minRole === nextBounds.minimum && lobby.maxRole === nextBounds.maximum) return
    input.setLobbyActionPending(true)
    input.clearConfigMessage()
    try {
      const result = await updateLobbyConfig(lobby.mode, lobby.id, currentUserId, {
        banTimerSeconds: timerConfig().banTimerSeconds,
        pickTimerSeconds: timerConfig().pickTimerSeconds,
        leaderPoolSize: draftConfig().leaderPoolSize,
        minRole: nextBounds.minimum,
        maxRole: nextBounds.maximum,
      })
      if (!result.ok) return input.showErrorMessage(result.error)
      const refreshedOptions = await fetchLobbyRankedRoles(lobby.mode, lobby.id)
      if (refreshedOptions?.options?.length) setRankedRoleOptions(refreshedOptions.options)
      const optionSource = refreshedOptions?.options?.length ? refreshedOptions.options : rankedRoleOptions()
      const selectedMinRole = nextBounds.minimum ? findRankedRoleOptionByTier(optionSource, nextBounds.minimum) : null
      if (nextBounds.swapped) input.showInfoMessage('Min and max ranks swapped to keep the range valid.')
      else if (nextBounds.minimum) input.showRankRoleSetMessage({ boundLabel: 'Min rank', roleLabel: selectedMinRole?.label ?? 'Unranked', roleColor: selectedMinRole?.color ?? null })
      else input.showInfoMessage('Min rank cleared')
    }
    finally {
      input.setLobbyActionPending(false)
    }
  }
  const handleLobbyMaxRoleChange = async (value: string) => {
    const lobby = input.currentLobby()
    const currentUserId = userId()
    if (!lobby || isTournamentLobby() || !currentUserId || !input.amHost() || input.lobbyActionPending()) return
    const nextBounds = normalizeCompetitiveTierBounds(lobby.minRole, normalizeLobbyRankRoleValue(value))
    if (lobby.minRole === nextBounds.minimum && lobby.maxRole === nextBounds.maximum) return
    input.setLobbyActionPending(true)
    input.clearConfigMessage()
    try {
      const result = await updateLobbyConfig(lobby.mode, lobby.id, currentUserId, {
        banTimerSeconds: timerConfig().banTimerSeconds,
        pickTimerSeconds: timerConfig().pickTimerSeconds,
        leaderPoolSize: draftConfig().leaderPoolSize,
        minRole: nextBounds.minimum,
        maxRole: nextBounds.maximum,
      })
      if (!result.ok) return input.showErrorMessage(result.error)
      const refreshedOptions = await fetchLobbyRankedRoles(lobby.mode, lobby.id)
      if (refreshedOptions?.options?.length) setRankedRoleOptions(refreshedOptions.options)
      const optionSource = refreshedOptions?.options?.length ? refreshedOptions.options : rankedRoleOptions()
      const selectedMaxRole = nextBounds.maximum ? findRankedRoleOptionByTier(optionSource, nextBounds.maximum) : null
      if (nextBounds.swapped) input.showInfoMessage('Min and max ranks swapped to keep the range valid.')
      else if (nextBounds.maximum) input.showRankRoleSetMessage({ boundLabel: 'Max rank', roleLabel: selectedMaxRole?.label ?? 'Unranked', roleColor: selectedMaxRole?.color ?? null })
      else input.showInfoMessage('Max rank cleared')
    }
    finally {
      input.setLobbyActionPending(false)
    }
  }
  const handleSaveSteamLink = async (link: string | null) => {
    const lobby = input.currentLobby()
    const currentUserId = userId()
    if (!lobby || !currentUserId || !input.canSaveSteamLobbyLink() || input.lobbyActionPending() || link === lobby.steamLobbyLink) return
    input.setLobbyActionPending(true)
    input.clearConfigMessage()
    try {
      const payload = input.amHost() && !isTournamentLobby()
        ? {
            banTimerSeconds: timerConfig().banTimerSeconds,
            pickTimerSeconds: timerConfig().pickTimerSeconds,
            leaderPoolSize: draftConfig().leaderPoolSize,
            steamLobbyLink: link,
            minRole: lobby.minRole,
            maxRole: lobby.maxRole,
          }
        : { steamLobbyLink: link }
      const result = await updateLobbyConfig(lobby.mode, lobby.id, currentUserId, payload)
      if (!result.ok) return input.showErrorMessage(result.error)
      input.showInfoMessage(link ? 'Steam lobby link updated.' : 'Steam lobby link cleared.')
    }
    finally {
      input.setLobbyActionPending(false)
    }
  }

  const handleClampedField = (field: EditableConfigField) => {
    clampedField = field
    optimisticTimerConfig.clearError()
    input.showErrorMessage(resolveConfigFieldRangeMessage(field, leaderPoolMinimumValue(), leaderPoolMaximumValue(), isRedDeathLobbyMode(), isCivBlitzLobbyMode()))
  }
  const clearConfigInputError = () => {
    optimisticTimerConfig.clearError()
    input.clearConfigMessage()
  }
  const handleLeaderPoolInput = (value: string) => {
    clearConfigInputError()
    setLeaderPoolInput(value)
  }
  const handleBanMinutesInput = (value: string) => {
    clearConfigInputError()
    setBanMinutes(value)
  }
  const handlePickMinutesInput = (value: string) => {
    clearConfigInputError()
    setPickMinutes(value)
  }
  const showConfigSpinner = () => input.props.showJoinPending || optimisticTimerConfig.status() === 'pending' || input.lobbyActionPending() || input.startPending()

  const fields = {
    banMinutes,
    pickMinutes,
    leaderPoolInput,
    minRoleValue: lobbyMinRoleValue,
    maxRoleValue: lobbyMaxRoleValue,
  }

  const pending = {
    leaderDataVersion: leaderDataVersionPending,
    mapVoteEnabled: mapVoteEnabledPending,
    blindBans: blindBansPending,
    blindPicks: blindPicksPending,
    simultaneousPick: simultaneousPickPending,
    permanentAlly: permanentAllyPending,
    redDeath: redDeathPending,
    civBlitz: civBlitzPending,
    civBlitzExcludeBbgExpanded: civBlitzExcludeBbgExpandedPending,
    randomDraft: randomDraftPending,
    hiddenDraft: hiddenDraftPending,
    duplicateFactions: duplicateFactionsPending,
    closed: closedPending,
    spinner: showConfigSpinner,
  }

  const derived = {
    timerConfig,
    draftConfig,
    optimisticDraftConfig,
    optimisticLobbyClosed: () => closedOverride() ?? optimisticDraftConfig().closed,
    isRedDeath: isRedDeathLobbyMode,
    isCivBlitz: isCivBlitzLobbyMode,
    isTournamentLobby,
    isUnranked: isUnrankedLobbyMode,
    canStartLobby,
    canToggleRedDeath,
    supportsMapVote: supportsMapVoteToggle,
    supportsBlindBans: supportsBlindBansToggle,
    supportsBlindPicks: supportsBlindPicksToggle,
    leaderPoolMinimum: leaderPoolMinimumValue,
    leaderPoolMaximum: leaderPoolMaximumValue,
    leaderPoolPlaceholder: leaderPoolPlaceholderValue,
    banTimerPlaceholder,
    pickTimerPlaceholder,
    timerInputStep,
    fillTestPlayersAvailable,
    duplicateFactionsLocked,
    draftDuplicateFactions,
    optimisticDuplicateFactions,
    duplicateOptionLabel,
    poolInputLabel,
    modeLabelClass,
    formattedBanTimer,
    formattedBbgVersion,
    formattedBlindBans,
    formattedBlindPicks,
    formattedPermanentAlly,
    formattedDuplicateFactions,
    formattedCivBlitz,
    formattedCivBlitzExcludeBbgExpanded,
    formattedHiddenDraft,
    formattedLeaderPool,
    formattedLobbyMinRole,
    formattedLobbyMaxRole,
    formattedMapVote,
    formattedPickTimer,
    formattedRandomDraft,
    formattedSimultaneousPick,
  }

  const options = {
    rankedRoles: rankedRoleOptions,
    lobbyModes: lobbyModeOptions,
  }

  const actions = {
    setEditingField: handleEditingFieldFocus,
    saveOnBlur: saveConfigOnBlur,
    flushPendingEdits: flushPendingConfigEdits,
    clampField: handleClampedField,
    inputLeaderPool: handleLeaderPoolInput,
    inputBanMinutes: handleBanMinutesInput,
    inputPickMinutes: handlePickMinutesInput,
    changeLeaderDataVersion: handleLeaderDataVersionChange,
    changeMapVoteEnabled: handleMapVoteEnabledChange,
    changeBlindBans: handleBlindBansChange,
    changeBlindPicks: handleBlindPicksChange,
    changeSimultaneousPick: handleSimultaneousPickChange,
    changePermanentAlly: handlePermanentAllyChange,
    changeRedDeath: handleRedDeathChange,
    changeCivBlitz: handleCivBlitzChange,
    changeCivBlitzExcludeBbgExpanded: handleCivBlitzExcludeBbgExpandedChange,
    changeRandomDraft: handleRandomDraftChange,
    changeHiddenDraft: handleHiddenDraftChange,
    changeDuplicateFactions: handleDuplicateFactionsChange,
    changeLobbyOpen: handleLobbyOpenChange,
    changeLobbyMode: handleLobbyModeChange,
    changeMinRole: handleLobbyMinRoleChange,
    changeMaxRole: handleLobbyMaxRoleChange,
    saveSteamLobbyLink: handleSaveSteamLink,
  }

  return {
    fields,
    pending,
    derived,
    options,
    actions,
  }
}

export function buildEditableLobbyDraftConfig(lobby: LobbySnapshot): LobbyEditableDraftConfig {
  return {
    banTimerSeconds: lobby.draftConfig.banTimerSeconds,
    pickTimerSeconds: lobby.draftConfig.pickTimerSeconds,
    leaderPoolSize: lobby.draftConfig.leaderPoolSize,
    leaderDataVersion: lobby.draftConfig.leaderDataVersion,
    mapVoteEnabled: lobby.draftConfig.mapVoteEnabled,
    blindBans: lobby.draftConfig.blindBans,
    blindPicks: lobby.draftConfig.blindPicks,
    simultaneousPick: lobby.draftConfig.simultaneousPick,
    permanentAlly: inferGameMode(lobby.mode) === 'ffa' && !lobby.draftConfig.redDeath ? lobby.draftConfig.permanentAlly !== false : false,
    redDeath: lobby.draftConfig.redDeath,
    dealOptionsSize: lobby.draftConfig.dealOptionsSize,
    civBlitz: lobby.draftConfig.civBlitz,
    civBlitzOptionCount: lobby.draftConfig.civBlitzOptionCount,
    civBlitzExcludeBbgExpanded: lobby.draftConfig.civBlitzExcludeBbgExpanded,
    randomDraft: lobby.draftConfig.randomDraft,
    hiddenDraft: lobby.draftConfig.hiddenDraft,
    duplicateFactions: lobby.draftConfig.duplicateFactions,
    closed: lobby.draftConfig.closed === true,
  }
}

export function resolveConfigFieldRangeMessage(field: EditableConfigField | null, leaderPoolMinimum: number, leaderPoolMaximum: number, isRedDeathLobbyMode: boolean, isCivBlitzLobbyMode = false): string {
  switch (field) {
    case 'ban':
      return `Ban timer can be 0-${MAX_TIMER_MINUTES} minutes, or blank for the server default.`
    case 'pick':
      return `Pick timer can be 0-${MAX_TIMER_MINUTES} minutes, or blank for the server default.`
    case 'leaderPool':
      if (isCivBlitzLobbyMode) return `Options can be ${leaderPoolMinimum}-${leaderPoolMaximum}, or blank for the default.`
      return isRedDeathLobbyMode ? 'Factions can be 2-10, or blank for the default.' : `Leaders can be ${leaderPoolMinimum}-${leaderPoolMaximum}, or blank for the default.`
    default:
      return 'Value is out of range.'
  }
}
