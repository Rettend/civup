import type { CivLobbySettings, CivLobbySettingsCommunityPreset, CivLobbySettingsProfile, GameMode, Leader } from '@civup/game'
import type { useDraftSetupState } from './useDraftSetupState'
import {
  GAME_MODES,
  getLeaders,
  CIV_LOBBY_SETTINGS_MAX_AUTO_BANNED_LEADERS,
  normalizeCivLobbySettingsProfile,
  OFFICIAL_PPL_CIV_LOBBY_SETTINGS_NAME,
  OFFICIAL_PPL_CIV_LOBBY_SETTINGS_PROFILE,
  resolveCivLobbySettings,
} from '@civup/game'
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js'
import { Portal } from 'solid-js/web'
import {
  createGameSettingsPreset,
  deleteGameSettingsPreset,
  fetchGameSettingsPresets,
  updateGameSettingsPreset,
  userId,
} from '~/client/stores'
import { cn } from '~/client/lib/css'
import { cloneGameSettingsProfile, setGameSettingsModeOverrideEnabled, updateGameSettingsForMode } from './gameSettingsState'

type GameSettingsState = ReturnType<typeof useDraftSetupState>['gameSettings']

export function GameSettingsCard(props: { state: GameSettingsState }) {
  const [open, setOpen] = createSignal(false)
  const [browseOpen, setBrowseOpen] = createSignal(false)
  const [selectedMode, setSelectedMode] = createSignal<GameMode>(props.state.mode())
  const [profile, setProfile] = createSignal<CivLobbySettingsProfile>(cloneGameSettingsProfile(props.state.applied().profile))
  const [presets, setPresets] = createSignal<CivLobbySettingsCommunityPreset[]>([])
  const [catalogLoading, setCatalogLoading] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [message, setMessage] = createSignal<string | null>(null)
  const [presetName, setPresetName] = createSignal('')
  let dialogRef: HTMLDivElement | undefined
  let opener: HTMLElement | null = null

  const applied = () => props.state.applied()
  const activeSettings = createMemo(() => resolveCivLobbySettings(profile(), selectedMode()))
  const activeLobbySettings = createMemo(() => resolveCivLobbySettings(applied().profile, props.state.mode()))
  const hasModeOverride = () => profile().modeOverrides[selectedMode()] != null

  const openDialog = () => {
    opener = typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null
    setOpen(true)
    setProfile(cloneGameSettingsProfile(applied().profile))
    setSelectedMode(props.state.mode())
    setPresetName(applied().preset.kind === 'community' ? applied().preset.name : '')
    setBrowseOpen(false)
    setMessage(null)
    queueMicrotask(() => dialogRef?.querySelector<HTMLElement>('button')?.focus())
  }
  const closeDialog = () => {
    setOpen(false)
    setBrowseOpen(false)
    setMessage(null)
    queueMicrotask(() => opener?.focus())
  }

  createEffect(() => {
    if (!open() || typeof document === 'undefined') return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeDialog()
        return
      }
      if (event.key !== 'Tab' || !dialogRef) return
      const focusable = [...dialogRef.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])')]
      if (focusable.length === 0) return
      const first = focusable[0]!
      const last = focusable.at(-1)!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      }
      else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    onCleanup(() => document.removeEventListener('keydown', onKeyDown))
  })

  const updateSettings = (map: (current: CivLobbySettings) => CivLobbySettings) => {
    setMessage(null)
    setProfile(current => updateGameSettingsForMode(current, selectedMode(), map(resolveCivLobbySettings(current, selectedMode()))))
  }

  const browsePresets = async () => {
    setBrowseOpen(true)
    setCatalogLoading(true)
    setMessage(null)
    try {
      setPresets(await fetchGameSettingsPresets())
    }
    catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not load public presets.')
    }
    finally {
      setCatalogLoading(false)
    }
  }

  const applyRequest = async (request: Parameters<GameSettingsState['apply']>[0]) => {
    if (!props.state.canApply() || saving()) return
    setSaving(true)
    setMessage(null)
    try {
      if (await props.state.apply(request)) closeDialog()
      else if (request.source === 'community') {
        try {
          setPresets(await fetchGameSettingsPresets({ force: true }))
          setMessage('That preset changed. The list was refreshed; review it and apply again.')
        }
        catch {
          setMessage('That preset could not be applied. Refresh the preset list and try again.')
        }
      }
      else setMessage('Could not apply game settings. Check the lobby status and try again.')
    }
    finally {
      setSaving(false)
    }
  }

  const applyEditorProfile = async () => {
    try {
      await applyRequest({ source: 'custom', profile: normalizeCivLobbySettingsProfile(profile()) })
    }
    catch (error) {
      setMessage(error instanceof Error ? error.message : 'Game settings are invalid.')
    }
  }

  const copyProfile = (next: CivLobbySettingsProfile, name = '') => {
    setProfile(cloneGameSettingsProfile(next))
    setPresetName(name)
    setSelectedMode(props.state.mode())
    setBrowseOpen(false)
    setMessage('Copied to the local editor. Nothing has been applied yet.')
  }

  const createPreset = async () => {
    if (saving()) return
    setSaving(true)
    setMessage(null)
    try {
      const created = await createGameSettingsPreset(presetName(), normalizeCivLobbySettingsProfile(profile()))
      setPresets(current => [created, ...current.filter(candidate => candidate.id !== created.id)])
      setPresetName(created.name)
      setMessage('Public preset created.')
    }
    catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not create the preset.')
    }
    finally {
      setSaving(false)
    }
  }

  const updatePreset = async (preset: CivLobbySettingsCommunityPreset) => {
    if (saving()) return
    setSaving(true)
    setMessage(null)
    try {
      const updated = await updateGameSettingsPreset(preset.id, preset.revision, {
        profile: normalizeCivLobbySettingsProfile(profile()),
      })
      setPresets(current => current.map(candidate => candidate.id === updated.id ? updated : candidate))
      setMessage('Public preset updated from the editor.')
    }
    catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not update the preset.')
    }
    finally {
      setSaving(false)
    }
  }

  const removePreset = async (preset: CivLobbySettingsCommunityPreset) => {
    if (saving() || !confirm(`Delete “${preset.name}”?`)) return
    setSaving(true)
    setMessage(null)
    try {
      await deleteGameSettingsPreset(preset.id, preset.revision)
      setPresets(current => current.filter(candidate => candidate.id !== preset.id))
      setMessage('Public preset deleted.')
    }
    catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not delete the preset.')
    }
    finally {
      setSaving(false)
    }
  }

  return (
    <>
      <button
        type="button"
        class="mt-3 w-full rounded-lg border border-border-subtle bg-white/4 px-3 py-2.5 text-left transition-colors hover:border-border-hover hover:bg-white/7"
        aria-haspopup="dialog"
        aria-expanded={open()}
        onClick={openDialog}
      >
        <span class="flex items-center gap-2">
          <span class="i-ph:sliders-horizontal-bold text-sm text-accent" aria-hidden />
          <span class="text-xs font-bold tracking-wide">Game settings</span>
          <span class="i-ph:caret-right-bold ml-auto text-xs text-fg-subtle" aria-hidden />
        </span>
        <span class="mt-1 flex items-center justify-between gap-3 text-[11px]">
          <span class="truncate text-fg-muted">{applied().preset.name}</span>
          <span class="shrink-0 text-fg-subtle">{formatSummary(activeLobbySettings())}</span>
        </span>
      </button>

      <Show when={open()}>
        <Portal>
          <div
            class="fixed inset-0 z-70 flex items-center justify-center bg-black/70 p-3 backdrop-blur-sm"
            onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog() }}
          >
            <div
              ref={dialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="game-settings-title"
              class="flex max-h-[min(92dvh,760px)] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-white/12 bg-bg-subtle shadow-2xl"
            >
              <div class="flex shrink-0 items-start gap-3 border-b border-border-subtle px-4 py-3">
                <div class="min-w-0 flex-1">
                  <h2 id="game-settings-title" class="text-sm font-bold">Game settings</h2>
                  <p class="mt-0.5 truncate text-xs text-fg-muted">{applied().preset.name}</p>
                </div>
                <button type="button" class="rounded p-1 text-fg-muted hover:bg-white/8 hover:text-fg" aria-label="Close game settings" onClick={closeDialog}>
                  <span class="i-ph:x-bold" aria-hidden />
                </button>
              </div>

              <div class="min-h-0 flex-1 overflow-y-auto p-4">
                <Show when={!browseOpen()} fallback={(
                  <PresetBrowser
                    presets={presets()}
                    loading={catalogLoading()}
                    saving={saving()}
                    currentUserId={userId()}
                    presetName={presetName()}
                    canApply={props.state.canApply()}
                    onPresetName={setPresetName}
                    onBack={() => { setBrowseOpen(false); setMessage(null) }}
                    onCreate={createPreset}
                    onCopy={copyProfile}
                    onApplyOfficial={() => void applyRequest({ source: 'official' })}
                    onApplyPreset={preset => void applyRequest({ source: 'community', presetId: preset.id, presetRevision: preset.revision })}
                    onUpdate={updatePreset}
                    onDelete={removePreset}
                  />
                )}>
                  <div class="flex flex-wrap items-center gap-2">
                    <label class="text-xs text-fg-muted" for="game-settings-mode">Mode</label>
                    <select
                      id="game-settings-mode"
                      aria-label="Settings mode"
                      class="rounded-md border border-border bg-bg px-2 py-1 text-xs"
                      value={selectedMode()}
                      onChange={event => setSelectedMode(event.currentTarget.value as GameMode)}
                    >
                      <For each={GAME_MODES}>{mode => <option value={mode}>{mode.toUpperCase()}</option>}</For>
                    </select>
                    <label class="ml-auto flex cursor-pointer items-center gap-2 text-xs text-fg-muted">
                      <input
                        type="checkbox"
                        checked={hasModeOverride()}
                        onChange={event => setProfile(current => setGameSettingsModeOverrideEnabled(current, selectedMode(), event.currentTarget.checked))}
                      />
                      Use mode override
                    </label>
                    <Show when={hasModeOverride()}>
                      <button type="button" class="text-xs text-accent hover:underline" onClick={() => setProfile(current => setGameSettingsModeOverrideEnabled(current, selectedMode(), false))}>Reset to base</button>
                    </Show>
                  </div>
                  <p class="mt-2 text-[11px] text-fg-subtle">{hasModeOverride() ? `Editing the ${selectedMode().toUpperCase()} override. Unchanged fields inherit from base.` : 'Editing base settings shared by every mode.'}</p>

                  <SettingsEditor settings={activeSettings()} leaders={getLeaders(props.state.leaderDataVersion())} onChange={updateSettings} />

                  <div class="mt-4 rounded-lg border border-amber-300/20 bg-amber-300/6 p-3 text-[11px] leading-relaxed text-fg-muted">
                    This is a lobby checklist only. It does not configure Civilization VI or MPH automatically. Only automatic leader exclusions affect the draft.
                  </div>
                  <Show when={props.state.locked()}><p class="mt-2 text-xs text-warning">Tournament game settings are locked.</p></Show>
                </Show>
                <Show when={message()}>{text => <p role="status" class="mt-2 text-xs text-fg-muted">{text()}</p>}</Show>
              </div>

              <Show when={!browseOpen()}>
                <div class="flex shrink-0 items-center gap-2 border-t border-border-subtle px-4 py-3">
                  <button type="button" class="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-white/6" onClick={() => void browsePresets()}>Browse presets</button>
                  <div class="ml-auto flex gap-2">
                    <button type="button" class="rounded-md px-3 py-1.5 text-xs text-fg-muted hover:bg-white/6" onClick={closeDialog}>Cancel</button>
                    <Show when={props.state.canApply()}>
                      <button type="button" disabled={saving()} class="rounded-md bg-accent px-3 py-1.5 text-xs font-bold text-black disabled:opacity-50" onClick={() => void applyEditorProfile()}>Apply</button>
                    </Show>
                  </div>
                </div>
              </Show>
            </div>
          </div>
        </Portal>
      </Show>
    </>
  )
}

