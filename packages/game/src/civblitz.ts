import type {
  CivBlitzComponent,
  CivBlitzComponentCategory,
  CivBlitzComponentPools,
  Leader,
  LeaderDataVersion,
  LeaderUnique,
} from './types.ts'
import { CIV_BLITZ_CATEGORIES } from './types.ts'
import { getLeaders } from './leader-registry.ts'

export const CIV_BLITZ_DEFAULT_OPTION_COUNT = 4
export const CIV_BLITZ_MIN_OPTION_COUNT = 4
export const CIV_BLITZ_MAX_OPTION_COUNT = 8

const BBG_EXPANDED_CIV_BLITZ_SOURCE_LEADER_IDS = [] as const satisfies readonly string[]

export interface CivBlitzRegistry {
  components: CivBlitzComponent[]
  componentMap: Map<string, CivBlitzComponent>
  componentPools: CivBlitzComponentPools
}

export function normalizeCivBlitzOptionCount(value: unknown, fallback = CIV_BLITZ_DEFAULT_OPTION_COUNT): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.round(value)
  if (rounded < CIV_BLITZ_MIN_OPTION_COUNT || rounded > CIV_BLITZ_MAX_OPTION_COUNT) return fallback
  return rounded
}

export function getCivBlitzRegistry(
  version: LeaderDataVersion = 'live',
  options: { excludeBbgExpanded?: boolean } = {},
): CivBlitzRegistry {
  const excludedLeaderIds = options.excludeBbgExpanded === false
    ? new Set<string>()
    : new Set<string>(BBG_EXPANDED_CIV_BLITZ_SOURCE_LEADER_IDS)
  const leaders = getLeaders(version).filter(leader => !excludedLeaderIds.has(leader.id))
  const components: CivBlitzComponent[] = []
  const componentMap = new Map<string, CivBlitzComponent>()
  const pools = createEmptyComponentPools()

  const addComponent = (component: CivBlitzComponent) => {
    if (componentMap.has(component.id)) return
    componentMap.set(component.id, component)
    components.push(component)
    pools[component.category].push(component.id)
  }

  const civAbilityCivilizations = new Set<string>()
  for (const leader of leaders) {
    if (!civAbilityCivilizations.has(leader.civilization)) {
      civAbilityCivilizations.add(leader.civilization)
      addComponent({
        id: createComponentId('civilizationAbility', leader.civilization),
        category: 'civilizationAbility',
        name: `${leader.civilization}: ${leader.civilizationAbility.name}`,
        description: leader.civilizationAbility.description,
        sourceLeaderId: leader.id,
        civilization: leader.civilization,
        portraitUrl: leader.portraitUrl,
      })
    }

    addComponent({
      id: createComponentId('leaderAbility', leader.id),
      category: 'leaderAbility',
      name: `${leader.name}: ${leader.ability.name}`,
      description: leader.ability.description,
      sourceLeaderId: leader.id,
      civilization: leader.civilization,
      portraitUrl: leader.portraitUrl,
    })

    for (const unique of [...leader.uniqueBuildings, ...leader.uniqueImprovements]) {
      addUniqueComponent(addComponent, leader, 'infrastructure', unique)
    }
    for (const unique of leader.uniqueUnits) {
      addUniqueComponent(addComponent, leader, 'unit', unique)
    }
  }

  return { components, componentMap, componentPools: pools }
}

export function getCivBlitzComponent(
  id: string,
  version: LeaderDataVersion = 'live',
  options: { excludeBbgExpanded?: boolean } = {},
): CivBlitzComponent | null {
  return getCivBlitzRegistry(version, options).componentMap.get(id) ?? null
}

export function getCivBlitzComponentIds(
  version: LeaderDataVersion = 'live',
  options: { excludeBbgExpanded?: boolean } = {},
): string[] {
  return getCivBlitzRegistry(version, options).components.map(component => component.id)
}

function addUniqueComponent(
  addComponent: (component: CivBlitzComponent) => void,
  leader: Leader,
  category: Extract<CivBlitzComponentCategory, 'infrastructure' | 'unit'>,
  unique: LeaderUnique,
) {
  addComponent({
    id: createComponentId(category, unique.name),
    category,
    name: unique.name,
    description: unique.description,
    sourceLeaderId: leader.id,
    civilization: leader.civilization,
    iconUrl: unique.iconUrl,
    portraitUrl: leader.portraitUrl,
    replaces: unique.replaces,
  })
}

function createEmptyComponentPools(): CivBlitzComponentPools {
  return {
    civilizationAbility: [],
    leaderAbility: [],
    infrastructure: [],
    unit: [],
  }
}

function createComponentId(category: CivBlitzComponentCategory, value: string): string {
  return `civblitz:${category}:${slug(value)}`
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export { CIV_BLITZ_CATEGORIES }
