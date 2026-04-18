import { describe, expect, test } from 'bun:test'
import {
  createMapVoteRng,
  formatMapVoteResultLabel,
  isMapVoteSupportedForMode,
  normalizeMapVoteEnabled,
  resolveMapVoteWinner,
} from '../src/map-vote.ts'

describe('map vote helpers', () => {
  test('supports only non-red-death team modes', () => {
    expect(isMapVoteSupportedForMode('2v2')).toBe(true)
    expect(isMapVoteSupportedForMode('6v6')).toBe(true)
    expect(isMapVoteSupportedForMode('1v1')).toBe(false)
    expect(isMapVoteSupportedForMode('ffa')).toBe(false)
    expect(isMapVoteSupportedForMode('4v4', { redDeath: true })).toBe(false)
  })

  test('normalizes unsupported toggles off', () => {
    expect(normalizeMapVoteEnabled('2v2', true)).toBe(true)
    expect(normalizeMapVoteEnabled('ffa', true)).toBe(false)
    expect(normalizeMapVoteEnabled('3v3', true, { redDeath: true })).toBe(false)
  })

  test('resolves random ballots and ties deterministically from the provided rng', () => {
    const rngA = createMapVoteRng('match-1')
    const rngB = createMapVoteRng('match-1')

    const votes = [
      { mapType: 'random', mapScript: 'random' },
      { mapType: 'standard', mapScript: 'lakes' },
      { mapType: 'east-vs-west', mapScript: 'inland-sea' },
      { mapType: 'east-vs-west', mapScript: 'random' },
    ] as const

    expect(resolveMapVoteWinner(votes, rngA)).toEqual(resolveMapVoteWinner(votes, rngB))
  })

  test('formats east-vs-west labels compactly', () => {
    expect(formatMapVoteResultLabel('east-vs-west', 'pangaea-ultima-no-wrap')).toBe('EvW Pangaea Ultima (No Wrap)')
    expect(formatMapVoteResultLabel('standard', 'seven-seas')).toBe('Seven Seas')
  })
})
