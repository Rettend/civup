import type { Accessor, JSX } from 'solid-js'
import type { RankRoleSetDetail } from './helpers'
import type { useDraftSetupState } from './useDraftSetupState'
import type { RankedRoleOptionSnapshot } from '~/client/stores'
import { hasBetaLeaderData, inferGameMode, normalizeAvailableLeaderDataVersion } from '@civup/game'
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { Dropdown, Switch, Tabs, TextInput } from '~/client/components/ui'
import { cn } from '~/client/lib/css'
import { buildRankDotStyle, buildRolePillStyle, MAX_TIMER_MINUTES } from './helpers'

type DraftSetupConfigState = ReturnType<typeof useDraftSetupState>['config']
type ConfigRowMode = 'editable' | 'readonly'
interface RoleDropdownOption {
  value: string
  label: string
  disabled?: boolean
  render?: () => JSX.Element
}
interface ConfigRowHelpers {
  buildRoleDropdownOptions: (clearLabel: string) => RoleDropdownOption[]
}
interface ConfigRowDefinition {
  key: string
  when: (state: DraftSetupConfigState) => boolean
  renderEditable?: (state: DraftSetupConfigState, helpers: ConfigRowHelpers) => JSX.Element
  renderReadonly?: (state: DraftSetupConfigState) => JSX.Element
}