function SettingsEditor(props: { settings: CivLobbySettings, leaders: Leader[], onChange: (map: (current: CivLobbySettings) => CivLobbySettings) => void }) {
  const set = (patch: Partial<CivLobbySettings>) => props.onChange(current => ({ ...current, ...patch }))
  const setTimer = (key: keyof CivLobbySettings['mphTimer'], value: number) => props.onChange(current => ({ ...current, mphTimer: { ...current.mphTimer, [key]: value } }))
  const setBan = (key: keyof CivLobbySettings['competitiveBans'], value: boolean) => props.onChange(current => ({ ...current, competitiveBans: { ...current.competitiveBans, [key]: value } }))
  return (
    <div class="mt-3 grid gap-3 sm:grid-cols-2">
      <NumberField label="Hut frequency multiplier" value={props.settings.hutFrequencyMultiplier} min={0.25} max={5} step={0.25} onInput={value => set({ hutFrequencyMultiplier: value })} />
      <label class="text-xs text-fg-muted">Ridges
        <select aria-label="Ridges" value={props.settings.ridges} class="mt-1 w-full rounded-md border border-border bg-bg px-2 py-1.5 text-fg" onChange={event => set({ ridges: event.currentTarget.value as CivLobbySettings['ridges'] })}>
          <option value="classic">Classic</option><option value="standard">Standard</option>
        </select>
      </label>
      <CheckField label="Diplomatic victory" checked={props.settings.diplomaticVictory} onChange={value => set({ diplomaticVictory: value })} />
      <CheckField label="Cultural victory" checked={props.settings.culturalVictory} onChange={value => set({ culturalVictory: value })} />
      <div class="rounded-lg border border-border-subtle p-3 sm:col-span-2">
        <div class="mb-2 text-xs font-semibold">MPH / CivLan turn timer</div>
        <div class="grid gap-2 sm:grid-cols-3">
          <NumberField label="Base seconds" value={props.settings.mphTimer.baseSeconds} min={0} max={600} step={1} onInput={value => setTimer('baseSeconds', value)} />
          <NumberField label="Seconds per average city" value={props.settings.mphTimer.secondsPerAverageCity} min={0} max={60} step={0.5} onInput={value => setTimer('secondsPerAverageCity', value)} />
          <NumberField label="Seconds per average unit" value={props.settings.mphTimer.secondsPerAverageUnit} min={0} max={60} step={0.5} onInput={value => setTimer('secondsPerAverageUnit', value)} />
        </div>
        <p class="mt-2 text-[10px] text-fg-subtle">Formula also includes the MPH timeshift.</p>
      </div>
      <div class="rounded-lg border border-border-subtle p-3 sm:col-span-2">
        <div class="mb-2 text-xs font-semibold">Competitive bans</div>
        <div class="grid gap-2 sm:grid-cols-2">
          <CheckField label="Defender of the Faith" checked={props.settings.competitiveBans.defenderOfTheFaith} onChange={value => setBan('defenderOfTheFaith', value)} />
          <CheckField label="God of the Forge" checked={props.settings.competitiveBans.godOfTheForge} onChange={value => setBan('godOfTheForge', value)} />
          <CheckField label="Colosseum" checked={props.settings.competitiveBans.colosseum} onChange={value => setBan('colosseum', value)} />
          <CheckField label="Temple of Artemis" checked={props.settings.competitiveBans.templeOfArtemis} onChange={value => setBan('templeOfArtemis', value)} />
        </div>
      </div>
      <LeaderExclusionsField leaders={props.leaders} leaderIds={props.settings.autoBannedLeaderIds} onChange={autoBannedLeaderIds => set({ autoBannedLeaderIds })} />
    </div>
  )
}

