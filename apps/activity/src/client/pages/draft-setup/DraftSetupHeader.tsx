import type { useDraftSetupState } from './useDraftSetupState'
import { Show } from 'solid-js'
import { preloadLobbyOverviewRoute } from '~/client/activity/route-preloads'
import { SteamLobbyButton } from '~/client/components/draft/SteamLobbyButton'
import { UiScaleMenu } from '~/client/components/ui/UiScaleMenu'
import { cn } from '~/client/lib/css'
import { buildRolePillStyle } from './helpers'

type DraftSetupHeaderState = ReturnType<typeof useDraftSetupState>['header']

interface DraftSetupHeaderProps {
  header: DraftSetupHeaderState
  isMobileLayout: boolean
  onSwitchTarget?: () => void
}

export function DraftSetupHeader(props: DraftSetupHeaderProps) {
  const header = () => props.header
  return (
    <>
      <div class={cn('flex gap-2 items-center z-20 absolute', props.isMobileLayout ? 'top-12 right-4' : 'top-4 right-6')}>
        <UiScaleMenu buttonClass="border-border-subtle h-9 w-9" />
        <Show when={props.onSwitchTarget}>
          <button
            type="button"
            class="text-fg-muted border border-border-subtle rounded-md flex h-9 w-9 cursor-pointer transition-colors items-center justify-center hover:text-fg hover:bg-bg-muted"
            title="Lobby Overview"
            aria-label="Lobby Overview"
            onPointerEnter={() => { void preloadLobbyOverviewRoute() }}
            onFocus={() => { void preloadLobbyOverviewRoute() }}
            onClick={() => props.onSwitchTarget?.()}
          >
            <span class="i-ph-squares-four-bold text-base" />
          </button>
        </Show>
      </div>

      <SteamLobbyButton
        steamLobbyLink={header().steamLobbyLink()}
        onSaveSteamLink={header().canSaveSteamLobbyLink() ? header().saveSteamLobbyLink : undefined}
        savePending={header().savePending()}
        class={cn(
          'z-20 absolute',
          props.isMobileLayout ? 'top-12 left-4 h-9 w-9' : 'top-4 left-6 h-9 w-9',
        )}
      />

      <div class="grid grid-cols-[2.25rem_minmax(0,1fr)_2.25rem] items-center">
        <div class="h-9 w-9" />
        <div class="text-center">
          <div class="relative inline-flex flex-col items-center sm:inline-block">
            <h1 class="text-2xl text-heading mb-1">Draft Setup</h1>
            <Show when={header().lobbyRank()}>
              {rank => (
                <span
                  class="text-[11px] leading-none font-semibold px-2 py-1 border rounded-full bg-bg-muted/40 inline-flex whitespace-nowrap items-center justify-center max-sm:mb-1 sm:absolute sm:left-full sm:top-1/2 sm:ml-3 sm:-translate-y-[calc(50%+0.125rem)]"
                  style={buildRolePillStyle(rank().color)}
                  title={rank().leaderPoolSize == null ? `Average lobby rank: ${rank().label}` : `Average lobby rank: ${rank().label}. Default leaders: ${rank().leaderPoolSize}`}
                >
                  {rank().label} lobby
                </span>
              )}
            </Show>
          </div>
          <span class={cn('block text-sm font-medium', header().modeLabelClass())}>{header().formatLabel()}</span>
        </div>
        <div class="h-9 w-9" />
      </div>
    </>
  )
}
