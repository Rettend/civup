import type { Leader } from './types.ts'

const RD_PORTRAIT_CACHE_BUSTER = '2'

export const factions: Leader[] = [
  {
    id: 'rd-aliens',
    name: 'Aliens',
    civilization: 'Undercover Aliens',
    portraitUrl: `/assets/rd/leaders/aliens.webp?v=${RD_PORTRAIT_CACHE_BUSTER}`,
    fullPortraitUrl: '/assets/rd/leaders-full/aliens.webp',
    ability: {
      name: 'Xenological Camouflage',
      description: 'All units can use Xenological Camouflage to become invisible to most units. Adjacent enemy units can see Camouflaged units. Attacking deactivates Xenological Camouflage. Xenological Camouflage lasts for 6 turns and takes 6 turns to recharge. If a unit attacks while camouflaged it gains +5 :strength: combat strength.',
    },
    secondaryAbility: {
      name: 'Xenological Regeneration',
      description: 'All units heal every turn outside of water, Red Death, or WMD fallout regardless of movement or actions. Aliens heal 50% slower.',
    },
    uniqueUnits: [],
    tags: [],
  },
  {
    id: 'rd-cultists',
    name: 'Cultists',
    civilization: 'Deeply Invested Cultists',
    portraitUrl: `/assets/rd/leaders/cultists.webp?v=${RD_PORTRAIT_CACHE_BUSTER}`,
    fullPortraitUrl: '/assets/rd/leaders-full/cultists.webp',
    ability: {
      name: 'The Undying Eye',
      description: 'Cultists start the game with a crippled GDR that they worship. The GDR starts heavily damaged and does not heal or gain experience normally. The GDR earns promotions by the willing sacrifice of adjacent Cultist units.',
    },
    secondaryAbility: {
      name: 'Observing The End',
      description: 'All units have +2 sight.',
    },
    uniqueUnits: [],
    tags: [],
  },
  {
    id: 'rd-borderlords',
    name: 'Borderlords',
    civilization: 'Very Goth Borderlords',
    portraitUrl: `/assets/rd/leaders/borderlords.webp?v=${RD_PORTRAIT_CACHE_BUSTER}`,
    fullPortraitUrl: '/assets/rd/leaders-full/borderlords.webp',
    ability: {
      name: 'Grieving Gift',
      description: 'As a free action, any Borderlord unit can designate a hex for a booby trapped Grieving Gift on the next turn. The Grieving Gift will look like a normal Supply Drop to all other players. The Borderlords can store up to two Grieving Gifts and they take 5 turns to recharge.',
    },
    secondaryAbility: {
      name: 'Living on the Edge',
      description: '+10 :strength: Combat Strength when 3 hexes or closer to the Safe Zone border.',
    },
    uniqueUnits: [],
    tags: [],
  },
  {
    id: 'rd-jocks',
    name: 'Jocks',
    civilization: 'Meanest Jocks',
    portraitUrl: `/assets/rd/leaders/jocks.webp?v=${RD_PORTRAIT_CACHE_BUSTER}`,
    fullPortraitUrl: '/assets/rd/leaders-full/jocks.webp',
    ability: {
      name: 'Hail Mary Pass',
      description: 'Lob a "Hail Mary" small tactical nuke from any combat unit every 8 turns.',
    },
    secondaryAbility: {
      name: 'Witness Perfection',
      description: '+5 :strength: Combat Strength.',
    },
    uniqueUnits: [],
    tags: [],
  },
  {
    id: 'rd-mutants',
    name: 'Mutants',
    civilization: 'Horribly Scarred Mutants',
    portraitUrl: `/assets/rd/leaders/mutants.webp?v=${RD_PORTRAIT_CACHE_BUSTER}`,
    fullPortraitUrl: '/assets/rd/leaders-full/mutants.webp',
    ability: {
      name: 'Radiant Personalities',
      description: 'Mutant units absorb 5 Radiation Charges per turn starting in the Red Death or WMD fallout. Mutant units spread Red Death to non-contaminated hexes once per Radiation Charge. Mutant units do not take damage from Mutant spread Red Death.',
    },
    secondaryAbility: {
      name: 'Radioactive Movement',
      description: '+3 :movement: Movement for all units in the Red Death. -50% Red Death damage.',
    },
    uniqueUnits: [],
    tags: [],
  },
  {
    id: 'rd-pirates',
    name: 'Pirates',
    civilization: 'Irradiated Pirates',
    portraitUrl: `/assets/rd/leaders/pirates.webp?v=${RD_PORTRAIT_CACHE_BUSTER}`,
    fullPortraitUrl: '/assets/rd/leaders-full/pirates.webp',
    ability: {
      name: 'Buried Treasure',
      description: 'Pirates start the game with a buried treasure map represented by an additional supply drop on the map. Pirates get a special reward and a new buried treasure map by visiting that location. As a free action, Pirates can burn their treasure map and get a new one every 6 turns.',
    },
    secondaryAbility: {
      name: 'Water Logged',
      description: 'All units ignore additional movement cost from embarking and disembarking.',
    },
    uniqueUnits: [],
    tags: [],
  },
  {
    id: 'rd-preppers',
    name: 'Doomsday Preppers',
    civilization: 'Insane Doomsday Preppers',
    portraitUrl: `/assets/rd/leaders/preppers.webp?v=${RD_PORTRAIT_CACHE_BUSTER}`,
    fullPortraitUrl: '/assets/rd/leaders-full/preppers.webp',
    ability: {
      name: 'Improvised Traps',
      description: 'All Prepper units can build a limited number of Improvised Trap improvements. Improvised Traps explode and deal 25 damage if any unit moves onto the hex. Preppers find more Improvised Traps by exploring City Ruins, Raider Camps, or Supply Drops. Improvised Traps are invisible to all other factions.',
    },
    secondaryAbility: {
      name: 'Always Prepare for the Worst',
      description: 'All units have +100% experience bonus.',
    },
    uniqueUnits: [],
    tags: [],
  },
  {
    id: 'rd-scientists',
    name: 'Mad Scientists',
    civilization: 'Ethically Challenged Scientists',
    portraitUrl: `/assets/rd/leaders/scientists.webp?v=${RD_PORTRAIT_CACHE_BUSTER}`,
    fullPortraitUrl: '/assets/rd/leaders-full/scientists.webp',
    ability: {
      name: 'Defensive Inertial Shielding',
      description: 'All units can deploy Defensive Inertial Shielding that provides a +10 :strength: Combat Strength while defending. Shielding also provides full immunity to water, Red Death, and WMD blast damage. Defensive Inertial Shielding lasts for 4 turns and takes 6 turns to recharge.',
    },
    secondaryAbility: {
      name: 'This Will Only Hurt a Bit',
      description: 'All units heal 2x faster.',
    },
    uniqueUnits: [],
    tags: [],
  },
  {
    id: 'rd-wanderers',
    name: 'Wanderers',
    civilization: 'Free Willed Wanderers',
    portraitUrl: `/assets/rd/leaders/wanderers.webp?v=${RD_PORTRAIT_CACHE_BUSTER}`,
    fullPortraitUrl: '/assets/rd/leaders-full/wanderers.webp',
    ability: {
      name: 'Road Vision',
      description: 'As a free action, any unit can reveal all previously explored hexes for 1 turn. Recharging takes 5 turns.',
    },
    secondaryAbility: {
      name: 'See You Later',
      description: 'Infantry, AT Crews, and Machine Gunners, as well as Civilians in formation with them, have faster :movement: Movement on Woods, Rainforest, and Hill terrain.',
    },
    uniqueUnits: [],
    tags: [],
  },
  {
    id: 'rd-zombies',
    name: 'Zombies',
    civilization: 'Zombie Beastmasters',
    portraitUrl: `/assets/rd/leaders/zombies.webp?v=${RD_PORTRAIT_CACHE_BUSTER}`,
    fullPortraitUrl: '/assets/rd/leaders-full/zombies.webp',
    ability: {
      name: 'Barely Weaponized Zombies',
      description: 'Zombie Beastmasters have replaced all combat units with barely controlled Zombie Hordes. City Ruins, Raider Camps, and Supply Drops grant additional Zombie Hordes instead of traditional units. Zombie Hordes create a new Zombie Horde when they combat kill a non-zombie enemy unit. Zombie Hordes do not suffer combat penalties when damaged.',
    },
    secondaryAbility: {
      name: 'Brains!',
      description: 'Zombie Hordes do not heal normally and take damage slowly over time. Zombie Hordes heal when they kill units or get promoted. City Ruins, Raider Camps, and Supply Drops also heal Zombie Hordes. Zombie Hordes can sense the closest unseen enemy unit up to 8 hexes away. Zombie Hordes have +5 :strength: Combat Strength when defending against ranged attacks.',
    },
    uniqueUnits: [],
    tags: [],
  },
]

export const factionMap = new Map<string, Leader>(
  factions.map(faction => [faction.id, faction]),
)

export const allFactionIds = factions.map(faction => faction.id)

export function getFaction(id: string): Leader {
  const faction = factionMap.get(id)
  if (!faction) throw new Error(`Faction not found: ${id}`)
  return faction
}

export function searchFactions(query: string): Leader[] {
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return [...factions]

  return factions.filter(faction =>
    faction.name.toLowerCase().includes(normalizedQuery)
    || faction.civilization.toLowerCase().includes(normalizedQuery)
    || faction.ability.name.toLowerCase().includes(normalizedQuery)
    || faction.secondaryAbility?.name.toLowerCase().includes(normalizedQuery),
  )
}
