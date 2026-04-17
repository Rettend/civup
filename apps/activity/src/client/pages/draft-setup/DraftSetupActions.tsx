import type { useDraftSetupState } from './useDraftSetupState'
import { Show } from 'solid-js'

type DraftSetupActionsState = ReturnType<typeof useDraftSetupState>['actions']
type DraftSetupStatusState = ReturnType<typeof useDraftSetupState>['status']

export function DraftSetupActions(props: { actions: DraftSetupActionsState, status: DraftSetupStatusState }) {
  const actions = () => props.actions
  const status = () => props.status

  return (
    <div class="shrink-0 flex justify-center">
      <Show when={actions().isHost()} fallback={<GuestActions actions={actions()} status={status()} />}>
        <Show when={!actions().isLobbyMode()} fallback={<HostLobbyActions actions={actions()} />}>
          <div class="flex flex-col gap-2 items-center">
            <span class="text-sm text-fg-subtle">{status().text()}</span>
            <div class="flex gap-3 items-center">
              <button class="text-sm text-bg font-bold px-8 py-2.5 rounded-lg bg-accent cursor-pointer transition-colors hover:brightness-110" onClick={() => void actions().sendStart()}>
                Start Draft
              </button>
              <button class="text-sm text-fg-muted px-6 py-2.5 border border-border rounded-lg bg-bg-muted/25 cursor-pointer transition-colors hover:text-fg hover:border-border-hover hover:bg-bg-muted/50" onClick={() => void actions().cancel()}>
                Cancel Draft
              </button>
            </div>
          </div>
        </Show>
      </Show>
    </div>
  )
}

function GuestActions(props: { actions: DraftSetupActionsState, status: DraftSetupStatusState }) {
  const actions = () => props.actions
  const status = () => props.status
  return (
    <div class="flex flex-col gap-2 items-center">
      <Show when={actions().isLobbyMode() && (!status().isCurrentUserSlotted() || status().canLeaveLobby())}>
        <div class="flex flex-wrap gap-3 items-center justify-center">
          <Show when={!status().isCurrentUserSlotted()}>
            <button
              class="text-sm text-bg font-bold px-8 py-2.5 rounded-lg bg-accent cursor-pointer transition-colors disabled:opacity-60 disabled:cursor-default hover:brightness-110"
              title={status().joinLobbyButtonTitle()}
              aria-label="Join Lobby"
              disabled={!status().canJoinLobby() || actions().pending.lobbyAction()}
              onClick={() => void actions().joinLobby()}
            >
              Join Lobby
            </button>
          </Show>

          <Show when={status().canLeaveLobby()}>
            <button
              class="text-sm text-fg-muted px-6 py-2.5 border border-border rounded-lg bg-bg-muted/25 cursor-pointer transition-colors hover:text-fg hover:border-border-hover hover:bg-bg-muted/50 disabled:opacity-60 disabled:cursor-default"
              title="Leave Lobby"
              aria-label="Leave Lobby"
              disabled={actions().pending.lobbyAction()}
              onClick={() => void actions().leaveLobby()}
            >
              Leave Lobby
            </button>
          </Show>
        </div>
      </Show>

      <span class="text-sm text-fg-subtle">{status().text()}</span>
    </div>
  )
}

function HostLobbyActions(props: { actions: DraftSetupActionsState }) {
  const actions = () => props.actions
  return (
    <div class="flex gap-3 items-center">
      <button
        class="text-sm text-bg font-bold px-8 py-2.5 rounded-lg bg-accent cursor-pointer transition-colors disabled:opacity-60 disabled:cursor-default hover:brightness-110"
        disabled={!actions().canStartLobby() || actions().pending.start() || actions().pending.lobbyAction()}
        onClick={() => void actions().startLobbyDraft()}
      >
        {actions().pending.start() ? 'Starting' : 'Start Draft'}
      </button>
      <button
        class="text-sm text-fg-muted px-6 py-2.5 border border-border rounded-lg bg-bg-muted/25 cursor-pointer transition-colors hover:text-fg hover:border-border-hover hover:bg-bg-muted/50 disabled:opacity-60 disabled:cursor-default"
        disabled={actions().pending.cancel() || actions().pending.start() || actions().pending.lobbyAction()}
        onClick={() => void actions().cancel()}
      >
        {actions().pending.cancel() ? 'Cancelling' : 'Cancel Lobby'}
      </button>
      <button
        class="text-fg-muted border border-border rounded-lg bg-bg-muted/25 flex h-10 w-10 cursor-pointer transition-colors items-center justify-center hover:text-fg hover:border-border-hover hover:bg-bg-muted/50 disabled:opacity-60 disabled:cursor-default"
        title={`Randomize ${actions().arrangeTargetLabel()}`}
        aria-label={`Randomize ${actions().arrangeTargetLabel()}`}
        disabled={actions().pending.cancel() || actions().pending.start() || actions().pending.lobbyAction()}
        onClick={() => void actions().randomizeLobby()}
      >
        <span class="i-ph:shuffle-simple-bold text-lg" />
      </button>
      <button
        class="text-fg-muted border border-border rounded-lg bg-bg-muted/25 flex h-10 w-10 cursor-pointer transition-colors items-center justify-center hover:text-fg hover:border-border-hover hover:bg-bg-muted/50 disabled:opacity-60 disabled:cursor-default"
        title={`Auto-balance ${actions().arrangeTargetLabel()}`}
        aria-label={`Auto-balance ${actions().arrangeTargetLabel()}`}
        disabled={actions().pending.cancel() || actions().pending.start() || actions().pending.lobbyAction()}
        onClick={() => void actions().balanceLobby()}
      >
        <span class="i-ph:scales-bold text-lg" />
      </button>
      <Show when={actions().fillTestPlayersAvailable()}>
        <button
          class="text-sm text-fg-muted px-6 py-2.5 border border-border rounded-lg bg-bg-muted/25 cursor-pointer transition-colors hover:text-fg hover:border-border-hover hover:bg-bg-muted/50 disabled:opacity-60 disabled:cursor-default"
          disabled={actions().pending.cancel() || actions().pending.start() || actions().pending.lobbyAction()}
          onClick={() => void actions().fillTestPlayers()}
        >
          Fill Test Players
        </button>
      </Show>
    </div>
  )
}
