import { describe, expect, test } from 'bun:test'
import { isDraftCardUnavailable } from '../src/client/components/draft/draftAvailability'
import { createActiveDraftState, TEST_LEADER_IDS } from './ui-fixtures'

describe('draft availability', () => {
  test('marks visible FFA draft-ban submissions unavailable', () => {
    const state = createActiveDraftState({
      formatId: 'default-ffa-visible-bans',
      steps: [{ action: 'ban', seats: 'all', count: 2, timer: 120 }],
      submissions: { 0: [TEST_LEADER_IDS.abrahamLincoln] },
    })

    expect(isDraftCardUnavailable(state, TEST_LEADER_IDS.abrahamLincoln)).toBe(true)
  })

  test('keeps blind FFA ban submissions hidden from availability', () => {
    const state = createActiveDraftState({
      formatId: 'default-ffa',
      steps: [{ action: 'ban', seats: 'all', count: 2, timer: 120 }],
      submissions: { 0: [TEST_LEADER_IDS.abrahamLincoln] },
    })

    expect(isDraftCardUnavailable(state, TEST_LEADER_IDS.abrahamLincoln)).toBe(false)
  })

  test('marks visible teammate blind-pick submissions unavailable', () => {
    const state = createActiveDraftState({
      formatId: '2v2',
      steps: [{ action: 'pick', seats: 'all', count: 1, timer: 60, blind: true, blindPickRound: 0, fallbackPickOrder: [0, 1, 2, 3] }],
      submissions: { 2: [TEST_LEADER_IDS.abrahamLincoln] },
    })

    expect(isDraftCardUnavailable(state, TEST_LEADER_IDS.abrahamLincoln)).toBe(true)
  })

  test('does not mark censored opponent blind-pick submissions unavailable', () => {
    const state = createActiveDraftState({
      formatId: '2v2',
      steps: [{ action: 'pick', seats: 'all', count: 1, timer: 60, blind: true, blindPickRound: 0, fallbackPickOrder: [0, 1, 2, 3] }],
      submissions: { 1: ['__blind__'] },
    })

    expect(isDraftCardUnavailable(state, TEST_LEADER_IDS.abrahamLincoln)).toBe(false)
  })
})
