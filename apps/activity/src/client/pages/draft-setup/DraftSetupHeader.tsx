import type { useDraftSetupState } from './useDraftSetupState'
import { Show } from 'solid-js'
import { SteamLobbyButton } from '~/client/components/draft/SteamLobbyButton'
import { cn } from '~/client/lib/css'

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
      <Show when={props.onSwitchTarget}>
        <button
          type="button"
          class={cn(
            'text-fg-muted border border-border-subtle rounded-md flex h-9 w-9 cursor-pointer transition-colors items-center justify-center z-20 absolute hover:text-fg hover:bg-bg-muted',
            props.isMobileLayout ? 'top-12 right-4' : 'top-4 right-6',
          )}
          title="Lobby Overview"
          aria-label="Lobby Overview"
          onClick={() => props.onSwitchTarget?.()}
        >
          <span class="i-ph-squares-four-bold text-base" />
        </button>
      </Show>

      <SteamLobbyButton
        steamLobbyLink={header().steamLobbyLink()}
        isHost={header().isHost()}
        onSaveSteamLink={header().isLobbyMode() ? header().saveSteamLobbyLink : undefined}
        savePending={header().savePending()}
        class={cn(
          'z-20 absolute',
          props.isMobileLayout ? 'top-12 left-4 h-9 w-9' : 'top-4 left-6 h-9 w-9',
        )}
      />

      <div class="grid grid-cols-[2.25rem_minmax(0,1fr)_2.25rem] items-center">
        <div class="h-9 w-9" />
        <div class="text-center">
          <h1 class="text-2xl text-heading mb-1">Draft Setup</h1>
          <span class={cn('text-sm font-medium', header().modeLabelClass())}>{header().formatLabel()}</span>
        </div>
        <div class="h-9 w-9" />
      </div>
    </>
  )
}
