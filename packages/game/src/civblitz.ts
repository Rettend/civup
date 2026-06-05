import type {
  CivBlitzComponent,
  CivBlitzComponentCategory,
  CivBlitzComponentPools,
  DraftStep,
  Leader,
  LeaderDataVersion,
  LeaderUnique,
} from './types.ts'
import { CIV_BLITZ_CATEGORIES, LEADER_DATA_VERSIONS } from './types.ts'
import { getLeaders } from './leader-registry.ts'

export const CIV_BLITZ_DEFAULT_OPTION_COUNT = 4
export const CIV_BLITZ_MIN_OPTION_COUNT = 2

const BBG_EXPANDED_CIV_BLITZ_SOURCE_LEADER_IDS = [
  'austria-maria-theresa',
  'gaul-vercingetorix',
  'goths-theodoric',
  'macedon-olympias',
  'maya-te-k-inich-ii',
  'phoenicia-ahiram',
  'poland-stanislaw-ii',
  'swahili-al-hasan-ibn-sulaiman',
  'taino-anacaona',
  'teotihuacan-spearthrower-owl',
  'thule-kiviuq',
  'tibet-trisong-detsen',
] as const satisfies readonly string[]

const CIVILIZATION_ICON_FILES: Record<string, string> = {
  America: 'American.png',
  Arabia: 'Arabian.png',
  Australia: 'Australian.png',
  Austria: 'Austria.webp',
  Aztec: 'Aztec.png',
  Babylon: 'Babylonian.png',
  Brazil: 'Brazilian.png',
  Byzantium: 'Byzantine.png',
  Canada: 'Canadian.png',
  China: 'Chinese.png',
  Cree: 'Cree.png',
  Egypt: 'Egyptian.png',
  England: 'English.png',
  Ethiopia: 'Ethiopian.png',
  France: 'French.png',
  Gaul: 'Gallic.png',
  Georgia: 'Georgian.png',
  Germany: 'German.png',
  Goths: 'Goths.webp',
  'Gran Colombia': 'Gran_Colombian.png',
  Greece: 'Greek.png',
  Hungary: 'Hungarian.png',
  Inca: 'Incan.png',
  India: 'Indian.png',
  Indonesia: 'Indonesian.png',
  Japan: 'Japanese.png',
  Khmer: 'Khmer.png',
  Kongo: 'Kongolese.png',
  Korea: 'Korean.png',
  Macedon: 'Macedonian.png',
  Mali: 'Malian.png',
  Māori: 'Maori.png',
  Mapuche: 'Mapuche.png',
  Maya: 'Mayan.png',
  Mongolia: 'Mongolian.png',
  Netherlands: 'Dutch.png',
  Norway: 'Norwegian.png',
  Nubia: 'Nubian.png',
  Ottomans: 'Ottoman.png',
  Persia: 'Persian.png',
  Phoenicia: 'Phoenician.png',
  Poland: 'Polish.png',
  Portugal: 'Portuguese.png',
  Rome: 'Roman.png',
  Russia: 'Russian.png',
  Scotland: 'Scottish.png',
  Scythia: 'Scythian.png',
  Spain: 'Spanish.png',
  Sumeria: 'Sumerian.png',
  Swahili: 'Swahili.webp',
  Sweden: 'Swedish.png',
  Taíno: 'Taino.webp',
  Teotihuacán: 'Teotihuacan.webp',
  Thule: 'Thule.webp',
  Tibet: 'Tibet.webp',
  Vietnam: 'Vietnamese.png',
  Zulu: 'Zulu.png',
}

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

export const CIV_BLITZ_MAX_OPTION_COUNT = Math.max(
  ...LEADER_DATA_VERSIONS.map(version => getCivBlitzOptionCountMaximum(version, { excludeBbgExpanded: false })),
)

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
        name: leader.civilizationAbility.name,
        description: leader.civilizationAbility.description,
        sourceLeaderId: leader.id,
        civilization: leader.civilization,
        iconUrl: getCivilizationIconUrl(leader.civilization),
        portraitUrl: leader.portraitUrl,
      })
    }

    addComponent({
      id: createComponentId('leaderAbility', leader.id),
      category: 'leaderAbility',
      name: leader.ability.name,
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

export function getCivBlitzOptionCountMaximum(
  version: LeaderDataVersion = 'live',
  options: { excludeBbgExpanded?: boolean } = {},
): number {
  const pools = getCivBlitzRegistry(version, options).componentPools
  return Math.max(CIV_BLITZ_MIN_OPTION_COUNT, ...CIV_BLITZ_CATEGORIES.map(category => pools[category].length))
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

export function getCivBlitzStepCategories(step: Pick<DraftStep, 'civBlitzCategories' | 'civBlitzCategoriesBySeat'>, seatIndex: number): CivBlitzComponentCategory[] {
  const seatCategories = step.civBlitzCategoriesBySeat?.[seatIndex]
  if (seatCategories && seatCategories.length > 0) return normalizeCivBlitzCategories(seatCategories)
  if (step.civBlitzCategories && step.civBlitzCategories.length > 0) return normalizeCivBlitzCategories(step.civBlitzCategories)
  return [...CIV_BLITZ_CATEGORIES]
}

export function normalizeCivBlitzCategories(categories: readonly CivBlitzComponentCategory[]): CivBlitzComponentCategory[] {
  const seen = new Set<CivBlitzComponentCategory>()
  const normalized: CivBlitzComponentCategory[] = []
  for (const category of categories) {
    if (!CIV_BLITZ_CATEGORIES.includes(category)) continue
    if (seen.has(category)) continue
    seen.add(category)
    normalized.push(category)
  }
  return normalized
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

function getCivilizationIconUrl(civilization: string): string | undefined {
  const file = CIVILIZATION_ICON_FILES[civilization]
  return file ? `/assets/bbg/civilizations/${file}` : undefined
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
