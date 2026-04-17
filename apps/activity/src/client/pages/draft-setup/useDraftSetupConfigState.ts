import type { Accessor, Setter } from 'solid-js'
import type { LobbySnapshot, RankedRoleOptionSnapshot } from '~/client/stores'
import type { DraftSetupPageProps, EditableConfigField, LobbyEditableDraftConfig } from './types'
import type { DraftTimerConfig, LobbyModeValue, RankRoleSetDetail } from './helpers'
import { canStartWithPlayerCount, formatModeLabel, GAME_MODE_CHOICES, inferGameMode, isUnrankedMode, maxPlayerCount, normalizeAvailableLeaderDataVersion, normalizeCompetitiveTierBounds, requiresRedDeathDuplicateFactions } from '@civup/game'
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
  getLeaderPoolSizeMinimum,
  getTimerConfigFromDraft,
  leaderPoolSizePlaceholder,
  leaderPoolSizeToInput,
  MAX_LEADER_POOL_INPUT,
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
    && a.blindBans === b.blindBans
    && a.simultaneousPick === b.simultaneousPick
    && a.redDeath === b.redDeath
    && a.dealOptionsSize === b.dealOptionsSize
    && a.randomDraft === b.randomDraft
    && a.duplicateFactions === b.duplicateFactions
}

