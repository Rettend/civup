import { describe, expect, test } from 'bun:test'
import { getDefaultLeaderPoolSize, getMinimumLeaderPoolSize, MAX_LEADER_POOL_SIZE, resolveLeaderPoolSize, sampleLeaderPool } from '../src/leader-pool.ts'

describe('leader pool helpers', () => {
  test('uses fixed versus defaults', () => {
    expect(getDefaultLeaderPoolSize('1v1', 2)).toBe(32)
    expect(getDefaultLeaderPoolSize('2v2', 4)).toBe(40)
    expect(getDefaultLeaderPoolSize('3v3', 6)).toBe(48)
    expect(getDefaultLeaderPoolSize('4v4', 8)).toBe(56)
  })

  test('scales FFA defaults with player count', () => {
    expect(getDefaultLeaderPoolSize('ffa', 6)).toBe(36)
    expect(getDefaultLeaderPoolSize('ffa', 8)).toBe(48)
    expect(getDefaultLeaderPoolSize('ffa', 10)).toBe(60)
  })

  test('uses a minimum FFA floor before six players', () => {
    expect(getDefaultLeaderPoolSize('ffa', 1)).toBe(36)
    expect(getDefaultLeaderPoolSize('ffa', 5)).toBe(36)
  })

  test('computes playable minimum sizes', () => {
    expect(getMinimumLeaderPoolSize('1v1', 2)).toBe(8)
    expect(getMinimumLeaderPoolSize('2v2', 4)).toBe(10)
    expect(getMinimumLeaderPoolSize('3v3', 6)).toBe(12)
    expect(getMinimumLeaderPoolSize('4v4', 8)).toBe(14)
    expect(getMinimumLeaderPoolSize('ffa', 7)).toBe(21)
  })

  test('resolves explicit overrides over defaults', () => {
    expect(resolveLeaderPoolSize('2v2', 4, null)).toBe(40)
    expect(resolveLeaderPoolSize('2v2', 4, 28)).toBe(28)
  })

  test('samples unique leader ids', () => {
    const pool = sampleLeaderPool(32, () => 0.25)

    expect(pool).toHaveLength(32)
    expect(new Set(pool).size).toBe(32)
    expect(pool.every(id => typeof id === 'string' && id.length > 0)).toBe(true)
  })

  test('rejects invalid sample sizes', () => {
    expect(() => sampleLeaderPool(0)).toThrow(`Leader pool size must be between 1 and ${MAX_LEADER_POOL_SIZE}.`)
    expect(() => sampleLeaderPool(MAX_LEADER_POOL_SIZE + 1)).toThrow(`Leader pool size must be between 1 and ${MAX_LEADER_POOL_SIZE}.`)
  })
})
