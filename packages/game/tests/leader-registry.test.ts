import { describe, expect, test } from 'bun:test'
import { allLeaderIds, getFaction, getLeader, getLeaders } from '../src/index.ts'

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

  test('red death factions are available through both faction and leader lookup', () => {
    const faction = getFaction('rd-aliens')
    const leader = getLeader('rd-aliens')

    expect(faction.id).toBe('rd-aliens')
    expect(leader.id).toBe('rd-aliens')
    expect(leader.secondaryAbility?.name).toBe('Xenological Regeneration')
  })
})