export function useDraftSetupConfigState(input: {
  props: DraftSetupPageProps
  currentLobby: Accessor<LobbySnapshot | null>
  amHost: Accessor<boolean>
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
  const [blindBansPending, setBlindBansPending] = createSignal(false)
  const [simultaneousPickPending, setSimultaneousPickPending] = createSignal(false)
  const [redDeathPending, setRedDeathPending] = createSignal(false)
  const [randomDraftPending, setRandomDraftPending] = createSignal(false)
  const [duplicateFactionsPending, setDuplicateFactionsPending] = createSignal(false)
  const [lobbyTimerConfig, setLobbyTimerConfig] = createSignal<LobbyEditableDraftConfig | null>(input.props.lobby ? buildEditableLobbyDraftConfig(input.props.lobby) : null)
  const [rankedRoleOptions, setRankedRoleOptions] = createSignal<RankedRoleOptionSnapshot[]>(input.props.prefetchedRankedRoleOptions ?? [])
  const [fillTestPlayersAvailable, setFillTestPlayersAvailable] = createSignal(input.props.prefetchedFillTestPlayersAvailable ?? false)
  let fillTestPlayersAvailabilityKey: string | null = null
  let rankedRoleOptionsFetchKey: string | null = null
  let clampedField: EditableConfigField | null = null

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
      blindBans: true,
      simultaneousPick: state()?.formatId === 'default-ffa-simultaneous',
      redDeath: isRedDeathDraft(),
      dealOptionsSize: null,
      randomDraft: false,
      duplicateFactions: false,
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
  const leaderPoolMinimumValue = () => getLeaderPoolSizeMinimum(input.lobbyMode(), leaderPoolValidationCount())
  const isRedDeathLobbyMode = () => input.currentLobby() ? optimisticDraftConfig().redDeath : isRedDeathDraft()
  const leaderPoolPlaceholderValue = () => isRedDeathLobbyMode()
    ? String(draftConfig().dealOptionsSize ?? 2)
    : leaderPoolSizePlaceholder(input.lobbyMode(), leaderPoolPlayerCount(), input.currentLobby()?.targetSize)
  const currentDraftLeaderPoolSize = () => {
    const draftState = state()
    if (!draftState) return null
    return new Set([...draftState.availableCivIds, ...draftState.bans.map(selection => selection.civId), ...draftState.picks.map(selection => selection.civId)]).size
  }
  const formattedLeaderPool = () => {
    if (isRedDeathLobbyMode()) return String(draftConfig().dealOptionsSize ?? 2)
    const lobby = input.currentLobby()
    if (lobby) return formatLeaderPoolValue(draftConfig().leaderPoolSize, inferGameMode(lobby.mode), leaderPoolPlayerCount(), lobby.targetSize)
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
  const formattedBbgVersion = () => normalizeAvailableLeaderDataVersion(draftConfig().leaderDataVersion) === 'beta' ? 'Beta' : 'Live'
  const formattedBlindBans = () => draftConfig().blindBans ? 'On' : 'Off'
  const formattedSimultaneousPick = () => draftConfig().simultaneousPick ? 'On' : 'Off'
  const formattedRandomDraft = () => draftConfig().randomDraft ? 'On' : 'Off'
  const duplicateFactionsLocked = () => isRedDeathLobbyMode() && requiresRedDeathDuplicateFactions(input.lobbyMode())
  const draftDuplicateFactions = () => duplicateFactionsLocked() ? true : draftConfig().duplicateFactions
  const optimisticDuplicateFactions = () => duplicateFactionsLocked() ? true : optimisticDraftConfig().duplicateFactions
  const duplicateOptionLabel = () => isRedDeathLobbyMode() ? 'Duplicate factions' : 'Duplicate leaders'
  const formattedDuplicateFactions = () => draftDuplicateFactions() ? 'On' : 'Off'
  const poolInputLabel = () => isRedDeathLobbyMode() ? 'Factions' : 'Leaders'
  const modeLabelClass = () => isRedDeathLobbyMode() ? 'text-[#f97316]' : 'text-accent'
  const formattedBanTimer = () => formatTimerValue(timerConfig().banTimerSeconds, serverDefaultTimerConfig().banTimerSeconds)
  const formattedPickTimer = () => formatTimerValue(timerConfig().pickTimerSeconds, serverDefaultTimerConfig().pickTimerSeconds)
  const isUnrankedLobbyMode = () => isUnrankedMode(input.lobbyMode())
  const canStartLobby = () => {
    const lobby = input.currentLobby()
    if (!lobby) return false
    return canStartWithPlayerCount(inferGameMode(lobby.mode), input.filledSlots(), lobby.targetSize, { redDeath: optimisticDraftConfig().redDeath })
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
    return Boolean(lobby && lobby.mode === 'ffa' && optimisticDraftConfig().redDeath && (lobby.entries.slice(8) ?? []).some(entry => entry != null))
  }
  const canToggleRedDeath = () => !redDeathExtraFfaSeatsOccupied()
  const supportsBlindBansToggle = () => input.isLobbyMode() && supportsBlindBansControl(input.lobbyMode(), { redDeath: isRedDeathLobbyMode(), targetSize: input.currentLobby()?.targetSize })

  createEffect(() => {
    const config = optimisticTimerConfig.value()
    if (editingField() !== 'ban') setBanMinutes(timerSecondsToMinutesInput(config.banTimerSeconds))
    if (editingField() !== 'pick') setPickMinutes(timerSecondsToMinutesInput(config.pickTimerSeconds))
    if (editingField() !== 'leaderPool') setLeaderPoolInput(leaderPoolSizeToInput(isRedDeathLobbyMode() ? config.dealOptionsSize : config.leaderPoolSize))
  })
  createEffect(() => {
    if (optimisticTimerConfig.status() === 'error') input.showErrorMessage(optimisticTimerConfig.error() ?? 'Failed to save changes.')
  })

  const commitDraftConfig = async (nextConfig: LobbyEditableDraftConfig, options: { preserveConfigMessage?: boolean, targetSize?: number } = {}) => {
    const currentUserId = userId()
    if (!currentUserId) {
      optimisticTimerConfig.clearError()
      input.showErrorMessage('Could not identify your Discord user. Reopen the activity.')
      return false
    }
    if (!options.preserveConfigMessage) input.clearConfigMessage()
    await optimisticTimerConfig.commit(nextConfig, async () => {
      const lobby = input.currentLobby()
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
      syncTimeoutMs: input.currentLobby() ? 9000 : 5000,
      syncTimeoutMessage: 'Save not confirmed. Please try again.',
    })
    return true
  }

  const saveConfigOnBlur = async () => {
    const activeField = editingField()
    try {
      if (!input.amHost()) return

      const parsedBan = parseTimerMinutesInput(banMinutes())
      const parsedPick = parseTimerMinutesInput(pickMinutes())
      const parsedLeaderPool = isRedDeathLobbyMode() ? parseLeaderPoolSizeInput(leaderPoolInput(), 2, 10) : parseLeaderPoolSizeInput(leaderPoolInput(), leaderPoolMinimumValue())
      const preserveClampMessage = activeField != null && clampedField === activeField
      if (parsedBan === undefined || parsedPick === undefined || parsedLeaderPool === undefined) {
        optimisticTimerConfig.clearError()
        input.showErrorMessage(resolveConfigFieldRangeMessage(activeField, leaderPoolMinimumValue(), isRedDeathLobbyMode()))
        const current = optimisticTimerConfig.value()
        setBanMinutes(timerSecondsToMinutesInput(current.banTimerSeconds))
        setPickMinutes(timerSecondsToMinutesInput(current.pickTimerSeconds))
        setLeaderPoolInput(leaderPoolSizeToInput(isRedDeathLobbyMode() ? current.dealOptionsSize : current.leaderPoolSize))
        return
      }

      const current = optimisticTimerConfig.value()
      const banTimerSeconds = parsedBan == null ? null : Math.round(parsedBan * 60)
      const pickTimerSeconds = parsedPick == null ? null : Math.round(parsedPick * 60)
      const leaderPoolSize = isRedDeathLobbyMode() ? current.leaderPoolSize : parsedLeaderPool
      const dealOptionsSize = isRedDeathLobbyMode() ? parsedLeaderPool : current.dealOptionsSize

      if (banTimerSeconds === current.banTimerSeconds && pickTimerSeconds === current.pickTimerSeconds && leaderPoolSize === current.leaderPoolSize && dealOptionsSize === current.dealOptionsSize) {
        optimisticTimerConfig.clearError()
        return
      }

      await commitDraftConfig({
        banTimerSeconds,
        pickTimerSeconds,
        leaderPoolSize,
        leaderDataVersion: current.leaderDataVersion,
        blindBans: current.blindBans,
        simultaneousPick: current.simultaneousPick,
        redDeath: current.redDeath,
        dealOptionsSize,
        randomDraft: current.randomDraft,
        duplicateFactions: current.duplicateFactions,
      }, { preserveConfigMessage: preserveClampMessage })
    }
    finally {
      if (activeField != null && clampedField === activeField) clampedField = null
      setEditingField(current => current === activeField ? null : current)
    }
  }

  async function commitToggleConfigChange<T>(nextValue: T, currentValue: T, setPending: (value: boolean) => void, mapConfig: (current: LobbyEditableDraftConfig) => LobbyEditableDraftConfig) {
    if (!input.isLobbyMode() || !input.amHost() || input.lobbyActionPending()) return
    if (nextValue === currentValue) return
    setPending(true)
    try {
      await commitDraftConfig(mapConfig(optimisticDraftConfig()))
    }
    finally {
      setPending(false)
    }
  }

  const handleLeaderDataVersionChange = async (checked: boolean) => commitToggleConfigChange(checked ? 'beta' : 'live', optimisticDraftConfig().leaderDataVersion, setLeaderDataVersionPending, current => ({ ...current, leaderDataVersion: checked ? 'beta' : 'live' }))
  const handleBlindBansChange = async (checked: boolean) => {
    if (!input.isLobbyMode() || !input.amHost() || input.lobbyActionPending() || blindBansPending() || !supportsBlindBansToggle()) return
    await commitToggleConfigChange(checked, optimisticDraftConfig().blindBans, setBlindBansPending, current => ({ ...current, blindBans: checked }))
  }
  const handleSimultaneousPickChange = async (checked: boolean) => {
    if (!input.isLobbyMode() || !input.amHost() || input.lobbyActionPending() || simultaneousPickPending() || input.lobbyMode() !== 'ffa') return
    await commitToggleConfigChange(checked, optimisticDraftConfig().simultaneousPick, setSimultaneousPickPending, current => ({ ...current, simultaneousPick: checked }))
  }
  const handleRedDeathChange = async (checked: boolean) => {
    if (!input.isLobbyMode() || !input.amHost() || input.lobbyActionPending() || redDeathPending()) return
    const lobby = input.currentLobby()
    const current = optimisticDraftConfig()
    if (checked === current.redDeath || (!checked && redDeathExtraFfaSeatsOccupied())) return
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
        duplicateFactions: checked && requiresRedDeathDuplicateFactions(input.lobbyMode()) ? true : current.duplicateFactions,
      }, { targetSize: lobby?.mode === 'ffa' ? (checked ? 10 : 8) : undefined })
      input.showInfoMessage(checked ? 'Red Death enabled.' : 'Red Death disabled.')
    }
    finally {
      setRedDeathPending(false)
    }
  }
  const handleRandomDraftChange = async (checked: boolean) => {
    if (!input.isLobbyMode() || !input.amHost() || input.lobbyActionPending() || randomDraftPending()) return
    await commitToggleConfigChange(checked, optimisticDraftConfig().randomDraft, setRandomDraftPending, current => ({ ...current, randomDraft: checked }))
  }
  const handleDuplicateFactionsChange = async (checked: boolean) => {
    if (!input.isLobbyMode() || !input.amHost() || input.lobbyActionPending() || duplicateFactionsPending() || duplicateFactionsLocked()) return
    await commitToggleConfigChange(checked, optimisticDraftConfig().duplicateFactions, setDuplicateFactionsPending, current => ({ ...current, duplicateFactions: checked }))
  }
  const handleLobbyModeChange = async (nextMode: LobbyModeValue) => {
    const lobby = input.currentLobby()
    const currentUserId = userId()
    if (!lobby || !currentUserId || !input.amHost() || lobby.mode === nextMode || input.lobbyActionPending()) return
    input.setLobbyActionPending(true)
    input.clearConfigMessage()
    try {
      const result = await updateLobbyMode(lobby.mode, lobby.id, currentUserId, nextMode)
      if (!result.ok) return input.showErrorMessage(result.error)
      input.showInfoMessage(`Game mode changed to ${formatModeLabel(nextMode, nextMode, { redDeath: draftConfig().redDeath })}.`)
    }
    finally {
      input.setLobbyActionPending(false)
    }
  }
  const handleLobbyMinRoleChange = async (value: string) => {
    const lobby = input.currentLobby()
    const currentUserId = userId()
    if (!lobby || !currentUserId || !input.amHost() || input.lobbyActionPending()) return
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
    if (!lobby || !currentUserId || !input.amHost() || input.lobbyActionPending()) return
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
    if (!lobby || !currentUserId || !input.amHost() || input.lobbyActionPending() || link === lobby.steamLobbyLink) return
    input.setLobbyActionPending(true)
    input.clearConfigMessage()
    try {
      const result = await updateLobbyConfig(lobby.mode, lobby.id, currentUserId, {
        banTimerSeconds: timerConfig().banTimerSeconds,
        pickTimerSeconds: timerConfig().pickTimerSeconds,
        leaderPoolSize: draftConfig().leaderPoolSize,
        steamLobbyLink: link,
        minRole: lobby.minRole,
        maxRole: lobby.maxRole,
      })
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
    input.showErrorMessage(resolveConfigFieldRangeMessage(field, leaderPoolMinimumValue(), isRedDeathLobbyMode()))
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
    blindBans: blindBansPending,
    simultaneousPick: simultaneousPickPending,
    redDeath: redDeathPending,
    randomDraft: randomDraftPending,
    duplicateFactions: duplicateFactionsPending,
    spinner: showConfigSpinner,
  }

  const derived = {
    timerConfig,
    draftConfig,
    optimisticDraftConfig,
    isRedDeath: isRedDeathLobbyMode,
    isUnranked: isUnrankedLobbyMode,
    canStartLobby,
    canToggleRedDeath,
    supportsBlindBans: supportsBlindBansToggle,
    leaderPoolMinimum: leaderPoolMinimumValue,
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
    formattedDuplicateFactions,
    formattedLeaderPool,
    formattedLobbyMinRole,
    formattedLobbyMaxRole,
    formattedPickTimer,
    formattedRandomDraft,
    formattedSimultaneousPick,
  }

  const options = {
    rankedRoles: rankedRoleOptions,
    lobbyModes: lobbyModeOptions,
  }

  const actions = {
    setEditingField,
    saveOnBlur: saveConfigOnBlur,
    clampField: handleClampedField,
    inputLeaderPool: handleLeaderPoolInput,
    inputBanMinutes: handleBanMinutesInput,
    inputPickMinutes: handlePickMinutesInput,
    changeLeaderDataVersion: handleLeaderDataVersionChange,
    changeBlindBans: handleBlindBansChange,
    changeSimultaneousPick: handleSimultaneousPickChange,
    changeRedDeath: handleRedDeathChange,
    changeRandomDraft: handleRandomDraftChange,
    changeDuplicateFactions: handleDuplicateFactionsChange,
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
    blindBans: lobby.draftConfig.blindBans,
    simultaneousPick: lobby.draftConfig.simultaneousPick,
    redDeath: lobby.draftConfig.redDeath,
    dealOptionsSize: lobby.draftConfig.dealOptionsSize,
    randomDraft: lobby.draftConfig.randomDraft,
    duplicateFactions: lobby.draftConfig.duplicateFactions,
  }
}

export function resolveConfigFieldRangeMessage(field: EditableConfigField | null, leaderPoolMinimum: number, isRedDeathLobbyMode: boolean): string {
  switch (field) {
    case 'ban':
      return `Ban timer can be 0-${MAX_TIMER_MINUTES} minutes, or blank for the server default.`
    case 'pick':
      return `Pick timer can be 0-${MAX_TIMER_MINUTES} minutes, or blank for the server default.`
    case 'leaderPool':
      return isRedDeathLobbyMode ? 'Factions can be 2-10, or blank for the default.' : `Leaders can be ${leaderPoolMinimum}-${MAX_LEADER_POOL_INPUT}, or blank for the default.`
    default:
      return 'Value is out of range.'
  }
}
