import { describe, expect, test } from 'bun:test'
import { formatDisplayRatingChange } from '../../src/embeds/rating-change.ts'

describe('formatDisplayRatingChange', () => {
  test('preserves negative zero for tiny losses', () => {
    expect(formatDisplayRatingChange(483.414, 482.949)).toBe('` -0` 📉 `( 483)`')
  })

  test('keeps positive zero for tiny gains', () => {
    expect(formatDisplayRatingChange(1343.861, 1344.223)).toBe('` +0` 📈 `(1344)`')
  })
})
