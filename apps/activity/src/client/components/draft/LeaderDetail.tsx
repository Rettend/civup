import type { Leader } from '@civup/game'
import { getLeader } from '@civup/game'
import { For, Show } from 'solid-js'
import { cn } from '~/client/lib/cn'
import { hoveredLeader, selectedLeader } from '~/client/stores'
import { Badge } from '../ui'

/** Detail panel showing full info for the hovered/selected leader */
export function LeaderDetail() {
  const leader = (): Leader | null => {
    const id = hoveredLeader() ?? selectedLeader()
    if (!id) return null
    try {
      return getLeader(id)
    }
    catch { return null }
  }

  return (
    <div
      class={cn(
        'absolute right-0 top-0 bottom-0 w-72 bg-bg-secondary/95 backdrop-blur-md border-l border-border-subtle',
        'p-4 overflow-y-auto transition-all duration-200',
        'flex flex-col gap-3',
        leader() ? 'translate-x-0 opacity-100' : 'translate-x-4 opacity-0 pointer-events-none',
      )}
    >
      <Show when={leader()}>
        {l => (
          <>
            {/* Portrait */}
            <div class="aspect-square w-full flex items-center justify-center overflow-hidden rounded-lg bg-bg-panel">
              <Show
                when={l().portraitUrl}
                fallback={(
                  <span class="text-4xl text-accent-gold font-bold">
                    {l().name.slice(0, 1)}
                  </span>
                )}
              >
                {url => <img src={url()} alt={l().name} class="h-full w-full object-cover" />}
              </Show>
            </div>

            {/* Name */}
            <div>
              <h3 class="text-lg text-text-primary font-bold">{l().name}</h3>
              <span class="text-sm text-text-secondary">{l().civilization}</span>
            </div>

            {/* Tags */}
            <div class="flex flex-wrap gap-1">
              <For each={l().tags}>
                {tag => (
                  <Badge variant="gold">{tag}</Badge>
                )}
              </For>
            </div>

            {/* Ability */}
            <div>
              <h4 class="mb-1 text-xs text-accent-gold font-semibold tracking-wider uppercase">
                Ability
              </h4>
              <p class="text-sm text-text-primary font-medium">{l().ability.name}</p>
              <p class="mt-0.5 text-xs text-text-secondary leading-relaxed">{l().ability.description}</p>
            </div>

            {/* Unique Units */}
            <Show when={l().uniqueUnits.length > 0}>
              <div>
                <h4 class="mb-1 text-xs text-accent-gold font-semibold tracking-wider uppercase">
                  Unique Units
                </h4>
                <For each={l().uniqueUnits}>
                  {unit => (
                    <div class="mb-1.5">
                      <p class="text-sm text-text-primary font-medium">
                        {unit.name}
                        <Show when={unit.replaces}>
                          <span class="ml-1 text-xs text-text-muted">
                            (replaces
                            {unit.replaces}
                            )
                          </span>
                        </Show>
                      </p>
                      <p class="text-xs text-text-secondary leading-relaxed">{unit.description}</p>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            {/* Unique Building */}
            <Show when={l().uniqueBuilding}>
              {ub => (
                <div>
                  <h4 class="mb-1 text-xs text-accent-gold font-semibold tracking-wider uppercase">
                    Unique Building
                  </h4>
                  <p class="text-sm text-text-primary font-medium">
                    {ub().name}
                    <Show when={ub().replaces}>
                      <span class="ml-1 text-xs text-text-muted">
                        (replaces
                        {ub().replaces}
                        )
                      </span>
                    </Show>
                  </p>
                  <p class="text-xs text-text-secondary leading-relaxed">{ub().description}</p>
                </div>
              )}
            </Show>

            {/* Unique Improvement */}
            <Show when={l().uniqueImprovement}>
              {ui => (
                <div>
                  <h4 class="mb-1 text-xs text-accent-gold font-semibold tracking-wider uppercase">
                    Unique Improvement
                  </h4>
                  <p class="text-sm text-text-primary font-medium">{ui().name}</p>
                  <p class="text-xs text-text-secondary leading-relaxed">{ui().description}</p>
                </div>
              )}
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}
