import type { Leader } from './types.ts'

/**
 * Leader data for Civ 6 with BBG (Better Balanced Game) balance.
 *
 * This is a placeholder with a few example leaders to establish the data structure.
 * The full leader pool (~50+ leaders with BBG/BBM/BBG Expanded data) will be populated
 * from the BBG patch notes and Civ 6 game data.
 */
export const leaders: Leader[] = [
  {
    id: 'alexander',
    name: 'Alexander',
    civilization: 'Macedon',
    ability: {
      name: 'To the World\'s End',
      description: 'Cities do not incur war weariness. All military units heal completely when a city with a Wonder is captured.',
    },
    uniqueUnits: [
      { name: 'Hypaspist', description: '+5 Combat Strength when besieging districts. +10 Combat Strength when attacking districts.', replaces: 'Swordsman' },
      { name: 'Hetairoi', description: 'Additional +5 Combat Strength when adjacent to a Great General. Great General points on kill.', replaces: 'Horseman' },
    ],
    uniqueBuilding: { name: 'Basilikoi Paides', description: '+25% combat experience for all melee, ranged, and Hetairoi units trained in this city. Gain Science equal to 25% of the unit\'s cost when a non-civilian unit is trained.', replaces: 'Barracks' },
    tags: ['domination'],
  },
  {
    id: 'cleopatra',
    name: 'Cleopatra',
    civilization: 'Egypt',
    ability: {
      name: 'Mediterranean\'s Bride',
      description: 'Trade Routes to other civilizations provide +4 Gold. Trade Routes from other civs provide +2 Food and +2 Gold.',
    },
    uniqueUnits: [
      { name: 'Maryannu Chariot Archer', description: '4 Movement when starting in open terrain. Ranged unit.', replaces: 'Heavy Chariot' },
    ],
    uniqueImprovement: { name: 'Sphinx', description: '+1 Faith, +1 Culture. +2 Faith if adjacent to a Wonder. Cannot be built next to another Sphinx.' },
    tags: ['culture', 'diplomatic'],
  },
  {
    id: 'gandhi',
    name: 'Gandhi',
    civilization: 'India',
    ability: {
      name: 'Satyagraha',
      description: '+5 Faith for each civilization (including India) that has founded a religion and is not at war. Enemies receive double war weariness penalties for fighting against Gandhi.',
    },
    uniqueUnits: [
      { name: 'Varu', description: 'Adjacent enemy units have -5 Combat Strength.', replaces: 'Knight' },
    ],
    uniqueBuilding: { name: 'Stepwell', description: '+1 Food, +1 Housing. +1 Faith if adjacent to a Holy Site. +1 Food if adjacent to a Farm.' },
    tags: ['religion', 'diplomatic'],
  },
  {
    id: 'gilgamesh',
    name: 'Gilgamesh',
    civilization: 'Sumeria',
    ability: {
      name: 'Adventures with Enkidu',
      description: 'May declare War of Retribution against anyone at war with an Ally without warmonger penalties. Shares pillage rewards and combat experience with the closest allied unit within 5 tiles.',
    },
    uniqueUnits: [
      { name: 'War-Cart', description: 'No penalties against anti-cavalry units. +4 Combat Strength if there is at least one adjacent ally unit.', replaces: 'Heavy Chariot' },
    ],
    uniqueBuilding: { name: 'Ziggurat', description: '+2 Science. +1 Culture if adjacent to a river. Cannot be built on a hill.' },
    tags: ['domination', 'science'],
  },
  {
    id: 'hojo',
    name: 'Hojo Tokimune',
    civilization: 'Japan',
    ability: {
      name: 'Divine Wind',
      description: 'Land units receive +5 Combat Strength in land tiles adjacent to coast. Naval units receive +5 Combat Strength in shallow water. Districts, improvements, and units build 50% faster in tiles adjacent to another District.',
    },
    uniqueUnits: [
      { name: 'Samurai', description: 'Does not suffer combat penalties when damaged.', replaces: 'Man-At-Arms' },
    ],
    uniqueBuilding: { name: 'Electronics Factory', description: '+4 Production to all city centers within 6 tiles. +4 Culture once Electricity is researched.', replaces: 'Factory' },
    tags: ['domination', 'culture'],
  },
  {
    id: 'peter',
    name: 'Peter',
    civilization: 'Russia',
    ability: {
      name: 'The Grand Embassy',
      description: 'Trade Routes to civilizations that are more advanced than Russia provide +1 Science for every 3 technologies that civilization is ahead. +1 Culture for every 3 civics.',
    },
    uniqueUnits: [
      { name: 'Cossack', description: '+5 Combat Strength when in or adjacent to home territory. Can move after attacking.', replaces: 'Cavalry' },
    ],
    uniqueBuilding: { name: 'Lavra', description: 'Gains an extra Great Prophet point, Great Writer point, Great Artist point, and Great Musician point per turn.', replaces: 'Holy Site' },
    tags: ['religion', 'culture'],
  },
  {
    id: 'pericles',
    name: 'Pericles',
    civilization: 'Greece',
    ability: {
      name: 'Surrounded by Glory',
      description: '+5% Culture per city-state that Greece is Suzerain of.',
    },
    uniqueUnits: [
      { name: 'Hoplite', description: '+10 Combat Strength if there is at least one adjacent Hoplite unit.', replaces: 'Spearman' },
    ],
    uniqueBuilding: { name: 'Acropolis', description: '+1 Culture for each adjacent District. +1 Culture for each adjacent Wonder. Must be built on a hill.', replaces: 'Theater Square' },
    tags: ['culture', 'diplomatic'],
  },
  {
    id: 'saladin',
    name: 'Saladin',
    civilization: 'Arabia',
    ability: {
      name: 'Righteousness of the Faith',
      description: 'The Worship building for Arabia\'s Religion is 90% cheaper. This building provides Arabian cities +10% Science, Faith, and Culture.',
    },
    uniqueUnits: [
      { name: 'Mamluk', description: 'Heals at the end of every turn, even after moving or attacking.', replaces: 'Knight' },
    ],
    uniqueBuilding: { name: 'Madrasa', description: '+5 Science. Bonus Faith equal to the adjacency bonus of this district.', replaces: 'University' },
    tags: ['science', 'religion'],
  },
  {
    id: 'victoria',
    name: 'Victoria',
    civilization: 'England',
    ability: {
      name: 'Pax Britannica',
      description: 'Gain a free melee unit when settling a city on a continent other than your home continent. Building a Royal Navy Dockyard grants bonus movement to units built there.',
    },
    uniqueUnits: [
      { name: 'Redcoat', description: '+10 Combat Strength when fighting on a continent other than your capital\'s.', replaces: 'Line Infantry' },
      { name: 'Sea Dog', description: 'Can capture enemy naval units.', replaces: 'Privateer' },
    ],
    uniqueBuilding: { name: 'Royal Navy Dockyard', description: '+1 Movement for all units built in this city. +2 Gold on foreign continents. +4 Gold for every Dockyard in a foreign city.', replaces: 'Harbor' },
    tags: ['domination', 'science'],
  },
  {
    id: 'montezuma',
    name: 'Montezuma',
    civilization: 'Aztec',
    ability: {
      name: 'Gifts for the Tlatoani',
      description: 'Luxury resources in Aztec territory provide +1 Amenity to 2 extra cities. Military units receive +1 Combat Strength for each different improved luxury resource.',
    },
    uniqueUnits: [
      { name: 'Eagle Warrior', description: 'Has a chance to capture defeated enemies as Builders.', replaces: 'Warrior' },
    ],
    uniqueBuilding: { name: 'Tlachtli', description: '+2 Faith, +1 Great General point per turn, +1 Amenity.', replaces: 'Arena' },
    tags: ['domination'],
  },
]

/** Map of leader ID to leader data for quick lookup */
export const leaderMap = new Map<string, Leader>(
  leaders.map(l => [l.id, l]),
)

/** All leader IDs (the default civ pool) */
export const allLeaderIds = leaders.map(l => l.id)

/** Get a leader by ID, throws if not found */
export function getLeader(id: string): Leader {
  const leader = leaderMap.get(id)
  if (!leader)
    throw new Error(`Leader not found: ${id}`)
  return leader
}

/** Search leaders by name or civilization (case-insensitive) */
export function searchLeaders(query: string): Leader[] {
  const q = query.toLowerCase()
  return leaders.filter(l =>
    l.name.toLowerCase().includes(q)
    || l.civilization.toLowerCase().includes(q),
  )
}
