import type { DraftSetupPageProps } from './types'
import type { LobbyArrangeStrategy } from '~/client/stores'
import { Show } from 'solid-js'
import { cn } from '~/client/lib/css'
import { DraftSetupActions } from './DraftSetupActions'
import { DraftSetupConfigPanel } from './DraftSetupConfigPanel'
import { DraftSetupHeader } from './DraftSetupHeader'
import { DraftSetupMiniView } from './DraftSetupMiniView'
import { DraftSetupPlayersPanel } from './DraftSetupPlayersPanel'
import { useDraftSetupState } from './useDraftSetupState'

export function DraftSetupPage(props: DraftSetupPageProps) {
  const state = useDraftSetupState(props)

  return (
    <Show
      when={state.layout.isMiniView()}
      fallback={(
        <div class="text-fg font-sans bg-bg flex flex-col relative overflow-y-auto min-h-dvh lg:overflow-hidden lg:h-dvh">
          <DraftSetupHeader header={state.header} isMobileLayout={state.layout.isMobileLayout()} onSwitchTarget={props.onSwitchTarget} />

          <div class={cn('mx-auto px-6 py-4 flex w-full max-w-5xl flex-1 min-h-0 flex-col gap-6', state.layout.isMobileLayout() && 'pt-12')}>
            <div class={cn('gap-4 grid grid-cols-1 lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_320px] lg:grid-rows-[minmax(0,1fr)]', state.layout.desktopSetupPanelMaxHeightClass())}>
              <div class="p-4 rounded-lg bg-bg-subtle flex flex-col min-h-0 overflow-hidden lg:h-full">
                <div class="text-xs text-fg-subtle tracking-widest font-bold mb-3 flex gap-3 uppercase items-center justify-between relative">
                  <span>Players</span>
                  <Show when={state.players.arrangeEvent()}>
                    {event => <LastArrangeIndicator strategy={event().strategy} isTeamMode={state.players.isTeamMode()} mode={state.config.lobbyMode()} />}
                  </Show>
                </div>

                <div class="pr-1 flex-1 min-h-0 overflow-y-auto">
                  <DraftSetupPlayersPanel state={state.players} />

                  <Show when={state.players.teamCountToggle.show()}>
                    <div class="mt-4 flex flex-col gap-2">
                      <div class="flex gap-3 items-center justify-center">
                        <div class="bg-border-subtle flex-1 h-px" />
                        <button
                          type="button"
                          class={cn(
                            'border rounded-full flex h-8 w-8 items-center justify-center transition-colors',
                            state.players.teamCountToggle.canToggle()
                              ? 'border-border text-fg-muted hover:text-fg hover:border-border-hover hover:bg-bg-muted/40 cursor-pointer'
                              : 'border-border-subtle text-fg-subtle/60 cursor-default',
                          )}
                          disabled={!state.players.teamCountToggle.canToggle()}
                          title={state.players.teamCountToggle.title()}
                          aria-label={state.players.teamCountToggle.label()}
                          onClick={() => void state.players.teamCountToggle.toggle()}
                        >
                          <span class={cn(state.players.teamCountToggle.expanded() ? 'i-ph-minus-bold' : 'i-ph-plus-bold', 'text-sm')} />
                        </button>
                        <div class="bg-border-subtle flex-1 h-px" />
                      </div>
                    </div>
                  </Show>
                </div>
              </div>

              <DraftSetupConfigPanel state={state.config} />
            </div>

            <DraftSetupActions actions={state.actions} status={state.status} />
          </div>
        </div>
      )}
    >
      <DraftSetupMiniView mini={state.mini} />
    </Show>
  )
}

function LastArrangeIndicator(props: { strategy: LobbyArrangeStrategy, isTeamMode: boolean, mode: string }) {
  const label = () => getLastArrangeLabel(props.strategy, props.isTeamMode, props.mode)

  return (
    <span
      class="text-[11px] text-fg-subtle leading-none tracking-normal font-medium px-2 py-1 border border-border-subtle rounded-full bg-bg-muted/25 inline-flex gap-1.5 normal-case items-center right-0 top-1/2 absolute -translate-y-1/2"
      title={label()}
      aria-label={`Last used: ${label()}`}
    >
      <span>Last used:</span>
      <span class={cn(getLastArrangeIconClass(props.strategy), 'text-xs text-accent')} aria-hidden />
    </span>
  )
}

function getLastArrangeLabel(strategy: LobbyArrangeStrategy, isTeamMode: boolean, mode: string) {
  switch (strategy) {
    case 'balance':
      return isTeamMode ? 'Teams balanced' : 'Seat order balanced'
    case 'shuffle-teams':
      return mode === '1v1' ? 'First pick randomized' : 'Teams shuffled'
    default:
      return isTeamMode ? 'Players shuffled' : 'Seat order randomized'
  }
}

function getLastArrangeIconClass(strategy: LobbyArrangeStrategy) {
  switch (strategy) {
    case 'balance':
      return 'i-ph:scales-bold'
    case 'shuffle-teams':
      return 'i-ph:arrows-clockwise-bold'
    default:
      return 'i-ph:shuffle-simple-bold'
  }
}
