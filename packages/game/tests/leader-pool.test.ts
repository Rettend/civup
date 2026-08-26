import { describe, expect, test } from 'bun:test'
import { formatLeaderPoolRankLabel, getDefaultLeaderPoolSize, getEligibleLeaderIds, getMaxLeaderPoolSize, getMinimumLeaderPoolSize, MAX_LEADER_POOL_SIZE, resolveAverageLeaderPoolRankTier, resolveLeaderPoolSize, sampleLeaderPool } from '../src/leader-pool.ts'
import { getLeaderIds } from '../src/leader-registry.ts'

describe('leader pool helpers', () => {
  test('uses rank5 versus defaults', () => {
    expect(getDefaultLeaderPoolSize('1v1', 2)).toBe(32)
    expect(getDefaultLeaderPoolSize('2v2', 4)).toBe(40)
    expect(getDefaultLeaderPoolSize('3v3', 6)).toBe(48)
    expect(getDefaultLeaderPoolSize('4v4', 8)).toBe(56)
  })

  test('reduces versus defaults by rank', () => {
    expect(getDefaultLeaderPoolSize('1v1', 2, 'live', 'tier4')).toBe(30)
    expect(getDefaultLeaderPoolSize('2v2', 4, 'live', 'tier3')).toBe(36)
    expect(getDefaultLeaderPoolSize('3v3', 6, 'live', 'tier2')).toBe(42)
    expect(getDefaultLeaderPoolSize('4v4', 8, 'live', 'tier1')).toBe(48)
  })

  test('scales FFA defaults with player count', () => {
    expect(getDefaultLeaderPoolSize('ffa', 6, 'live', 'tier3')).toBe(36)
    expect(getDefaultLeaderPoolSize('ffa', 8, 'live', 'tier3')).toBe(48)
    expect(getDefaultLeaderPoolSize('ffa', 10, 'live', 'tier3')).toBe(60)
  })

  test('scales FFA defaults around rank3', () => {
    expect(getDefaultLeaderPoolSize('ffa', 8, 'live', 'tier5')).toBe(52)
    expect(getDefaultLeaderPoolSize('ffa', 8, 'live', 'tier4')).toBe(50)
    expect(getDefaultLeaderPoolSize('ffa', 8, 'live', 'tier3')).toBe(48)
    expect(getDefaultLeaderPoolSize('ffa', 8, 'live', 'tier2')).toBe(46)
    expect(getDefaultLeaderPoolSize('ffa', 8, 'live', 'tier1')).toBe(44)
  })

  test('uses a minimum FFA floor before six players', () => {
    expect(getDefaultLeaderPoolSize('ffa', 1, 'live', 'tier3')).toBe(36)
    expect(getDefaultLeaderPoolSize('ffa', 5, 'live', 'tier3')).toBe(36)
  })

  test('computes playable minimum sizes', () => {
    expect(getMinimumLeaderPoolSize('1v1', 2)).toBe(8)
    expect(getMinimumLeaderPoolSize('2v2', 4)).toBe(10)
    expect(getMinimumLeaderPoolSize('3v3', 6)).toBe(12)
    expect(getMinimumLeaderPoolSize('4v4', 8)).toBe(14)
    expect(getMinimumLeaderPoolSize('ffa', 7)).toBe(21)
  })

  test('includes each team configured bans in versus minimums', () => {
    expect(getMinimumLeaderPoolSize('1v1', 2, 5)).toBe(12)
    expect(getMinimumLeaderPoolSize('3v3', 6, 1)).toBe(8)
    expect(getMinimumLeaderPoolSize('2v2', 8, 4)).toBe(24)
    expect(getMinimumLeaderPoolSize('ffa', 7, 5)).toBe(21)
  })

  test('resolves explicit overrides over defaults', () => {
    expect(resolveLeaderPoolSize('2v2', 4, null)).toBe(40)
    expect(resolveLeaderPoolSize('2v2', 4, 28)).toBe(28)
  })

  test('resolves average leader pool rank with rank5 fallback', () => {
    expect(resolveAverageLeaderPoolRankTier(['tier1', 'tier2', 'tier2'])).toBe('tier2')
    expect(resolveAverageLeaderPoolRankTier(['tier1', null, undefined, 'tier5'])).toBe('tier4')
    expect(resolveAverageLeaderPoolRankTier([])).toBe('tier5')
    expect(formatLeaderPoolRankLabel('tier2')).toBe('rank2')
  })

  test('samples unique leader ids', () => {
    const pool = sampleLeaderPool(32, () => 0.25)

    expect(pool).toHaveLength(32)
    expect(new Set(pool).size).toBe(32)
    expect(pool.every(id => typeof id === 'string' && id.length > 0)).toBe(true)
  })

  test('samples beta-only leaders when using beta data', () => {
    const liveLeaderIds = getLeaderIds('live')
    const betaOnlyLeaderIds = getLeaderIds('beta').filter(id => !liveLeaderIds.includes(id))
    const pool = sampleLeaderPool(getMaxLeaderPoolSize('beta'), () => 0, 'beta')

    expect(MAX_LEADER_POOL_SIZE).toBe(getMaxLeaderPoolSize('beta'))
    expect(betaOnlyLeaderIds).toEqual([
      'austria-maria-theresa',
      'goths-theodoric',
      'poland-stanislaw-ii',
      'taino-anacaona',
    ])
    expect(betaOnlyLeaderIds.every(id => pool.includes(id))).toBe(true)
  })

  test('rejects invalid sample sizes', () => {
    const liveMaxLeaderPoolSize = getMaxLeaderPoolSize('live')

    expect(() => sampleLeaderPool(0)).toThrow(`Only ${liveMaxLeaderPoolSize} eligible leaders remain`)
    expect(() => sampleLeaderPool(liveMaxLeaderPoolSize + 1)).toThrow(`Only ${liveMaxLeaderPoolSize} eligible leaders remain`)
  })

  test('filters exclusions before sampling and rejects version-invalid IDs or exhaustion', () => {
    const excluded = getLeaderIds('live').slice(0, 2)
    const eligible = getEligibleLeaderIds('live', excluded)
    const pool = sampleLeaderPool(eligible.length, () => 0, 'live', excluded)

    expect(pool).toHaveLength(eligible.length)
    expect(pool.some(id => excluded.includes(id))).toBe(false)
    expect(() => getEligibleLeaderIds('live', ['austria-maria-theresa'])).toThrow('not available in the selected leader data version')
    expect(() => sampleLeaderPool(eligible.length + 1, () => 0, 'live', excluded)).toThrow('eligible leaders remain')
  })
})
