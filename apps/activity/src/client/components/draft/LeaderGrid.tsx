import { leaders, searchLeaders } from '@civup/game'
import { createMemo, For } from 'solid-js'
import { cn } from '~/client/lib/cn'
import { searchQuery, setSearchQuery, setTagFilter, tagFilter } from '~/client/stores'
import { LeaderCard } from './LeaderCard'

/** All unique tags across leaders */
const ALL_TAGS = [...new Set(leaders.flatMap(l => l.tags))].sort()

/** The center grid of available leaders with search and tag filter */
export function LeaderGrid() {
  const filteredLeaders = createMemo(() => {
    const query = searchQuery()
    const tag = tagFilter()

    let result = query ? searchLeaders(query) : [...leaders]

    if (tag) {
      result = result.filter(l => l.tags.includes(tag))
    }

    return result.sort((a, b) => a.name.localeCompare(b.name))
  })

  return (
    <div class="h-full min-w-0 flex flex-col">
      {/* Search + filter bar */}
      <div class="flex items-center gap-2 border-b border-border-subtle px-3 py-2">
        <div class="relative flex-1">
          <input
            type="text"
            placeholder="Search leaders..."
            value={searchQuery()}
            onInput={e => setSearchQuery(e.currentTarget.value)}
            class={cn(
              'w-full bg-bg-secondary border border-border-subtle rounded-md',
              'px-3 py-1.5 text-sm text-text-primary placeholder-text-muted',
              'focus:outline-none focus:border-accent-gold/50',
              'transition-colors',
            )}
          />
        </div>

        {/* Tag filters */}
        <div class="flex gap-1">
          <For each={ALL_TAGS}>
            {tag => (
              <button
                class={cn(
                  'px-2 py-1 rounded text-xs capitalize transition-colors cursor-pointer',
                  tagFilter() === tag
                    ? 'bg-accent-gold/20 text-accent-gold'
                    : 'text-text-muted hover:text-text-secondary hover:bg-bg-hover',
                )}
                onClick={() => setTagFilter(prev => prev === tag ? null : tag)}
              >
                {tag}
              </button>
            )}
          </For>
        </div>
      </div>

      {/* Leader grid */}
      <div class="flex-1 overflow-y-auto p-3">
        <div class="grid grid-cols-[repeat(auto-fill,minmax(5.5rem,1fr))] gap-2">
          <For each={filteredLeaders()}>
            {leader => <LeaderCard leader={leader} />}
          </For>
        </div>
      </div>
    </div>
  )
}