const CONFIG_ROWS: ConfigRowDefinition[] = [
  {
    key: 'banMode',
    when: state => state.isLobbyMode() && !state.derived.isTournamentLobby() && !state.derived.isCivBlitz() && state.derived.supportsBlindBans(),
    renderEditable: state => (
      <ModeTabsRow
        label="Ban"
        value={() => state.derived.optimisticDraftConfig().blindBans ? 'blind' : 'draft'}
        disabled={() => state.lobbyActionPending() || state.pending.blindBans()}
        onChange={value => void state.actions.changeBlindBans(value === 'blind')}
      />
    ),
    renderReadonly: state => (
      <ReadonlyTimerRow label="Ban" value={state.derived.formattedBlindBans().toUpperCase()} valueClass="text-accent" />
    ),
  },
  {
    key: 'pickMode',
    when: state => state.isLobbyMode() && !state.derived.isTournamentLobby() && !state.derived.isCivBlitz() && state.derived.supportsBlindPicks(),
    renderEditable: state => (
      <ModeTabsRow
        label="Pick"
        value={() => state.derived.optimisticDraftConfig().blindPicks ? 'blind' : 'draft'}
        disabled={() => state.lobbyActionPending() || state.pending.blindPicks()}
        onChange={value => void state.actions.changeBlindPicks(value === 'blind')}
      />
    ),
    renderReadonly: state => (
      <ReadonlyTimerRow label="Pick" value={state.derived.formattedBlindPicks().toUpperCase()} valueClass="text-accent" />
    ),
  },
  {
    key: 'mapVote',
    when: state => state.isLobbyMode() && !state.derived.isTournamentLobby() && state.derived.supportsMapVote(),
    renderEditable: state => (
      <SwitchRow
        label="Map Vote"
        active={() => state.derived.optimisticDraftConfig().mapVoteEnabled}
        disabled={() => state.lobbyActionPending() || state.pending.mapVoteEnabled()}
        onChange={checked => void state.actions.changeMapVoteEnabled(checked)}
      />
    ),
    renderReadonly: state => (
      <ReadonlyTimerRow label="Map Vote" value={state.derived.formattedMapVote()} valueClass={state.derived.draftConfig().mapVoteEnabled ? 'text-accent' : undefined} />
    ),
  },
  {
    key: 'leaderDataVersion',
    when: state => state.isLobbyMode() && !state.derived.isRedDeath() && !state.derived.isCivBlitz() && hasBetaLeaderData,
    renderEditable: state => (
      <SwitchRow
        label="BBG Beta"
        active={() => normalizeAvailableLeaderDataVersion(state.derived.optimisticDraftConfig().leaderDataVersion) === 'beta'}
        disabled={() => state.lobbyActionPending() || state.pending.leaderDataVersion()}
        onChange={checked => void state.actions.changeLeaderDataVersion(checked)}
      />
    ),
    renderReadonly: state => (
      <ReadonlyTimerRow
        label="BBG"
        value={state.derived.formattedBbgVersion()}
        valueClass={normalizeAvailableLeaderDataVersion(state.derived.draftConfig().leaderDataVersion) === 'beta' ? 'text-accent' : undefined}
      />
    ),
  },
  {
    key: 'civBlitzExcludeBbgExpanded',
    when: state => state.isLobbyMode() && !state.derived.isTournamentLobby() && state.derived.isCivBlitz(),
    renderEditable: state => (
      <SwitchRow
        label="Exclude BBG Expanded"
        active={() => state.derived.optimisticDraftConfig().civBlitzExcludeBbgExpanded}
        disabled={() => state.lobbyActionPending() || state.pending.civBlitzExcludeBbgExpanded()}
        onChange={checked => void state.actions.changeCivBlitzExcludeBbgExpanded(checked)}
      />
    ),
    renderReadonly: state => (
      <ReadonlyTimerRow label="Exclude Expanded" value={state.derived.formattedCivBlitzExcludeBbgExpanded()} valueClass={state.derived.draftConfig().civBlitzExcludeBbgExpanded ? 'text-accent' : undefined} />
    ),
  },
  {
    key: 'simultaneousPick',
    when: state => state.isLobbyMode() && !state.derived.isTournamentLobby() && state.lobbyMode() === 'ffa' && !state.derived.isRedDeath() && !state.derived.isCivBlitz() && !state.derived.optimisticDraftConfig().blindPicks,
    renderEditable: state => (
      <SwitchRow
        label="Simultaneous pick"
        active={() => state.derived.optimisticDraftConfig().simultaneousPick}
        disabled={() => state.lobbyActionPending() || state.pending.simultaneousPick()}
        onChange={checked => void state.actions.changeSimultaneousPick(checked)}
      />
    ),
    renderReadonly: state => (
      <ReadonlyTimerRow label="Simultaneous pick" value={state.derived.formattedSimultaneousPick()} valueClass={state.derived.draftConfig().simultaneousPick ? 'text-accent' : undefined} />
    ),
  },
  {
    key: 'permanentAlly',
    when: state => state.isLobbyMode() && !state.derived.isTournamentLobby() && state.lobbyMode() === 'ffa' && !state.derived.isRedDeath() && !state.derived.isCivBlitz(),
    renderEditable: state => (
      <SwitchRow
        label="Permanent Ally"
        active={() => state.derived.optimisticDraftConfig().permanentAlly}
        disabled={() => state.lobbyActionPending() || state.pending.permanentAlly()}
        onChange={checked => void state.actions.changePermanentAlly(checked)}
      />
    ),
    renderReadonly: state => (
      <ReadonlyTimerRow label="Permanent Ally" value={state.derived.formattedPermanentAlly()} valueClass={state.derived.draftConfig().permanentAlly ? 'text-accent' : undefined} />
    ),
  },
  {
    key: 'gameMode',
    when: state => state.isLobbyMode() && !state.derived.isTournamentLobby(),
    renderEditable: state => (
      <Dropdown
        label="Game Mode"
        value={state.lobbyMode()}
        disabled={state.lobbyActionPending()}
        options={state.options.lobbyModes()}
        onChange={value => void state.actions.changeLobbyMode(inferGameMode(value))}
      />
    ),
  },
  {
    key: 'rankBounds',
    when: state => state.isLobbyMode() && !state.derived.isTournamentLobby() && !state.derived.isUnranked(),
    renderEditable: (state, helpers) => (
      <div class="flex flex-col gap-1.5">
        <div class="text-[11px] text-fg-subtle tracking-wider font-semibold pl-0.5 uppercase">Min and max matchmaking rank</div>
        <div class="gap-2 grid grid-cols-1 sm:grid-cols-2">
          <Dropdown
            ariaLabel="Minimum matchmaking rank"
            value={state.fields.minRoleValue()}
            disabled={state.lobbyActionPending()}
            options={helpers.buildRoleDropdownOptions('Anyone')}
            onChange={value => void state.actions.changeMinRole(value)}
          />
          <Dropdown
            ariaLabel="Maximum matchmaking rank"
            value={state.fields.maxRoleValue()}
            disabled={state.lobbyActionPending()}
            options={helpers.buildRoleDropdownOptions('Anyone')}
            onChange={value => void state.actions.changeMaxRole(value)}
          />
        </div>
      </div>
    ),
    renderReadonly: state => (
      <>
        <ReadonlyTimerRow label="Min rank" value={state.derived.formattedLobbyMinRole()} />
        <ReadonlyTimerRow label="Max rank" value={state.derived.formattedLobbyMaxRole()} />
      </>
    ),
  },
  {
    key: 'leaderPool',
    when: state => state.isLobbyMode() && !state.derived.isTournamentLobby(),
    renderEditable: state => (
      <TextInput
        type="number"
        label={state.derived.poolInputLabel()}
        ariaLabel={state.derived.poolInputLabel()}
        min={String(state.derived.leaderPoolMinimum())}
        max={String(state.derived.leaderPoolMaximum())}
        step="1"
        value={state.fields.leaderPoolInput()}
        placeholder={state.derived.leaderPoolPlaceholder()}
        onFocus={() => state.actions.setEditingField('leaderPool')}
        onClamp={() => state.actions.clampField('leaderPool')}
        onInput={event => state.actions.inputLeaderPool(event.currentTarget.value)}
        onBlur={() => void state.actions.saveOnBlur()}
      />
    ),
    renderReadonly: state => (
      <ReadonlyTimerRow label={state.derived.poolInputLabel()} value={state.derived.formattedLeaderPool()} />
    ),
  },
  {
    key: 'banTimer',
    when: state => !state.derived.isRedDeath() && !state.derived.isCivBlitz(),
    renderEditable: state => (
      <TextInput
        type="number"
        label="Ban Timer (minutes)"
        ariaLabel="Ban Timer (minutes)"
        min="0"
        max={String(MAX_TIMER_MINUTES)}
        step={state.derived.timerInputStep(state.fields.banMinutes())}
        roundOnBlur={false}
        value={state.fields.banMinutes()}
        placeholder={state.derived.banTimerPlaceholder()}
        onFocus={() => state.actions.setEditingField('ban')}
        onClamp={() => state.actions.clampField('ban')}
        onInput={event => state.actions.inputBanMinutes(event.currentTarget.value)}
        onBlur={() => void state.actions.saveOnBlur()}
      />
    ),
    renderReadonly: state => (
      <ReadonlyTimerRow label="Ban Timer" value={state.derived.formattedBanTimer()} />
    ),
  },
  {
    key: 'pickTimer',
    when: () => true,
    renderEditable: state => (
      <TextInput
        type="number"
        label="Pick Timer (minutes)"
        ariaLabel="Pick Timer (minutes)"
        min="0"
        max={String(MAX_TIMER_MINUTES)}
        step={state.derived.timerInputStep(state.fields.pickMinutes())}
        roundOnBlur={false}
        value={state.fields.pickMinutes()}
        placeholder={state.derived.pickTimerPlaceholder()}
        onFocus={() => state.actions.setEditingField('pick')}
        onClamp={() => state.actions.clampField('pick')}
        onInput={event => state.actions.inputPickMinutes(event.currentTarget.value)}
        onBlur={() => void state.actions.saveOnBlur()}
      />
    ),
    renderReadonly: state => (
      <ReadonlyTimerRow label="Pick Timer" value={state.derived.formattedPickTimer()} />
    ),
  },
  {
    key: 'randomDraft',
    when: state => state.isLobbyMode() && !state.derived.isTournamentLobby() && !state.derived.isCivBlitz(),
    renderEditable: state => (
      <SwitchRow
        label="Random draft"
        active={() => state.derived.optimisticDraftConfig().randomDraft}
        disabled={() => state.lobbyActionPending() || state.pending.randomDraft()}
        onChange={checked => void state.actions.changeRandomDraft(checked)}
      />
    ),
    renderReadonly: state => (
      <ReadonlyTimerRow label="Random draft" value={state.derived.formattedRandomDraft()} valueClass={state.derived.draftConfig().randomDraft ? 'text-accent' : undefined} />
    ),
  },
  {
    key: 'hiddenDraft',
    when: state => state.isLobbyMode() && !state.derived.isTournamentLobby() && !state.derived.isCivBlitz(),
    renderEditable: state => (
      <SwitchRow
        label="Hidden draft"
        active={() => state.derived.optimisticDraftConfig().hiddenDraft}
        disabled={() => state.lobbyActionPending() || state.pending.hiddenDraft()}
        onChange={checked => void state.actions.changeHiddenDraft(checked)}
      />
    ),
    renderReadonly: state => (
      <ReadonlyTimerRow label="Hidden draft" value={state.derived.formattedHiddenDraft()} valueClass={state.derived.draftConfig().hiddenDraft ? 'text-accent' : undefined} />
    ),
  },
  {
    key: 'duplicateFactions',
    when: state => state.isLobbyMode() && !state.derived.isTournamentLobby() && !state.derived.isCivBlitz(),
    renderEditable: state => (
      <SwitchRow
        label={state.derived.duplicateOptionLabel()}
        active={() => state.derived.optimisticDuplicateFactions()}
        disabled={() => state.lobbyActionPending() || state.pending.duplicateFactions() || state.derived.duplicateFactionsLocked()}
        onChange={checked => void state.actions.changeDuplicateFactions(checked)}
      />
    ),
    renderReadonly: state => (
      <ReadonlyTimerRow label={state.derived.duplicateOptionLabel()} value={state.derived.formattedDuplicateFactions()} valueClass={state.derived.draftDuplicateFactions() ? 'text-accent' : undefined} />
    ),
  },
  {
    key: 'civBlitz',
    when: state => state.isLobbyMode() && !state.derived.isTournamentLobby(),
    renderEditable: state => (
      <div class="mt-1 pt-3 border-t border-border-subtle">
        <SwitchRow
          label="CivBlitz"
          active={() => state.derived.optimisticDraftConfig().civBlitz}
          activeClass="text-cyan-300"
          tone="cyan"
          disabled={() => state.lobbyActionPending() || state.pending.civBlitz()}
          onChange={checked => void state.actions.changeCivBlitz(checked)}
        />
      </div>
    ),
  },
  {
    key: 'redDeath',
    when: state => state.isLobbyMode() && !state.derived.isTournamentLobby(),
    renderEditable: state => (
      <SwitchRow
        label="Red Death"
        active={() => state.derived.optimisticDraftConfig().redDeath}
        activeClass="text-[#f97316]"
        tone="orange"
        disabled={() => state.lobbyActionPending() || state.pending.redDeath() || !state.derived.canToggleRedDeath()}
        onChange={checked => void state.actions.changeRedDeath(checked)}
      />
    ),
  },
]

