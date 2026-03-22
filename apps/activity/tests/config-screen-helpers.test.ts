import { describe, expect, test } from 'bun:test'
import { formatLeaderPoolValue, leaderPoolSizePlaceholder } from '../src/client/lib/config-screen/helpers'

describe('leader pool helper defaults', () => {
  test('uses full FFA target size for open-lobby placeholder defaults', () => {
    expect(leaderPoolSizePlaceholder('ffa', 6, 8)).toBe('40')
  })

  test('uses full FFA target size for open-lobby formatted defaults', () => {
    expect(formatLeaderPoolValue(null, 'ffa', 6, 8)).toBe('40')
  })

  test('preserves explicit leader pool overrides', () => {
    expect(formatLeaderPoolValue(20, 'ffa', 6, 8)).toBe('20')
  })
})