function PresetBrowser(props: {
  presets: CivLobbySettingsCommunityPreset[]
  loading: boolean
  saving: boolean
  currentUserId: string | null
  presetName: string
  canApply: boolean
  onPresetName: (value: string) => void
  onBack: () => void
  onCreate: () => void
  onCopy: (profile: CivLobbySettingsProfile, name?: string) => void
  onApplyOfficial: () => void
  onApplyPreset: (preset: CivLobbySettingsCommunityPreset) => void
  onUpdate: (preset: CivLobbySettingsCommunityPreset) => void
  onDelete: (preset: CivLobbySettingsCommunityPreset) => void
}) {
  return (
    <div>
      <div class="flex items-center gap-2">
        <button type="button" class="rounded p-1 text-fg-muted hover:bg-white/8" aria-label="Back to game settings" onClick={props.onBack}><span class="i-ph:arrow-left-bold" /></button>
        <h3 class="text-sm font-bold">Public presets</h3>
      </div>
      <div class="mt-3 flex gap-2">
        <input aria-label="Public preset name" value={props.presetName} maxLength={40} placeholder="Preset name" class="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1.5 text-xs" onInput={event => props.onPresetName(event.currentTarget.value)} />
        <button type="button" disabled={props.saving} class="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-white/6 disabled:opacity-50" onClick={props.onCreate}>Create from editor</button>
      </div>
      <div class="mt-3 flex flex-col gap-2">
        <PresetRow name={OFFICIAL_PPL_CIV_LOBBY_SETTINGS_NAME} owner="PPL" official canApply={props.canApply} onCopy={() => props.onCopy(OFFICIAL_PPL_CIV_LOBBY_SETTINGS_PROFILE)} onApply={props.onApplyOfficial} />
        <Show when={!props.loading} fallback={<p class="py-4 text-center text-xs text-fg-muted">Loading public presets…</p>}>
          <For each={props.presets} fallback={<p class="py-4 text-center text-xs text-fg-subtle">No community presets yet.</p>}>
            {preset => (
              <PresetRow
                name={preset.name}
                owner={preset.ownerDisplayName ?? 'Community member'}
                canApply={props.canApply}
                own={preset.ownerDiscordUserId === props.currentUserId}
                saving={props.saving}
                onCopy={() => props.onCopy(preset.profile, preset.name)}
                onApply={() => props.onApplyPreset(preset)}
                onUpdate={() => props.onUpdate(preset)}
                onDelete={() => props.onDelete(preset)}
              />
            )}
          </For>
        </Show>
      </div>
      <p class="mt-3 text-[11px] text-fg-subtle">Presets are public and reusable. Applying one copies it into this lobby, so later catalog changes do not alter the lobby.</p>
    </div>
  )
}

