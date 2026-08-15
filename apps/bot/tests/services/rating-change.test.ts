import { describe, expect, test } from 'bun:test'
import { formatPublicRatingChange, formatPublicRatingValue } from '../../src/embeds/rating-change.ts'

describe('formatPublicRatingChange', () => {
  test('shows sub-point precision for tiny losses', () => {
    expect(formatPublicRatingChange(483.414, 482.949)).toBe('`-0.5 RP` 📉 `( 482.9 RP)`')
  })

  test('shows sub-point precision for tiny gains', () => {
    expect(formatPublicRatingChange(1343.861, 1344.223)).toBe('`+0.4 RP` 📈 `(1344.2 RP)`')
  })

  test('formats projected sub-point results consistently', () => {
    expect(formatPublicRatingValue(1344.223, 0.362)).toBe('1344.2')
    expect(formatPublicRatingValue(1344.223, 24.362)).toBe('1344')
  })
})
