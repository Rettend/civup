import type { Leader } from '@civup/game'

export type LeaderTagCategory = 'econ' | 'win' | 'spike' | 'role' | 'other'

export interface LeaderTagMeta {
  id: string
  category: LeaderTagCategory
  label: string
  showIcon: boolean
  iconToken?: string
  iconUrl?: string
  textColor: string
  bgColor: string
  borderColor: string
}

export type TagFilterState = Record<LeaderTagCategory, string[]>

export const TAG_CATEGORY_ORDER: LeaderTagCategory[] = ['econ', 'win', 'spike', 'role', 'other']

export const TAG_CATEGORY_LABELS: Record<LeaderTagCategory, string> = {
  econ: 'Economy',
  win: 'Win Path',
  spike: 'Power Spike',
  role: 'Role',
  other: 'Other',
}

const TAG_META: Record<string, LeaderTagMeta> = {
  'econ:gold': {
    id: 'econ:gold',
    category: 'econ',
    label: 'Gold',
    showIcon: true,
    iconToken: 'gold',
    textColor: '#d7b46a',
    bgColor: 'rgba(215, 180, 106, 0.14)',
    borderColor: 'rgba(215, 180, 106, 0.28)',
  },
  'econ:faith': {
    id: 'econ:faith',
    category: 'econ',
    label: 'Faith',
    showIcon: true,
    iconToken: 'faith',
    textColor: '#9ab1ff',
    bgColor: 'rgba(154, 177, 255, 0.14)',
    borderColor: 'rgba(154, 177, 255, 0.28)',
  },
  'econ:production': {
    id: 'econ:production',
    category: 'econ',
    label: 'Production',
    showIcon: true,
    iconToken: 'production',
    textColor: '#d59662',
    bgColor: 'rgba(213, 150, 98, 0.14)',
    borderColor: 'rgba(213, 150, 98, 0.28)',
  },
  'econ:food': {
    id: 'econ:food',
    category: 'econ',
    label: 'Food',
    showIcon: true,
    iconToken: 'food',
    textColor: '#87c977',
    bgColor: 'rgba(135, 201, 119, 0.14)',
    borderColor: 'rgba(135, 201, 119, 0.28)',
  },

  'win:domination': {
    id: 'win:domination',
    category: 'win',
    label: 'Domination',
    showIcon: true,
    iconToken: 'greatgeneral',
    textColor: '#e07a6d',
    bgColor: 'rgba(224, 122, 109, 0.14)',
    borderColor: 'rgba(224, 122, 109, 0.28)',
  },
  'win:science': {
    id: 'win:science',
    category: 'win',
    label: 'Science',
    showIcon: true,
    iconToken: 'science',
    textColor: '#7db8ff',
    bgColor: 'rgba(125, 184, 255, 0.14)',
    borderColor: 'rgba(125, 184, 255, 0.28)',
  },
  'win:culture': {
    id: 'win:culture',
    category: 'win',
    label: 'Culture',
    showIcon: true,
    iconToken: 'culture',
    textColor: '#c69bff',
    bgColor: 'rgba(198, 155, 255, 0.14)',
    borderColor: 'rgba(198, 155, 255, 0.28)',
  },

  'spike:early': {
    id: 'spike:early',
    category: 'spike',
    label: 'Early',
    showIcon: false,
    textColor: '#dde5f2',
    bgColor: 'rgba(188, 205, 232, 0.18)',
    borderColor: 'rgba(188, 205, 232, 0.36)',
  },
  'spike:mid': {
    id: 'spike:mid',
    category: 'spike',
    label: 'Mid',
    showIcon: false,
    textColor: '#dde5f2',
    bgColor: 'rgba(188, 205, 232, 0.18)',
    borderColor: 'rgba(188, 205, 232, 0.36)',
  },
  'spike:late': {
    id: 'spike:late',
    category: 'spike',
    label: 'Late',
    showIcon: false,
    textColor: '#dde5f2',
    bgColor: 'rgba(188, 205, 232, 0.18)',
    borderColor: 'rgba(188, 205, 232, 0.36)',
  },

  'role:frontline': {
    id: 'role:frontline',
    category: 'role',
    label: 'Frontline',
    showIcon: false,
    textColor: '#dde5f2',
    bgColor: 'rgba(188, 205, 232, 0.18)',
    borderColor: 'rgba(188, 205, 232, 0.36)',
  },
  'role:backline': {
    id: 'role:backline',
    category: 'role',
    label: 'Backline',
    showIcon: false,
    textColor: '#dde5f2',
    bgColor: 'rgba(188, 205, 232, 0.18)',
    borderColor: 'rgba(188, 205, 232, 0.36)',
  },
  'role:flex': {
    id: 'role:flex',
    category: 'role',
    label: 'Flex',
    showIcon: false,
    textColor: '#dde5f2',
    bgColor: 'rgba(188, 205, 232, 0.18)',
    borderColor: 'rgba(188, 205, 232, 0.36)',
  },

  'other:cavalry': {
    id: 'other:cavalry',
    category: 'other',
    label: 'Cavalry',
    showIcon: true,
    iconUrl: '/assets/bbg/items/Tagma.webp',
    textColor: '#e5ad7f',
    bgColor: 'rgba(229, 173, 127, 0.14)',
    borderColor: 'rgba(229, 173, 127, 0.28)',
  },
  'other:naval': {
    id: 'other:naval',
    category: 'other',
    label: 'Naval',
    showIcon: true,
    iconUrl: '/assets/bbg/items/Sea Dog.webp',
    textColor: '#84c8ee',
    bgColor: 'rgba(132, 200, 238, 0.14)',
    borderColor: 'rgba(132, 200, 238, 0.28)',
  },
  'other:defense': {
    id: 'other:defense',
    category: 'other',
    label: 'Defense',
    showIcon: true,
    iconToken: 'district',
    textColor: '#89a7e8',
    bgColor: 'rgba(137, 167, 232, 0.22)',
    borderColor: 'rgba(137, 167, 232, 0.46)',
  },
  'other:diplo': {
    id: 'other:diplo',
    category: 'other',
    label: 'Diplo',
    showIcon: true,
    iconToken: 'envoy',
    textColor: '#96d6b0',
    bgColor: 'rgba(150, 214, 176, 0.14)',
    borderColor: 'rgba(150, 214, 176, 0.28)',
  },
  'other:greatpeople': {
    id: 'other:greatpeople',
    category: 'other',
    label: 'Great People',
    showIcon: true,
    iconToken: 'greatperson',
    textColor: '#d7a0e4',
    bgColor: 'rgba(215, 160, 228, 0.14)',
    borderColor: 'rgba(215, 160, 228, 0.28)',
  },
  'other:greatworks': {
    id: 'other:greatworks',
    category: 'other',
    label: 'Great Works',
    showIcon: true,
    iconToken: 'greatwork_writing',
    textColor: '#c892f0',
    bgColor: 'rgba(200, 146, 240, 0.14)',
    borderColor: 'rgba(200, 146, 240, 0.28)',
  },
}

