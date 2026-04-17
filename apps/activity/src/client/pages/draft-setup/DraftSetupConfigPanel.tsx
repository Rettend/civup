import type { RankedRoleOptionSnapshot } from '~/client/stores'
import type { useDraftSetupState } from './useDraftSetupState'
import type { RankRoleSetDetail } from './helpers'
import { Dropdown, Switch, TextInput } from '~/client/components/ui'
import { Show } from 'solid-js'
import { hasBetaLeaderData, inferGameMode, normalizeAvailableLeaderDataVersion } from '@civup/game'
import { buildRankDotStyle, buildRolePillStyle, MAX_LEADER_POOL_INPUT, MAX_TIMER_MINUTES } from './helpers'
import { cn } from '~/client/lib/css'
import { mapVoteEnabled, setMapVoteEnabled } from '~/client/stores'

type DraftSetupConfigState = ReturnType<typeof useDraftSetupState>['config']

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
        <Show when={state().isLobbyMode() && state().isHost() && !state().derived.isRedDeath()}>
          <SwitchRow
            label="Map Vote"
            active={mapVoteEnabled()}
            disabled={false}
            onChange={checked => setMapVoteEnabled(checked)}
          />
        </Show>

        <Show when={state().isLobbyMode() && state().isHost() && state().derived.supportsBlindBans()}>
          <SwitchRow
            label="Blind Bans"
            active={state().derived.optimisticDraftConfig().blindBans}
            disabled={state().lobbyActionPending() || state().pending.blindBans()}
            onChange={checked => void state().actions.changeBlindBans(checked)}
          />
        </Show>

        <Show when={state().isLobbyMode() && state().isHost() && !state().derived.isRedDeath() && hasBetaLeaderData}>
          <SwitchRow
            label="BBG Beta"
            active={normalizeAvailableLeaderDataVersion(state().derived.optimisticDraftConfig().leaderDataVersion) === 'beta'}
            disabled={state().lobbyActionPending() || state().pending.leaderDataVersion()}
            onChange={checked => void state().actions.changeLeaderDataVersion(checked)}
          />
        </Show>

        <Show when={state().isLobbyMode() && state().isHost() && state().lobbyMode() === 'ffa' && !state().derived.isRedDeath()}>
          <SwitchRow
            label="Simultaneous pick"
            active={state().derived.optimisticDraftConfig().simultaneousPick}
            disabled={state().lobbyActionPending() || state().pending.simultaneousPick()}
            onChange={checked => void state().actions.changeSimultaneousPick(checked)}
          />
        </Show>

        <Show when={state().isLobbyMode() && state().isHost()}>
          <Dropdown
            label="Game Mode"
            value={state().lobbyMode()}
            disabled={state().lobbyActionPending()}
            options={state().options.lobbyModes()}
            onChange={value => void state().actions.changeLobbyMode(inferGameMode(value))}
          />
        </Show>

        <Show when={state().isHost()} fallback={<ReadonlyConfig state={state()} />}>
          <div class="flex flex-col gap-2">
            <Show when={state().isLobbyMode() && !state().derived.isUnranked()}>
              <div class="flex flex-col gap-1.5">
                <div class="text-[11px] text-fg-subtle tracking-wider font-semibold pl-0.5 uppercase">Min and max matchmaking rank</div>
                <div class="gap-2 grid grid-cols-1 sm:grid-cols-2">
                  <Dropdown
                    ariaLabel="Minimum matchmaking rank"
                    value={state().fields.minRoleValue()}
                    disabled={state().lobbyActionPending()}
                    options={buildRoleDropdownOptions('Anyone')}
                    onChange={value => void state().actions.changeMinRole(value)}
                  />
                  <Dropdown
                    ariaLabel="Maximum matchmaking rank"
                    value={state().fields.maxRoleValue()}
                    disabled={state().lobbyActionPending()}
                    options={buildRoleDropdownOptions('Anyone')}
                    onChange={value => void state().actions.changeMaxRole(value)}
                  />
                </div>
              </div>
            </Show>

            <Show when={state().isLobbyMode()}>
              <TextInput
                type="number"
                label={state().derived.poolInputLabel()}
                ariaLabel={state().derived.poolInputLabel()}
                min={state().derived.isRedDeath() ? '2' : String(state().derived.leaderPoolMinimum())}
                max={state().derived.isRedDeath() ? '10' : String(MAX_LEADER_POOL_INPUT)}
                step="1"
                value={state().fields.leaderPoolInput()}
                placeholder={state().derived.leaderPoolPlaceholder()}
                onFocus={() => state().actions.setEditingField('leaderPool')}
                onClamp={() => state().actions.clampField('leaderPool')}
                onInput={(event) => state().actions.inputLeaderPool(event.currentTarget.value)}
                onBlur={() => void state().actions.saveOnBlur()}
              />
            </Show>

            <Show when={!state().derived.isRedDeath()}>
              <TextInput
                type="number"
                label="Ban Timer (minutes)"
                ariaLabel="Ban Timer (minutes)"
                min="0"
                max={String(MAX_TIMER_MINUTES)}
                step={state().derived.timerInputStep(state().fields.banMinutes())}
                roundOnBlur={false}
                value={state().fields.banMinutes()}
                placeholder={state().derived.banTimerPlaceholder()}
                onFocus={() => state().actions.setEditingField('ban')}
                onClamp={() => state().actions.clampField('ban')}
                onInput={(event) => state().actions.inputBanMinutes(event.currentTarget.value)}
                onBlur={() => void state().actions.saveOnBlur()}
              />
            </Show>

            <TextInput
              type="number"
              label="Pick Timer (minutes)"
              ariaLabel="Pick Timer (minutes)"
              min="0"
              max={String(MAX_TIMER_MINUTES)}
              step={state().derived.timerInputStep(state().fields.pickMinutes())}
              roundOnBlur={false}
              value={state().fields.pickMinutes()}
              placeholder={state().derived.pickTimerPlaceholder()}
              onFocus={() => state().actions.setEditingField('pick')}
              onClamp={() => state().actions.clampField('pick')}
              onInput={(event) => state().actions.inputPickMinutes(event.currentTarget.value)}
              onBlur={() => void state().actions.saveOnBlur()}
            />

            <Show when={state().isLobbyMode()}>
              <SwitchRow
                label="Random draft"
                active={state().derived.optimisticDraftConfig().randomDraft}
                disabled={state().lobbyActionPending() || state().pending.randomDraft()}
                onChange={checked => void state().actions.changeRandomDraft(checked)}
              />

              <SwitchRow
                label={state().derived.duplicateOptionLabel()}
                active={state().derived.optimisticDuplicateFactions()}
                disabled={state().lobbyActionPending() || state().pending.duplicateFactions() || state().derived.duplicateFactionsLocked()}
                onChange={checked => void state().actions.changeDuplicateFactions(checked)}
              />

              <div class="mt-1 pt-3 border-t border-border-subtle">
                <SwitchRow
                  label="Red Death"
                  active={state().derived.optimisticDraftConfig().redDeath}
                  activeClass="text-[#f97316]"
                  tone="orange"
                  disabled={state().lobbyActionPending() || state().pending.redDeath() || !state().derived.canToggleRedDeath()}
                  onChange={checked => void state().actions.changeRedDeath(checked)}
                />
              </div>
            </Show>
          </div>
        </Show>
      </div>

      <div class="min-h-5 shrink-0">
        <Show when={state().message.text()}>
          <div class="text-xs text-fg flex gap-1.5 items-center">
            <span
              class={cn(
                'text-base shrink-0 self-center',
                state().message.tone() === 'error' ? 'i-ph-x-bold text-danger' : 'i-ph-check-bold text-accent',
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

function ReadonlyConfig(props: { state: DraftSetupConfigState }) {
  const state = () => props.state
  return (
    <div class="flex flex-col gap-2">
      <Show when={state().isLobbyMode() && state().derived.supportsBlindBans()}>
        <ReadonlyTimerRow label="Blind bans" value={state().derived.formattedBlindBans()} valueClass={state().derived.draftConfig().blindBans ? 'text-accent' : undefined} />
      </Show>
      <Show when={!state().derived.isRedDeath() && hasBetaLeaderData}>
        <ReadonlyTimerRow
          label="BBG"
          value={state().derived.formattedBbgVersion()}
          valueClass={normalizeAvailableLeaderDataVersion(state().derived.draftConfig().leaderDataVersion) === 'beta' ? 'text-accent' : undefined}
        />
      </Show>
      <Show when={state().isLobbyMode() && state().lobbyMode() === 'ffa' && !state().derived.isRedDeath()}>
        <ReadonlyTimerRow label="Simultaneous pick" value={state().derived.formattedSimultaneousPick()} valueClass={state().derived.draftConfig().simultaneousPick ? 'text-accent' : undefined} />
      </Show>
      <Show when={state().isLobbyMode() && !state().derived.isUnranked()}>
        <>
          <ReadonlyTimerRow label="Min rank" value={state().derived.formattedLobbyMinRole()} />
          <ReadonlyTimerRow label="Max rank" value={state().derived.formattedLobbyMaxRole()} />
        </>
      </Show>
      <ReadonlyTimerRow label={state().derived.poolInputLabel()} value={state().derived.formattedLeaderPool()} />
      <Show when={!state().derived.isRedDeath()}>
        <ReadonlyTimerRow label="Ban timer" value={state().derived.formattedBanTimer()} />
      </Show>
      <ReadonlyTimerRow label="Pick timer" value={state().derived.formattedPickTimer()} />
      <Show when={state().isLobbyMode()}>
        <ReadonlyTimerRow label="Random draft" value={state().derived.formattedRandomDraft()} valueClass={state().derived.draftConfig().randomDraft ? 'text-accent' : undefined} />
        <ReadonlyTimerRow label={state().derived.duplicateOptionLabel()} value={state().derived.formattedDuplicateFactions()} valueClass={state().derived.draftDuplicateFactions() ? 'text-accent' : undefined} />
      </Show>
    </div>
  )
}

function SwitchRow(props: {
  label: string
  active: boolean
  disabled: boolean
  tone?: 'orange'
  activeClass?: string
  onChange: (checked: boolean) => void
}) {
  return (
    <div class="px-1 flex gap-3 items-center justify-between">
      <span class={cn('text-sm font-medium', props.active ? (props.activeClass ?? 'text-accent') : 'text-fg-muted')}>
        {props.label}
      </span>
      <Switch
        ariaLabel={props.label}
        checked={props.active}
        disabled={props.disabled}
        class="w-auto"
        tone={props.tone}
        onChange={props.onChange}
      />
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
