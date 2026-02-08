import { currentStepDuration, draftStore, phaseLabel } from '~/client/stores'
import { Badge, Timer } from '../ui'

/** Top bar showing: phase label | match info | timer */
export function TopBar() {
  const state = () => draftStore.state
  const step = () => {
    const s = state()
    if (!s || s.status !== 'active') return null
    return s.steps[s.currentStepIndex] ?? null
  }

  return (
    <header class="flex items-center justify-between border-b border-border-subtle bg-bg-secondary/50 px-6 py-3 backdrop-blur-sm">
      {/* Left: phase label */}
      <div class="flex items-center gap-3">
        <h1 class="text-lg text-accent-gold text-heading tracking-widest">
          {phaseLabel()}
        </h1>
        {step() && (
          <Badge variant={step()!.action === 'ban' ? 'red' : 'gold'}>
            {step()!.action === 'ban' ? 'BAN' : 'PICK'}
          </Badge>
        )}
      </div>

      {/* Center: match info */}
      <div class="text-sm text-text-secondary">
        {state()?.formatId?.replace(/-/g, ' ').toUpperCase() ?? ''}
      </div>

      {/* Right: timer */}
      <div class="w-28">
        <Timer
          endsAt={draftStore.timerEndsAt}
          duration={currentStepDuration()}
        />
      </div>
    </header>
  )
}
