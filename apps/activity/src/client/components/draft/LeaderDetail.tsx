import type { Leader } from '@civup/game'
import { getLeader } from '@civup/game'
import { For, Show } from 'solid-js'
import { cn } from '~/client/lib/cn'
import { hoveredLeader, selectedLeader } from '~/client/stores'
import { Badge } from '../ui'
import { RichLeaderText } from './RichLeaderText'

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
              <RichLeaderText text={l().ability.description} class="mt-0.5 block text-xs text-text-secondary leading-relaxed" />
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
                      <p class="flex items-center gap-1.5 text-sm text-text-primary font-medium">
                        <Show when={unit.iconUrl}>
                          {icon => (
                            <img
                              src={icon()}
                              alt={unit.name}
                              class="h-4 w-4 shrink-0"
                              onError={(event) => { event.currentTarget.style.display = 'none' }}
                            />
                          )}
                        </Show>
                        <span>{unit.name}</span>
                        <Show when={unit.replaces}>
                          <span class="ml-1 text-xs text-text-muted">
                            (replaces
                            {' '}
                            {unit.replaces}
                            )
                          </span>
                        </Show>
                      </p>
                      <RichLeaderText text={unit.description} class="block text-xs text-text-secondary leading-relaxed" />
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
                  <p class="flex items-center gap-1.5 text-sm text-text-primary font-medium">
                    <Show when={ub().iconUrl}>
                      {icon => (
                        <img
                          src={icon()}
                          alt={ub().name}
                          class="h-4 w-4 shrink-0"
                          onError={(event) => { event.currentTarget.style.display = 'none' }}
                        />
                      )}
                    </Show>
                    <span>{ub().name}</span>
                    <Show when={ub().replaces}>
                      <span class="ml-1 text-xs text-text-muted">
                        (replaces
                        {' '}
                        {ub().replaces}
                        )
                      </span>
                    </Show>
                  </p>
                  <RichLeaderText text={ub().description} class="block text-xs text-text-secondary leading-relaxed" />
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
                  <p class="flex items-center gap-1.5 text-sm text-text-primary font-medium">
                    <Show when={ui().iconUrl}>
                      {icon => (
                        <img
                          src={icon()}
                          alt={ui().name}
                          class="h-4 w-4 shrink-0"
                          onError={(event) => { event.currentTarget.style.display = 'none' }}
                        />
                      )}
                    </Show>
                    <span>{ui().name}</span>
                  </p>
                  <RichLeaderText text={ui().description} class="block text-xs text-text-secondary leading-relaxed" />
                </div>
              )}
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}
