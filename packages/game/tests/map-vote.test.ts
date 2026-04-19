import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_MAP_VOTE_SELECTION,
  createMapVoteRng,
  formatMapVoteResultLabel,
  isMapVoteSelectionConfirmable,
  isMapVoteSupportedForMode,
  normalizeMapVoteEnabled,
  normalizeMapVoteSelection,
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
      { mapType: 'random', mapScripts: [] },
      { mapType: 'standard', mapScripts: ['lakes'] },
      { mapType: 'east-vs-west', mapScripts: ['inland-sea'] },
      { mapType: 'east-vs-west', mapScripts: ['lakes', 'inland-sea'] },
    ] as const

    expect(resolveMapVoteWinner(votes, rngA)).toEqual(resolveMapVoteWinner(votes, rngB))
  })

  test('normalizes script approvals to explicit unique picks', () => {
    expect(normalizeMapVoteSelection({
      mapType: 'random',
      mapScripts: ['lakes', 'random', 'lakes', 'inland-sea', 'tilted-axis', 'primordial'],
    })).toEqual({
      mapType: 'random',
      mapScripts: ['random'],
    })
  })

  test('resolves random script ballots to one concrete reveal script', () => {
    const result = resolveMapVoteWinner([
      { mapType: 'east-vs-west', mapScripts: ['random'] },
      { mapType: 'east-vs-west', mapScripts: ['seven-seas'] },
    ], () => 0)

    expect(result).toEqual({
      mapType: 'east-vs-west',
      mapScript: 'pangaea-ultima',
      winningSeatCount: 1,
    })
  })

  test('requires at least one approved map before confirm', () => {
    expect(DEFAULT_MAP_VOTE_SELECTION).toEqual({ mapType: 'random', mapScripts: ['random'] })
    expect(isMapVoteSelectionConfirmable(DEFAULT_MAP_VOTE_SELECTION)).toBe(true)
    expect(isMapVoteSelectionConfirmable({ mapType: 'random', mapScripts: [] })).toBe(false)
    expect(isMapVoteSelectionConfirmable({ mapType: 'random', mapScripts: ['lakes'] })).toBe(true)
  })

  test('resolves scripts by approval within the winning map type', () => {
    const result = resolveMapVoteWinner([
      { mapType: 'east-vs-west', mapScripts: ['lakes', 'seven-seas'] },
      { mapType: 'east-vs-west', mapScripts: ['seven-seas'] },
      { mapType: 'east-vs-west', mapScripts: [] },
      { mapType: 'standard', mapScripts: ['lakes'] },
    ], () => 0)

    expect(result).toEqual({
      mapType: 'east-vs-west',
      mapScript: 'seven-seas',
      winningSeatCount: 2,
    })
  })

  test('ignores zero-pick ballots when resolving the winning map type', () => {
    const result = resolveMapVoteWinner([
      { mapType: 'east-vs-west', mapScripts: [] },
      { mapType: 'east-vs-west', mapScripts: [] },
      { mapType: 'standard', mapScripts: ['seven-seas'] },
    ], () => 0)

    expect(result).toEqual({
      mapType: 'standard',
      mapScript: 'seven-seas',
      winningSeatCount: 1,
    })
  })

  test('formats east-vs-west labels compactly', () => {
    expect(formatMapVoteResultLabel('east-vs-west', 'pangaea-ultima-no-wrap')).toBe('Pangaea Ultima (No Wrap) EvW')
    expect(formatMapVoteResultLabel('standard', 'seven-seas')).toBe('Seven Seas')
    expect(formatMapVoteResultLabel('east-vs-west', 'seven-seas')).toBe('Seven Seas EvW')
  })
})
