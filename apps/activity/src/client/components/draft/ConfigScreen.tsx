import type { LobbySnapshot } from '~/client/stores'
import { formatModeLabel } from '@civup/game'
import { createEffect, createSignal, For, Show } from 'solid-js'
import { Dropdown, TextInput } from '~/client/components/ui'
import { cn } from '~/client/lib/css'
import { createOptimisticState } from '~/client/lib/optimistic-state'
import {
  cancelLobby,
  avatarUrl as currentAvatarUrl,
  displayName as currentDisplayName,
  draftStore,
  isSpectator,
  placeLobbySlot,
  removeLobbySlot,
  sendCancel,
  sendConfig,
  sendStart,
  startLobbyDraft,
  updateLobbyDraftConfig,
  updateLobbyMode,
  userId,
} from '~/client/stores'

const MAX_TIMER_MINUTES = 30
const LOBBY_MODES = ['1v1', '2v2', '3v3', 'ffa'] as const
type LobbyModeValue = typeof LOBBY_MODES[number]

interface ConfigScreenProps {
  lobby?: LobbySnapshot
  onLobbyStarted?: (matchId: string) => void
}

interface PlayerRow {
  key: string
  slot: number
  name: string
  playerId: string | null
  avatarUrl: string | null
  isHost: boolean
  empty: boolean
}

interface DraftTimerConfig {
  banTimerSeconds: number | null
  pickTimerSeconds: number | null
}

