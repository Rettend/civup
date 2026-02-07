import { createSignal } from 'solid-js'

// ── UI State ───────────────────────────────────────────────

/** Currently hovered leader ID (for detail panel) */
const [hoveredLeader, setHoveredLeader] = createSignal<string | null>(null)

/** Currently selected leader ID (clicked, pending confirm) */
const [selectedLeader, setSelectedLeader] = createSignal<string | null>(null)

/** Search query for leader grid filter */
const [searchQuery, setSearchQuery] = createSignal('')

/** Active tag filter */
const [tagFilter, setTagFilter] = createSignal<string | null>(null)

/** Selected civ IDs for blind ban (multi-select) */
const [banSelections, setBanSelections] = createSignal<string[]>([])

export {
  banSelections,
  hoveredLeader,
  searchQuery,
  selectedLeader,
  setBanSelections,
  setHoveredLeader,
  setSearchQuery,
  setSelectedLeader,
  setTagFilter,
  tagFilter,
}

// ── Actions ────────────────────────────────────────────────

/** Toggle a civ in the ban selection list */
export function toggleBanSelection(civId: string, maxBans: number) {
  setBanSelections((prev) => {
    if (prev.includes(civId)) {
      return prev.filter(id => id !== civId)
    }
    if (prev.length >= maxBans) return prev
    return [...prev, civId]
  })
}

/** Clear all UI selection state (called on step advance) */
export function clearSelections() {
  setSelectedLeader(null)
  setHoveredLeader(null)
  setBanSelections([])
  setSearchQuery('')
  setTagFilter(null)
}
