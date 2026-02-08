import { Show } from 'solid-js'
import {
  banSelections,
  clearSelections,
  currentStep,
  draftStore,
  hasSubmitted,
  isMyTurn,
  isSpectator,
  selectedLeader,
  sendBan,
  sendPick,
  sendStart,
} from '~/client/stores'
import { Button } from '../ui'

/** Bottom action bar — shows contextual actions for the active player */
export function ActionBar() {
  const state = () => draftStore.state
  const step = currentStep

  const handleConfirmPick = () => {
    const civId = selectedLeader()
    if (!civId) return
    sendPick(civId)
    clearSelections()
  }

  const handleConfirmBan = () => {
    const civIds = banSelections()
    if (civIds.length === 0) return
    sendBan(civIds)
    clearSelections()
  }

  return (
    <footer class="flex items-center justify-center border-t border-border-subtle bg-bg-secondary/50 px-6 py-4 backdrop-blur-sm">
      {/* Waiting state */}
      <Show when={state()?.status === 'waiting' && !isSpectator()}>
        <Button variant="gold" size="lg" onClick={sendStart}>
          Start Draft
        </Button>
      </Show>

      {/* Active — my turn */}
      <Show when={state()?.status === 'active' && isMyTurn() && !hasSubmitted()}>
        {/* Ban phase */}
        <Show when={step()?.action === 'ban'}>
          <div class="flex items-center gap-4">
            <span class="text-sm text-text-secondary">
              Select
              {' '}
              {step()!.count}
              {' '}
              leader
              {step()!.count > 1 ? 's' : ''}
              {' '}
              to ban
            </span>
            <Button
              variant="red"
              size="lg"
              disabled={banSelections().length !== step()!.count}
              onClick={handleConfirmBan}
            >
              Confirm Bans (
              {banSelections().length}
              /
              {step()!.count}
              )
            </Button>
          </div>
        </Show>

        {/* Pick phase */}
        <Show when={step()?.action === 'pick'}>
          <div class="flex items-center gap-4">
            <span class="text-sm text-text-secondary">
              Pick your leader
            </span>
            <Button
              variant="gold"
              size="lg"
              disabled={!selectedLeader()}
              onClick={handleConfirmPick}
            >
              Confirm Pick
            </Button>
          </div>
        </Show>
      </Show>

      {/* Already submitted */}
      <Show when={state()?.status === 'active' && isMyTurn() && hasSubmitted()}>
        <span class="text-sm text-text-muted">Waiting for other players...</span>
      </Show>

      {/* Not my turn */}
      <Show when={state()?.status === 'active' && !isMyTurn() && !isSpectator()}>
        <span class="text-sm text-text-muted">Waiting for opponent...</span>
      </Show>

      {/* Spectator */}
      <Show when={isSpectator() && state()?.status === 'active'}>
        <span class="text-sm text-text-muted">Spectating</span>
      </Show>

      {/* Draft complete */}
      <Show when={state()?.status === 'complete'}>
        <span class="text-lg text-accent-gold text-heading">Draft Complete!</span>
      </Show>
    </footer>
  )
}