export function DraftSetupConfigPanel(props: { state: DraftSetupConfigState }) {
  const state = () => props.state
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
    ...state().options.rankedRoles().map((option: RankedRoleOptionSnapshot) => ({
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

  return (
    <div class="p-4 rounded-lg bg-bg-subtle flex flex-col gap-3 min-h-0 overflow-hidden lg:h-full">
      <div class="text-xs text-fg-subtle tracking-widest font-bold flex uppercase items-center justify-between">
        <span>Config</span>
        <span class="flex h-4 w-4 items-center justify-center">
          <Show when={state().pending.spinner()}>
            <span class="i-gg:spinner text-sm text-accent animate-spin" />
          </Show>
        </span>
      </div>

      <div class="pr-4 flex flex-1 flex-col gap-3 min-h-0 overflow-y-auto -mr-3">
        <ConfigRows
          state={state()}
          mode={state().isHost() ? 'editable' : 'readonly'}
          buildRoleDropdownOptions={buildRoleDropdownOptions}
        />
      </div>

      <div class="shrink-0 min-h-5">
        <Show when={state().message.text()}>
          <div class="text-xs text-fg flex gap-1.5 items-center">
            <span
              class={cn(
                'text-base shrink-0 self-center',
                state().message.tone() === 'error'
                  ? 'i-ph-x-bold text-danger'
                  : state().message.tone() === 'warning'
                    ? 'i-ph-warning-bold text-amber-400'
                    : 'i-ph-check-bold text-accent',
              )}
            />
            <Show when={state().message.tone() === 'info' && state().message.rankRoleSetDetail()} fallback={<span class="leading-relaxed">{state().message.text()}</span>}>
              <RankRoleSetNotice detail={state().message.rankRoleSetDetail()!} />
            </Show>
          </div>
        </Show>
      </div>
    </div>
  )
}

function ConfigRows(props: { state: DraftSetupConfigState, mode: ConfigRowMode, buildRoleDropdownOptions: ConfigRowHelpers['buildRoleDropdownOptions'] }) {
  const state = () => props.state
  const helpers = (): ConfigRowHelpers => ({ buildRoleDropdownOptions: props.buildRoleDropdownOptions })
  const canRenderRow = (row: ConfigRowDefinition) => row.when(state()) && (props.mode === 'editable' ? row.renderEditable != null : row.renderReadonly != null)
  const renderRow = (row: ConfigRowDefinition) => props.mode === 'editable'
    ? row.renderEditable?.(state(), helpers())
    : row.renderReadonly?.(state())

  return (
    <div class="flex flex-col gap-2">
      <Show when={state().isLobbyMode()}>
        <Show when={props.mode === 'editable'} fallback={<ReadonlyLobbyAccessRow closed={state().derived.draftConfig().closed} />}>
          <EditableLobbyAccessRow state={state()} />
        </Show>
      </Show>
      <For each={CONFIG_ROWS}>
        {row => (
          <Show when={canRenderRow(row)}>
            {renderRow(row)}
          </Show>
        )}
      </For>
    </div>
  )
}

function ModeTabsRow(props: {
  label: string
  value: Accessor<'blind' | 'draft'>
  disabled: Accessor<boolean>
  onChange: (value: 'blind' | 'draft') => void
}) {
  const value = createMemo(() => props.value())
  const disabled = createMemo(() => props.disabled())
  const options = [
    { value: 'blind' as const, label: 'Blind', ariaLabel: `${props.label} Blind` },
    { value: 'draft' as const, label: 'Draft', ariaLabel: `${props.label} Draft` },
  ]

  return (
    <div class="px-1 flex gap-3 items-center justify-between">
      <span class="text-sm font-medium text-fg-muted">
        {props.label}
      </span>
      <Tabs
        options={options}
        value={value}
        disabled={disabled}
        onChange={props.onChange}
      />
    </div>
  )
}

function SwitchRow(props: {
  label: string
  active: Accessor<boolean>
  disabled: Accessor<boolean>
  tone?: 'orange' | 'cyan'
  activeClass?: string
  onChange: (checked: boolean) => void
}) {
  const active = createMemo(() => props.active())
  const disabled = createMemo(() => props.disabled())

  return (
    <div class="px-1 flex gap-3 items-center justify-between">
      <span class={cn('text-sm font-medium', active() ? (props.activeClass ?? 'text-accent') : 'text-fg-muted')}>
        {props.label}
      </span>
      <Switch
        ariaLabel={props.label}
        checked={active}
        disabled={disabled}
        class="w-auto"
        tone={props.tone}
        onChange={props.onChange}
      />
    </div>
  )
}

function EditableLobbyAccessRow(props: { state: DraftSetupConfigState }) {
  const state = () => props.state
  const [localOpen, setLocalOpen] = createSignal<boolean | null>(null)
  const isOpen = () => localOpen() ?? !state().derived.optimisticLobbyClosed()
  const label = () => isOpen() ? 'Lobby Open' : 'Lobby Closed'

  createEffect(() => {
    const local = localOpen()
    if (local != null && local === !state().derived.draftConfig().closed) setLocalOpen(null)
  })

  return (
    <div class="px-1 flex gap-3 items-center justify-between">
      <span class={cn('text-sm font-medium', isOpen() ? 'text-note' : 'text-[#a78bfa]')}>
        {label()}
      </span>
      <Switch
        ariaLabel={label}
        checked={isOpen}
        disabled={() => state().lobbyActionPending() || state().pending.closed()}
        class="w-auto"
        tone="note"
        inactiveTone="purple"
        onChange={(checked) => {
          setLocalOpen(checked)
          void state().actions.changeLobbyOpen(checked).then((saved) => {
            if (!saved) setLocalOpen(null)
          })
        }}
      />
    </div>
  )
}

function ReadonlyLobbyAccessRow(props: { closed: boolean }) {
  return (
    <div class="text-sm px-3 py-2 rounded-md bg-bg/35 flex items-center">
      <span class={cn('font-medium', props.closed ? 'text-[#a78bfa]' : 'text-note')}>
        {props.closed ? 'Lobby Closed' : 'Lobby Open'}
      </span>
    </div>
  )
}

function ReadonlyTimerRow(props: { label: string, value: string, valueClass?: string }) {
  return (
    <div class="text-sm px-3 py-2 rounded-md bg-bg/35 flex items-center justify-between">
      <span class="text-fg-muted">{props.label}</span>
      <span class={cn('text-fg font-medium', props.valueClass)}>{props.value}</span>
    </div>
  )
}

function RankRoleSetNotice(props: { detail: RankRoleSetDetail }) {
  return (
    <span class="leading-relaxed">
      {props.detail.boundLabel}
      {' '}
      set to
      {' '}
      <span class="font-semibold px-1.5 py-0.5 border rounded-sm inline-flex items-center" style={buildRolePillStyle(props.detail.roleColor)}>
        {props.detail.roleLabel}
      </span>
    </span>
  )
}
