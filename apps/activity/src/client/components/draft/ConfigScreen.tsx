import type { LobbySnapshot } from '~/client/stores'
import { createEffect, createSignal, For, Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import { createOptimisticState } from '~/client/lib/optimistic-state'
import {
  cancelLobby,
  draftStore,
  isSpectator,
  sendCancel,
  sendConfig,
  sendStart,
  updateLobbyDraftConfig,
  userId,
} from '~/client/stores'

const MAX_TIMER_MINUTES = 30

interface ConfigScreenProps {
  lobby?: LobbySnapshot
}

interface PlayerRow {
  key: string
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
  const [banMinutes, setBanMinutes] = createSignal('')
  const [pickMinutes, setPickMinutes] = createSignal('')
  const [editingField, setEditingField] = createSignal<'ban' | 'pick' | null>(null)
  const [configMessage, setConfigMessage] = createSignal<string | null>(null)
  const [cancelPending, setCancelPending] = createSignal(false)
  const [lobbyTimerConfig, setLobbyTimerConfig] = createSignal<DraftTimerConfig | null>(
    props.lobby
      ? {
          banTimerSeconds: props.lobby.draftConfig.banTimerSeconds,
          pickTimerSeconds: props.lobby.draftConfig.pickTimerSeconds,
        }
      : null,
  )

  createEffect(() => {
    if (!props.lobby) {
      setLobbyTimerConfig(null)
      return
    }

    setLobbyTimerConfig({
      banTimerSeconds: props.lobby.draftConfig.banTimerSeconds,
      pickTimerSeconds: props.lobby.draftConfig.pickTimerSeconds,
    })
  })

  const isLobbyMode = () => props.lobby != null
  const hostId = () => props.lobby?.hostId ?? state()?.seats[0]?.playerId ?? null
  const amHost = () => {
    const id = userId()
    if (!id) return false
    return id === hostId()
  }

  const seatCount = () => props.lobby?.targetSize ?? state()?.seats.length ?? 0
  const formatId = () => {
    if (props.lobby) return props.lobby.mode.toUpperCase()
    return state()?.formatId?.replace(/-/g, ' ').toUpperCase() ?? 'DRAFT'
  }
  const isTeamMode = () => {
    if (props.lobby) return props.lobby.mode === 'duel' || props.lobby.mode === '2v2' || props.lobby.mode === '3v3'
    return state()?.seats.some(s => s.team != null) ?? false
  }

  const timerConfig = (): DraftTimerConfig => {
    if (props.lobby) {
      return lobbyTimerConfig() ?? {
        banTimerSeconds: props.lobby.draftConfig.banTimerSeconds,
        pickTimerSeconds: props.lobby.draftConfig.pickTimerSeconds,
      }
    }
    return getTimerConfigFromDraft(state())
  }

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

  const teamRows = (team: 0 | 1): PlayerRow[] => {
    if (props.lobby) {
      const size = Math.max(1, Math.floor(props.lobby.targetSize / 2))
      const start = team === 0 ? 0 : size
      return Array.from({ length: size }, (_, i) => {
        const entry = props.lobby?.entries[start + i]
        return {
          key: `lobby-${team}-${i}`,
          name: entry?.displayName ?? '[empty]',
          playerId: entry?.playerId ?? null,
          avatarUrl: entry?.avatarUrl ?? null,
          isHost: entry?.playerId === hostId(),
          empty: !entry,
        }
      })
    }

    const seats = state()?.seats.filter(seat => seat.team === team) ?? []
    return seats.map(seat => ({
      key: `room-${team}-${seat.playerId}`,
      name: seat.displayName,
      playerId: seat.playerId,
      avatarUrl: seat.avatarUrl ?? null,
      isHost: seat.playerId === hostId(),
      empty: false,
    }))
  }

  const ffaRows = (): PlayerRow[] => {
    if (props.lobby) {
      return Array.from({ length: props.lobby.targetSize }, (_, i) => {
        const entry = props.lobby?.entries[i]
        return {
          key: `lobby-ffa-${i}`,
          name: entry?.displayName ?? '[empty]',
          playerId: entry?.playerId ?? null,
          avatarUrl: entry?.avatarUrl ?? null,
          isHost: entry?.playerId === hostId(),
          empty: !entry,
        }
      })
    }

    return (state()?.seats ?? []).map((seat) => {
      return {
        key: `room-ffa-${seat.playerId}`,
        name: seat.displayName,
        playerId: seat.playerId,
        avatarUrl: seat.avatarUrl ?? null,
        isHost: seat.playerId === hostId(),
        empty: false,
      }
    })
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
      await optimisticTimerConfig.commit({
        banTimerSeconds,
        pickTimerSeconds,
      }, async () => {
        if (props.lobby) {
          const result = await updateLobbyDraftConfig(props.lobby.mode, currentUserId, {
            banTimerSeconds,
            pickTimerSeconds,
          })
          if (!result.ok) throw new Error(result.error)

          setLobbyTimerConfig({
            banTimerSeconds: result.lobby.draftConfig.banTimerSeconds,
            pickTimerSeconds: result.lobby.draftConfig.pickTimerSeconds,
          })
          return
        }

        await sendConfig(banTimerSeconds, pickTimerSeconds)
      }, {
        syncTimeoutMs: props.lobby ? 9000 : 5000,
        syncTimeoutMessage: 'Save not confirmed. Please try again.',
      })
    }
    finally {
      setEditingField(null)
    }
  }

  const handleCancelAction = async () => {
    if (cancelPending()) return

    if (props.lobby) {
      const currentUserId = userId()
      if (!currentUserId) {
        setConfigMessage('Could not identify your Discord user. Reopen the activity.')
        return
      }

      setCancelPending(true)
      setConfigMessage(null)
      try {
        const result = await cancelLobby(props.lobby.mode, currentUserId)
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
    <div class="text-text-primary font-sans bg-bg-primary flex flex-col h-screen items-center justify-center">
      <div class="px-6 flex flex-col gap-6 max-w-5xl w-full">
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
                      {row => <PlayerChip name={row.name} avatarUrl={row.avatarUrl} isHost={row.isHost} empty={row.empty} />}
                    </For>
                  </div>
                  <div class="flex flex-col gap-2">
                    <For each={ffaSecondColumn()}>
                      {row => <PlayerChip name={row.name} avatarUrl={row.avatarUrl} isHost={row.isHost} empty={row.empty} />}
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
                      {row => <PlayerChip name={row.name} avatarUrl={row.avatarUrl} isHost={row.isHost} empty={row.empty} />}
                    </For>
                  </div>
                </div>
                <div>
                  <div class="text-xs text-accent-gold tracking-wider font-bold mb-2">Team B</div>
                  <div class="flex flex-col gap-2">
                    <For each={teamRows(1)}>
                      {row => <PlayerChip name={row.name} avatarUrl={row.avatarUrl} isHost={row.isHost} empty={row.empty} />}
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
                <Show when={optimisticTimerConfig.status() === 'pending'}>
                  <span class="i-gg:spinner text-sm text-accent-gold animate-spin" />
                </Show>
              </span>
            </div>

            <div class="text-sm gap-2 grid grid-cols-2">
              <div class="text-text-secondary">Players</div>
              <div class="text-text-primary font-medium text-right">{seatCount()}</div>
              <div class="text-text-secondary">Mode</div>
              <div class="text-text-primary font-medium text-right">{isTeamMode() ? 'Teams' : 'FFA'}</div>
              <Show when={!props.lobby}>
                <div class="text-text-secondary">Steps</div>
                <div class="text-text-primary font-medium text-right">{state()?.steps.length ?? 0}</div>
              </Show>
            </div>

            <Show
              when={amHost()}
              fallback={(
                <div class="flex flex-col gap-2">
                  <ReadonlyTimerRow label="Ban timer" value={formatTimerValue(timerConfig().banTimerSeconds)} />
                  <ReadonlyTimerRow label="Pick timer" value={formatTimerValue(timerConfig().pickTimerSeconds)} />
                </div>
              )}
            >
              <div class="flex flex-col gap-2">
                <label class="text-xs text-text-muted tracking-wider font-bold uppercase">Ban Timer (minutes)</label>
                <input
                  type="number"
                  min="0"
                  max={String(MAX_TIMER_MINUTES)}
                  step="1"
                  value={banMinutes()}
                  placeholder="default"
                  onFocus={() => setEditingField('ban')}
                  onInput={(event) => {
                    optimisticTimerConfig.clearError()
                    setConfigMessage(null)
                    setBanMinutes(normalizeTimerMinutesInput(event.currentTarget.value))
                  }}
                  onBlur={saveConfigOnBlur}
                  class="text-sm text-text-primary px-3 py-2 outline-none border border-white/10 rounded-md bg-bg-primary focus:border-accent-gold/60"
                />

                <label class="text-xs text-text-muted tracking-wider font-bold uppercase">Pick Timer (minutes)</label>
                <input
                  type="number"
                  min="0"
                  max={String(MAX_TIMER_MINUTES)}
                  step="1"
                  value={pickMinutes()}
                  placeholder="default"
                  onFocus={() => setEditingField('pick')}
                  onInput={(event) => {
                    optimisticTimerConfig.clearError()
                    setConfigMessage(null)
                    setPickMinutes(normalizeTimerMinutesInput(event.currentTarget.value))
                  }}
                  onBlur={saveConfigOnBlur}
                  class="text-sm text-text-primary px-3 py-2 outline-none border border-white/10 rounded-md bg-bg-primary focus:border-accent-gold/60"
                />
              </div>
            </Show>

            <div class="min-h-5">
              <Show when={configMessage()}>
                <div class="text-xs text-text-primary flex gap-1.5 items-center">
                  <span class="i-ph-x-bold text-sm text-accent-red" />
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
                {isSpectator() ? 'Spectating — waiting for host to start' : 'Waiting for host to start...'}
              </span>
            )}
          >
            <Show
              when={!isLobbyMode()}
              fallback={(
                <div class="flex items-center gap-3">
                  <span class="text-sm text-text-muted">Draft room opens once all slots are filled.</span>
                  <button
                    class="text-sm text-text-secondary px-6 py-2.5 rounded-lg border border-white/12 bg-white/3 cursor-pointer transition-colors hover:border-white/20 hover:bg-white/6 hover:text-text-primary disabled:opacity-60 disabled:cursor-not-allowed"
                    disabled={cancelPending()}
                    onClick={handleCancelAction}
                  >
                    {cancelPending() ? 'Cancelling...' : 'Cancel Lobby'}
                  </button>
                </div>
              )}
            >
              <div class="flex items-center gap-3">
                <button
                  class="text-sm text-black font-bold px-8 py-2.5 rounded-lg bg-accent-gold cursor-pointer transition-colors hover:bg-accent-gold/80"
                  onClick={sendStart}
                >
                  Start Draft
                </button>
                <button
                  class="text-sm text-text-secondary px-6 py-2.5 rounded-lg border border-white/12 bg-white/3 cursor-pointer transition-colors hover:border-white/20 hover:bg-white/6 hover:text-text-primary"
                  onClick={handleCancelAction}
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

function PlayerChip(props: { name: string, avatarUrl: string | null, isHost: boolean, empty: boolean }) {
  return (
    <div
      class={cn(
        'flex items-center gap-2 rounded-md px-3 py-2',
        props.empty ? 'bg-bg-primary/20 text-text-muted' : 'bg-bg-primary/40',
      )}
    >
      <Show
        when={!props.empty && props.avatarUrl}
        fallback={<div class="i-ph-user-bold text-sm text-text-muted" />}
      >
        {avatar => (
          <img
            src={avatar()}
            alt={props.name}
            class="h-4 w-4 rounded-full object-cover"
          />
        )}
      </Show>
      <span class="text-sm flex-1 truncate">{props.name}</span>
      <Show when={props.isHost}>
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

function formatTimerValue(timerSeconds: number | null): string {
  if (timerSeconds == null) return 'Default'
  if (timerSeconds === 0) return 'Unlimited'
  const minutes = Math.round(timerSeconds / 60)
  if (minutes === 1) return '1 minute'
  return `${minutes} minutes`
}
