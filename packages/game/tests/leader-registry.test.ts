import { describe, expect, test } from 'bun:test'
import { allLeaderIds, CIV_BLITZ_MAX_OPTION_COUNT, getCivBlitzOptionCountMaximum, getCivBlitzRegistry, getFaction, getLeader, getLeaders } from '../src/index.ts'
import { leaders as betaLeaders } from '../src/leaders-beta.ts'
import { leaders as liveLeaders } from '../src/leaders.ts'

const betaOnlyLeaderIds = [
  'austria-maria-theresa',
  'goths-theodoric',
  'poland-stanislaw-ii',
  'taino-anacaona',
]

const bbgExpandedLeaderIds = [
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
]

describe('leader registry', () => {
  test('beta roster preserves live leader order and includes beta-only leaders', () => {
    const betaLeaderIds = getLeaders('beta').map(leader => leader.id)

    expect(betaLeaderIds.filter(id => allLeaderIds.includes(id))).toEqual(allLeaderIds)
    expect(betaOnlyLeaderIds.every(id => betaLeaderIds.includes(id))).toBe(true)
    expect(betaOnlyLeaderIds.some(id => allLeaderIds.includes(id))).toBe(false)
  })

  test('versioned lookup returns matching live and beta leader entries', () => {
    const liveLeader = getLeader('america-abraham-lincoln')
    const betaLeader = getLeader('america-abraham-lincoln', 'beta')

    expect(betaLeader.id).toBe(liveLeader.id)
    expect(betaLeader.name).toBe(liveLeader.name)
    expect(betaLeader.civilization).toBe(liveLeader.civilization)
  })

  test('leaders include civilization abilities and multiple district uniques', () => {
    const hammurabi = getLeader('babylon-hammurabi')
    const pedro = getLeader('brazil-pedro-ii')

    expect(hammurabi.civilizationAbility.name).toBe('Enuma Anu Enlil')
    expect(pedro.uniqueBuildings.map(unique => unique.name)).toEqual(['Street Carnival', 'Copacabana'])
  })

  test('CivBlitz leader ability components use ability names without leader prefixes', () => {
    const lincoln = getLeader('america-abraham-lincoln')
    const component = getCivBlitzRegistry().componentMap.get('civblitz:leaderAbility:america-abraham-lincoln')

    expect(component?.name).toBe(lincoln.ability.name)
    expect(component?.name).not.toContain(lincoln.name)
  })

  test('CivBlitz civilization ability components use civilization icons', () => {
    const registry = getCivBlitzRegistry()
    const expandedRegistry = getCivBlitzRegistry('beta', { excludeBbgExpanded: false })

    expect(registry.componentMap.get('civblitz:civilizationAbility:america')?.iconUrl).toBe('/assets/bbg/civilizations/American.png')
    expect(registry.componentMap.get('civblitz:civilizationAbility:netherlands')?.iconUrl).toBe('/assets/bbg/civilizations/Dutch.png')
    expect(expandedRegistry.componentMap.get('civblitz:civilizationAbility:austria')?.iconUrl).toBe('/assets/bbg/civilizations/Austria.webp')
    expect(expandedRegistry.components.find(component => component.category === 'civilizationAbility' && component.civilization === 'Teotihuacán')?.iconUrl).toBe('/assets/bbg/civilizations/Teotihuacan.webp')
  })

  test('CivBlitz excludes BBG Expanded source leaders by default', () => {
    const excludedRegistry = getCivBlitzRegistry('beta')
    const includedRegistry = getCivBlitzRegistry('beta', { excludeBbgExpanded: false })

    for (const leaderId of bbgExpandedLeaderIds) {
      expect(includedRegistry.components.some(component => component.sourceLeaderId === leaderId)).toBe(true)
      expect(excludedRegistry.components.some(component => component.sourceLeaderId === leaderId)).toBe(false)
    }
  })

  test('CivBlitz global option max covers beta BBG Expanded data', () => {
    expect(CIV_BLITZ_MAX_OPTION_COUNT).toBe(getCivBlitzOptionCountMaximum('beta', { excludeBbgExpanded: false }))
  })

  test('BBG Expanded 2.0 uniques have item icons', () => {
    const expectedIcons = [
      'Grenzer',
      'Coffee House',
      'Gadrauht',
      'Militōnd',
      'Hlaiw',
      'Uhlan',
      'Macana',
      'Batéy',
      'Conuco',
    ]
    const registry = getCivBlitzRegistry('beta', { excludeBbgExpanded: false })

    for (const name of expectedIcons) {
      const component = registry.components.find(component => component.name === name)
      expect(component?.iconUrl).toMatch(/^\/assets\/bbg\/items\//)
    }
  })

  test('Gaul does not include Dūnon in leader data or CivBlitz', () => {
    for (const version of ['live', 'beta'] as const) {
      for (const leaderId of ['gaul-ambiorix', 'gaul-vercingetorix']) {
        const leader = getLeader(leaderId, version)
        expect(leader.uniqueImprovements.map(unique => unique.name)).not.toContain('Dūnon')
      }

      const registry = getCivBlitzRegistry(version, { excludeBbgExpanded: false })
      expect(registry.components.some(component => component.name === 'Dūnon')).toBe(false)
    }
  })

  test('expanded leaders use BBG-updated descriptions', () => {
    const olympias = getLeader('macedon-olympias')
    const ahiram = getLeader('phoenicia-ahiram')
    const spearthrowerOwl = getLeader('teotihuacan-spearthrower-owl')

    expect(olympias.ability.description).toContain('Cities with a Basilikoi and Holy Site give 0.5 :science: science per :citizen: population')
    expect(ahiram.ability.description).toContain('International :traderoute: trade routes provides +0.5 :production: Production and +2 :gold: Gold')
    expect(spearthrowerOwl.ability.description).toContain('Pochteca Enclave and the Chancery')
  })

  test('all live and beta leaders have resolved civilization and leader abilities', () => {
    const assertResolvedAbilities = (label: string, leaderSet: typeof liveLeaders) => {
      const failures: string[] = []

      for (const leader of leaderSet) {
        if (!leader.civilizationAbility.name) failures.push(`${label}:${leader.id}: missing civilization ability name`)
        if (!leader.civilizationAbility.description) failures.push(`${label}:${leader.id}: missing civilization ability description`)
        if (!leader.ability.name) failures.push(`${label}:${leader.id}: missing leader ability name`)
        if (!leader.ability.description) failures.push(`${label}:${leader.id}: missing leader ability description`)

        if (leader.civilizationAbility.name.startsWith('LOC_')) failures.push(`${label}:${leader.id}: unresolved civilization ability name`)
        if (leader.civilizationAbility.description.startsWith('LOC_')) failures.push(`${label}:${leader.id}: unresolved civilization ability description`)
        if (leader.ability.name.startsWith('LOC_')) failures.push(`${label}:${leader.id}: unresolved leader ability name`)
        if (leader.ability.description.startsWith('LOC_')) failures.push(`${label}:${leader.id}: unresolved leader ability description`)
      }

      expect(failures).toEqual([])
    }

    assertResolvedAbilities('live', liveLeaders)
    assertResolvedAbilities('beta', betaLeaders)
  })

  test('red death factions are available through both faction and leader lookup', () => {
    const faction = getFaction('rd-aliens')
    const leader = getLeader('rd-aliens')

    expect(faction.id).toBe('rd-aliens')
    expect(leader.id).toBe('rd-aliens')
    expect(leader.civilizationAbility.name).toBe('Xenological Regeneration')
  })
})