/** Pre-draft setup screen (lobby waiting + room waiting). */
export function ConfigScreen(props: ConfigScreenProps) {
  const state = () => draftStore.state
  const [lobbyState, setLobbyState] = createSignal<LobbySnapshot | null>(props.lobby ?? null)
  const [banMinutes, setBanMinutes] = createSignal('')
  const [pickMinutes, setPickMinutes] = createSignal('')
  const [editingField, setEditingField] = createSignal<'ban' | 'pick' | null>(null)
  const [configMessage, setConfigMessage] = createSignal<string | null>(null)
  const [cancelPending, setCancelPending] = createSignal(false)
  const [startPending, setStartPending] = createSignal(false)
  const [lobbyActionPending, setLobbyActionPending] = createSignal(false)
  const [draggingPlayerId, setDraggingPlayerId] = createSignal<string | null>(null)
  const [dragOverSlot, setDragOverSlot] = createSignal<number | null>(null)
  const [lobbyTimerConfig, setLobbyTimerConfig] = createSignal<DraftTimerConfig | null>(
    props.lobby
      ? {
          banTimerSeconds: props.lobby.draftConfig.banTimerSeconds,
          pickTimerSeconds: props.lobby.draftConfig.pickTimerSeconds,
        }
      : null,
  )

  createEffect(() => {
    setLobbyState(props.lobby ?? null)
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

  const currentLobby = () => lobbyState()
  const isLobbyMode = () => currentLobby() != null
  const hostId = () => currentLobby()?.hostId ?? draftStore.hostId ?? state()?.seats[0]?.playerId ?? null
  const amHost = () => {
    const id = userId()
    if (!id) return false
    return id === hostId()
  }

  const formatId = () => {
    const lobby = currentLobby()
    if (lobby) return formatModeLabel(lobby.mode, 'DRAFT')
    return formatModeLabel(state()?.formatId, 'DRAFT')
  }
  const isTeamMode = () => {
    const lobby = currentLobby()
    if (lobby) return lobby.mode === '1v1' || lobby.mode === '2v2' || lobby.mode === '3v3'
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

  const banTimerPlaceholder = () => timerSecondsToMinutesPlaceholder(serverDefaultTimerConfig().banTimerSeconds)
  const pickTimerPlaceholder = () => timerSecondsToMinutesPlaceholder(serverDefaultTimerConfig().pickTimerSeconds)

  const optimisticTimerConfig = createOptimisticState(timerConfig, {
    equals: (a, b) => a.banTimerSeconds === b.banTimerSeconds && a.pickTimerSeconds === b.pickTimerSeconds,
  })

  createEffect(() => {
    const config = optimisticTimerConfig.value()
    if (editingField() !== 'ban') setBanMinutes(timerSecondsToMinutesInput(config.banTimerSeconds))
    if (editingField() !== 'pick') setPickMinutes(timerSecondsToMinutesInput(config.pickTimerSeconds))
  })

  createEffect(() => {
    const status = optimisticTimerConfig.status()
    if (status === 'error') {
      setConfigMessage(optimisticTimerConfig.error() ?? 'Failed to save changes.')
    }
  })

  const applyLobbySnapshot = (lobby: LobbySnapshot) => {
    setLobbyState(lobby)
    setLobbyTimerConfig({
      banTimerSeconds: lobby.draftConfig.banTimerSeconds,
      pickTimerSeconds: lobby.draftConfig.pickTimerSeconds,
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
    const raw = currentLobby()?.mode
    if (raw) return normalizeLobbyMode(raw)
    return inferModeFromFormatId(state()?.formatId)
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

  const canJoinSlot = (row: PlayerRow) => {
    if (!isLobbyMode()) return false
    if (!row.empty) return false
    if (!userId()) return false
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
    return row.playerId === id
  }

  const canDropOnRow = (row: PlayerRow) => {
    if (!isLobbyMode()) return false
    if (lobbyActionPending()) return false
    const dragged = draggingPlayerId()
    const id = userId()
    if (!dragged || !id) return false
    if (amHost()) return true
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
        setConfigMessage(`Use whole minutes between 0 and ${MAX_TIMER_MINUTES}.`)
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
        setConfigMessage('Could not identify your Discord user. Reopen the activity.')
        return
      }

      setConfigMessage(null)
      await optimisticTimerConfig.commit({ banTimerSeconds, pickTimerSeconds }, async () => {
        const lobby = currentLobby()
        if (lobby) {
          const result = await updateLobbyDraftConfig(lobby.mode, currentUserId, {
            banTimerSeconds,
            pickTimerSeconds,
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
    setConfigMessage(null)
    try {
      const result = await updateLobbyMode(lobby.mode, currentUserId, nextMode)
      if (!result.ok) {
        setConfigMessage(result.error)
        return
      }
      applyLobbySnapshot(result.lobby)
      setConfigMessage(`Lobby mode changed to ${formatModeLabel(result.lobby.mode, result.lobby.mode)}.`)
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

    setLobbyActionPending(true)
    setConfigMessage(null)
    try {
      const result = await placeLobbySlot(lobby.mode, {
        userId: currentUserId,
        targetSlot: slot,
        displayName: currentDisplayName(),
        avatarUrl: currentAvatarUrl(),
      })
      if (!result.ok) {
        setConfigMessage(result.error)
        return
      }
      applyLobbySnapshot(result.lobby)
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
      userId: string
      targetSlot: number
      playerId?: string
      displayName?: string
      avatarUrl?: string | null
    } = {
      userId: currentUserId,
      targetSlot: slot,
      displayName: currentDisplayName(),
      avatarUrl: currentAvatarUrl(),
    }

    if (amHost() && draggedPlayerId !== currentUserId) {
      payload.playerId = draggedPlayerId
    }

    setLobbyActionPending(true)
    setConfigMessage(null)
    try {
      const result = await placeLobbySlot(lobby.mode, payload)
      if (!result.ok) {
        setConfigMessage(result.error)
        return
      }
      applyLobbySnapshot(result.lobby)
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

    setLobbyActionPending(true)
    setConfigMessage(null)
    try {
      const result = await removeLobbySlot(lobby.mode, {
        userId: currentUserId,
        slot,
      })
      if (!result.ok) {
        setConfigMessage(result.error)
        return
      }
      applyLobbySnapshot(result.lobby)
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
    setConfigMessage(null)
    try {
      const result = await startLobbyDraft(lobby.mode, currentUserId)
      if (!result.ok) {
        setConfigMessage(result.error)
        return
      }

      props.onLobbyStarted?.(result.matchId)
      setConfigMessage('Draft room created. Opening draft...')
    }
    finally {
      setStartPending(false)
    }
  }

  const handleCancelAction = async () => {
    if (cancelPending()) return

    const lobby = currentLobby()
    if (lobby) {
      const currentUserId = userId()
      if (!currentUserId) {
        setConfigMessage('Could not identify your Discord user. Reopen the activity.')
        return
      }

      setCancelPending(true)
      setConfigMessage(null)
      try {
        const result = await cancelLobby(lobby.mode, currentUserId)
        if (!result.ok) {
          setConfigMessage(result.error)
          return
        }
        setConfigMessage('Lobby cancelled. Closing...')
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
        <div class="text-center">
          <h1 class="text-2xl text-heading mb-1">Draft Setup</h1>
          <span class="text-sm text-accent-gold font-medium">{formatId()}</span>
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
                  <div class="flex flex-col gap-2">
                    <For each={teamRows(0)}>
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
                <div>
                  <div class="text-xs text-accent-gold tracking-wider font-bold mb-2">Team B</div>
                  <div class="flex flex-col gap-2">
                    <For each={teamRows(1)}>
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
                options={LOBBY_MODES.map(mode => ({ value: mode, label: formatModeLabel(mode, mode) }))}
                onChange={value => void handleLobbyModeChange(normalizeLobbyMode(value))}
              />
            </Show>

            <Show
              when={amHost()}
              fallback={(
                <div class="flex flex-col gap-2">
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
                    setConfigMessage(null)
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
                    setConfigMessage(null)
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
                    'text-sm',
                    configMessage()?.toLowerCase().includes('failed') || configMessage()?.toLowerCase().includes('error')
                      ? 'i-ph-x-bold text-accent-red'
                      : 'i-ph-check-bold text-accent-gold',
                  )}
                  />
                  <span>{configMessage()}</span>
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

interface PlayerChipProps {
  row: PlayerRow
  pending: boolean
  draggable: boolean
  allowDrop: boolean
  dropActive: boolean
  showJoin: boolean
  showRemove: boolean
  onJoin?: () => void
  onRemove?: () => void
  onDragStart?: () => void
  onDragEnd?: () => void
  onDragEnter?: () => void
  onDragLeave?: () => void
  onDrop?: () => void
}

function PlayerChip(props: PlayerChipProps) {
  return (
    <div
      class={cn(
        'group flex items-center gap-2 rounded-md px-3 py-2 border transition-colors',
        props.row.empty ? 'bg-bg-primary/20 text-text-muted border-transparent' : 'bg-bg-primary/40 border-transparent',
        props.row.empty && props.showJoin && !props.pending && 'hover:bg-bg-primary/30 cursor-pointer',
        props.draggable && !props.pending && 'cursor-grab active:cursor-grabbing',
        props.dropActive && 'border-accent-gold/65 border-dashed bg-accent-gold/8',
      )}
      onClick={() => { if (props.showJoin && !props.pending) props.onJoin?.() }}
      draggable={props.draggable && !props.pending}
      onDragStart={(event) => {
        if (!event.dataTransfer) return
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', props.row.playerId ?? '')
        props.onDragStart?.()
      }}
      onDragEnd={() => props.onDragEnd?.()}
      onDragOver={(event) => {
        if (!props.allowDrop) return
        event.preventDefault()
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
        props.onDragEnter?.()
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node)) return
        props.onDragLeave?.()
      }}
      onDrop={(event) => {
        if (!props.allowDrop) return
        event.preventDefault()
        props.onDrop?.()
      }}
    >
      <Show
        when={!props.row.empty && props.row.avatarUrl}
        fallback={<div class="i-ph-user-bold text-sm text-text-muted" />}
      >
        {avatar => (
          <img
            src={avatar()}
            alt={props.row.name}
            draggable={false}
            class="rounded-full h-5 w-5 pointer-events-none object-cover"
          />
        )}
      </Show>

      <span class="text-sm flex-1 truncate">{props.row.name}</span>

      <Show when={props.showJoin && !props.pending}>
        <button
          class="text-text-secondary rounded-sm opacity-0 flex h-5 w-5 transition-opacity items-center justify-center hover:text-text-primary hover:bg-white/8 group-hover:opacity-100"
          onClick={(event) => {
            event.stopPropagation()
            props.onJoin?.()
          }}
        >
          <span class="i-ph-plus-bold text-xs" />
        </button>
      </Show>

      <Show when={props.showRemove && !props.pending}>
        <button
          class="text-text-secondary rounded-sm opacity-0 flex h-5 w-5 transition-opacity items-center justify-center hover:text-accent-red hover:bg-white/8 group-hover:opacity-100"
          onClick={(event) => {
            event.stopPropagation()
            props.onRemove?.()
          }}
        >
          <span class="i-ph-x-bold text-xs" />
        </button>
      </Show>

      <Show when={!props.showJoin && !props.showRemove && props.row.isHost}>
        <span class="text-[10px] text-accent-gold tracking-wider font-bold uppercase">Host</span>
      </Show>
    </div>
  )
}

function ReadonlyTimerRow(props: { label: string, value: string }) {
  return (
    <div class="text-sm px-3 py-2 rounded-md bg-bg-primary/35 flex items-center justify-between">
      <span class="text-text-secondary">{props.label}</span>
      <span class="text-text-primary font-medium">{props.value}</span>
    </div>
  )
}

function getTimerConfigFromDraft(state: typeof draftStore.state): { banTimerSeconds: number | null, pickTimerSeconds: number | null } {
  if (!state) return { banTimerSeconds: null, pickTimerSeconds: null }

  const banTimer = state.steps.find(step => step.action === 'ban')?.timer ?? null
  const pickTimer = state.steps.find(step => step.action === 'pick')?.timer ?? null
  return {
    banTimerSeconds: banTimer,
    pickTimerSeconds: pickTimer,
  }
}

function timerSecondsToMinutesInput(timerSeconds: number | null): string {
  if (timerSeconds == null) return ''
  return String(Math.round(timerSeconds / 60))
}

function timerSecondsToMinutesPlaceholder(timerSeconds: number | null): string {
  if (timerSeconds == null) return ''
  return String(Math.round(timerSeconds / 60))
}

function parseTimerMinutesInput(value: string): number | null | undefined {
  const trimmed = value.trim()
  if (!trimmed) return null

  const numeric = Number(trimmed)
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric)) return undefined
  if (numeric < 0 || numeric > MAX_TIMER_MINUTES) return undefined
  return numeric
}

function normalizeTimerMinutesInput(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''

  const numeric = Number(trimmed)
  if (!Number.isFinite(numeric)) return value

  const bounded = Math.min(MAX_TIMER_MINUTES, Math.max(0, Math.round(numeric)))
  return String(bounded)
}

function formatTimerValue(timerSeconds: number | null, defaultTimerSeconds: number | null = null): string {
  if (timerSeconds == null && defaultTimerSeconds != null) {
    if (defaultTimerSeconds === 0) return 'Unlimited'
    const defaultMinutes = Math.round(defaultTimerSeconds / 60)
    if (defaultMinutes === 1) return '1 minute'
    return `${defaultMinutes} minutes`
  }

  if (timerSeconds == null) return 'Server default'
  if (timerSeconds === 0) return 'Unlimited'
  const minutes = Math.round(timerSeconds / 60)
  if (minutes === 1) return '1 minute'
  return `${minutes} minutes`
}

function normalizeLobbyMode(value: string | undefined): LobbyModeValue {
  if (value === '1v1' || value === '2v2' || value === '3v3' || value === 'ffa') return value
  return 'ffa'
}

function inferModeFromFormatId(value: string | undefined): LobbyModeValue {
  if (!value) return 'ffa'

  const normalized = value.trim().toLowerCase()
  if (normalized === '1v1' || normalized.endsWith('-1v1')) return '1v1'
  if (normalized === '2v2' || normalized.endsWith('-2v2')) return '2v2'
  if (normalized === '3v3' || normalized.endsWith('-3v3')) return '3v3'
  if (normalized === 'ffa' || normalized.endsWith('-ffa')) return 'ffa'
  return 'ffa'
}