function PresetRow(props: { name: string, owner: string, official?: boolean, own?: boolean, canApply: boolean, saving?: boolean, onCopy: () => void, onApply: () => void, onUpdate?: () => void, onDelete?: () => void }) {
  return (
    <div class="rounded-lg border border-border-subtle bg-white/3 p-3">
      <div class="flex items-start gap-2">
        <div class="min-w-0 flex-1"><div class="truncate text-xs font-semibold">{props.name}</div><div class="text-[10px] text-fg-subtle">{props.official ? 'Official' : `By ${props.owner}`}</div></div>
        <button type="button" disabled={props.saving} class="rounded px-2 py-1 text-[11px] text-fg-muted hover:bg-white/7" onClick={props.onCopy}>Copy</button>
        <Show when={props.canApply}><button type="button" disabled={props.saving} class="rounded bg-accent/15 px-2 py-1 text-[11px] font-semibold text-accent hover:bg-accent/25" onClick={props.onApply}>Apply</button></Show>
      </div>
      <Show when={props.own}>
        <div class="mt-2 flex justify-end gap-2 border-t border-border-subtle pt-2">
          <button type="button" disabled={props.saving} class="text-[10px] text-fg-muted hover:text-fg" onClick={props.onUpdate}>Update from editor</button>
          <button type="button" disabled={props.saving} class="text-[10px] text-danger/80 hover:text-danger" onClick={props.onDelete}>Delete</button>
        </div>
      </Show>
    </div>
  )
}

