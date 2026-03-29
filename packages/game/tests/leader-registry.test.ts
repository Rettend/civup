import { describe, expect, test } from 'bun:test'
import { allLeaderIds, getFaction, getLeader, getLeaders } from '../src/index.ts'
import { leaders as betaLeaders } from '../src/leaders-beta.ts'
import { leaders as liveLeaders } from '../src/leaders.ts'

describe('leader registry', () => {
  test('beta roster keeps the same leader ids and order as live', () => {
    expect(getLeaders('beta').map(leader => leader.id)).toEqual(allLeaderIds)
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
