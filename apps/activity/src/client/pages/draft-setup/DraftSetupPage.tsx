import { Show } from 'solid-js'
import { DraftSetupActions } from './DraftSetupActions'
import { DraftSetupConfigPanel } from './DraftSetupConfigPanel'
import { DraftSetupHeader } from './DraftSetupHeader'
import { DraftSetupMiniView } from './DraftSetupMiniView'
import { DraftSetupPlayersPanel } from './DraftSetupPlayersPanel'
import { useDraftSetupState } from './useDraftSetupState'
import { cn } from '~/client/lib/css'
import type { DraftSetupPageProps } from './types'

export function DraftSetupPage(props: DraftSetupPageProps) {
  const state = useDraftSetupState(props)

  return (
    <Show when={state.layout.isMiniView()} fallback={(
      <div class="text-fg font-sans bg-bg relative flex min-h-dvh flex-col overflow-y-auto lg:h-dvh lg:overflow-hidden">
        <DraftSetupHeader header={state.header} isMobileLayout={state.layout.isMobileLayout()} onSwitchTarget={props.onSwitchTarget} />

        <div class={cn('mx-auto px-6 py-4 flex w-full max-w-5xl flex-1 min-h-0 flex-col gap-6', state.layout.isMobileLayout() && 'pt-12')}>
          <div class={cn('gap-4 grid grid-cols-1 lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_320px] lg:grid-rows-[minmax(0,1fr)]', state.layout.desktopSetupPanelMaxHeightClass())}>
            <div class="p-4 rounded-lg bg-bg-subtle flex flex-col min-h-0 overflow-hidden lg:h-full">
              <div class="mb-3 flex items-center justify-between gap-3 text-xs text-fg-subtle tracking-widest font-bold uppercase">
                <span>Players</span>
                <Show when={state.players.lowConfidence()}>
                  <span class="inline-flex items-center gap-1 text-[11px] text-fg-subtle/70 font-medium tracking-normal normal-case">
                    <span class="i-ph-warning-circle text-xs" />
                    low confidence
                  </span>
                </Show>
              </div>

              <div class="pr-1 flex-1 min-h-0 overflow-y-auto">
                <DraftSetupPlayersPanel state={state.players} />

                <Show when={state.players.teamCountToggle.show()}>
                  <div class="mt-4 flex flex-col gap-2">
                    <div class="flex gap-3 items-center justify-center">
                      <div class="h-px flex-1 bg-border-subtle" />
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
                      <div class="h-px flex-1 bg-border-subtle" />
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
    )}>
      <DraftSetupMiniView mini={state.mini} />
    </Show>
  )
}