const TAG_ORDER = [
  'econ:gold',
  'econ:faith',
  'econ:production',
  'econ:food',
  'win:domination',
  'win:science',
  'win:culture',
  'spike:early',
  'spike:mid',
  'spike:late',
  'role:frontline',
  'role:backline',
  'role:flex',
  'other:cavalry',
  'other:naval',
  'other:defense',
  'other:diplo',
  'other:greatpeople',
  'other:greatworks',
] as const

const TAG_ORDER_INDEX = new Map<string, number>(TAG_ORDER.map((tag, index) => [tag, index]))

/** Return parsed category from a namespaced tag string */
export function getTagCategory(tag: string): LeaderTagCategory | null {
  const [category] = tag.split(':')
  if (category === 'econ' || category === 'win' || category === 'spike' || category === 'role' || category === 'other') {
    return category
  }
  return null
}

/** Return display metadata for a known or unknown tag */
export function getLeaderTagMeta(tag: string): LeaderTagMeta {
  const known = TAG_META[tag]
  if (known) return known

  const category = getTagCategory(tag) ?? 'other'
  const value = tag.split(':')[1] ?? tag
  const label = value.slice(0, 1).toUpperCase() + value.slice(1)
  return {
    id: tag,
    category,
    label,
    showIcon: true,
    iconToken: 'district',
    textColor: '#c0c3cc',
    bgColor: 'rgba(192, 195, 204, 0.12)',
    borderColor: 'rgba(192, 195, 204, 0.24)',
  }
}

/** Build grouped filter options from tags currently present in leader data */
export function getFilterTagOptions(leaders: Leader[]): Record<LeaderTagCategory, LeaderTagMeta[]> {
  const options: Record<LeaderTagCategory, LeaderTagMeta[]> = {
    econ: [],
    win: [],
    spike: [],
    role: [],
    other: [],
  }

  const seen = new Set<string>()
  for (const leader of leaders) {
    for (const tag of leader.tags) {
      if (seen.has(tag)) continue
      seen.add(tag)
      const meta = getLeaderTagMeta(tag)
      options[meta.category].push(meta)
    }
  }

  for (const category of TAG_CATEGORY_ORDER) {
    options[category].sort((a, b) => {
      const indexA = TAG_ORDER_INDEX.get(a.id) ?? Number.MAX_SAFE_INTEGER
      const indexB = TAG_ORDER_INDEX.get(b.id) ?? Number.MAX_SAFE_INTEGER
      return indexA - indexB
    })
  }

  return options
}

/** Fresh empty filter state object */
export function createEmptyTagFilters(): TagFilterState {
  return {
    econ: [],
    win: [],
    spike: [],
    role: [],
    other: [],
  }
}

/** OR within category, AND across categories */
export function leaderMatchesTagFilters(leaderTags: string[], filters: TagFilterState): boolean {
  for (const category of TAG_CATEGORY_ORDER) {
    const selected = filters[category]
    if (selected.length === 0) continue
    const matchesCategory = selected.some(tag => leaderTags.includes(tag))
    if (!matchesCategory) return false
  }

  return true
}

/** Total selected tag count across categories */
export function countActiveTagFilters(filters: TagFilterState): number {
  let total = 0
  for (const category of TAG_CATEGORY_ORDER) {
    total += filters[category].length
  }
  return total
}