function LeaderExclusionsField(props: { leaders: Leader[], leaderIds: string[], onChange: (leaderIds: string[]) => void }) {
  const [selectedId, setSelectedId] = createSignal('')
  const leaderById = createMemo(() => new Map(props.leaders.map(leader => [leader.id, leader])))
  const availableLeaders = createMemo(() => {
    const excluded = new Set(props.leaderIds)
    return props.leaders.filter(leader => !excluded.has(leader.id))
  })
  const add = () => {
    const id = selectedId()
    if (!id || props.leaderIds.includes(id) || props.leaderIds.length >= CIV_LOBBY_SETTINGS_MAX_AUTO_BANNED_LEADERS) return
    props.onChange([...props.leaderIds, id])
    setSelectedId('')
  }
  return (
    <div class="rounded-lg border border-border-subtle p-3 sm:col-span-2">
      <div class="text-xs font-semibold">Automatic leader exclusions</div>
      <div class="mt-2 flex gap-2">
        <select aria-label="Leader to automatically exclude" value={selectedId()} class="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg" onChange={event => setSelectedId(event.currentTarget.value)}>
          <option value="">Select a leader…</option>
          <For each={availableLeaders()}>{leader => <option value={leader.id}>{leader.name} · {leader.civilization}</option>}</For>
        </select>
        <button type="button" disabled={!selectedId() || props.leaderIds.length >= CIV_LOBBY_SETTINGS_MAX_AUTO_BANNED_LEADERS} class="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-white/6 disabled:opacity-50" onClick={add}>Add</button>
      </div>
      <Show when={props.leaderIds.length > 0} fallback={<p class="mt-2 text-[11px] text-fg-subtle">No leaders are automatically excluded.</p>}>
        <div class="mt-2 flex flex-wrap gap-1.5">
          <For each={props.leaderIds}>{(leaderId) => {
            const label = () => leaderById().get(leaderId)?.name ?? leaderId
            return (
              <span class="inline-flex items-center gap-1 rounded-full border border-border-subtle bg-white/4 px-2 py-1 text-[11px]">
                <span>{label()}</span>
                <button type="button" class="text-fg-subtle hover:text-danger" aria-label={`Remove ${label()} from automatic exclusions`} onClick={() => props.onChange(props.leaderIds.filter(id => id !== leaderId))}>
                  <span class="i-ph:x-bold" aria-hidden />
                </button>
              </span>
            )
          }}</For>
        </div>
      </Show>
      <p class="mt-2 text-[10px] text-fg-subtle">Up to {CIV_LOBBY_SETTINGS_MAX_AUTO_BANNED_LEADERS}; exclusions apply before the draft pool is sampled.</p>
    </div>
  )
}

function NumberField(props: { label: string, value: number, min: number, max: number, step: number, onInput: (value: number) => void }) {
  return <label class="text-xs text-fg-muted">{props.label}<input type="number" aria-label={props.label} value={props.value} min={props.min} max={props.max} step={props.step} class="mt-1 w-full rounded-md border border-border bg-bg px-2 py-1.5 text-fg" onInput={(event) => { const value = Number(event.currentTarget.value); if (Number.isFinite(value)) props.onInput(value) }} /></label>
}

function CheckField(props: { label: string, checked: boolean, onChange: (value: boolean) => void }) {
  return <label class={cn('flex cursor-pointer items-center gap-2 rounded-md border border-border-subtle px-2.5 py-2 text-xs hover:bg-white/4')}><input type="checkbox" checked={props.checked} onChange={event => props.onChange(event.currentTarget.checked)} /><span>{props.label}</span></label>
}

function formatSummary(settings: CivLobbySettings): string {
  return `${settings.hutFrequencyMultiplier}× huts · ${settings.autoBannedLeaderIds.length} excluded`
}
