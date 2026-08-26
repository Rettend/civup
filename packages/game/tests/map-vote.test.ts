import { describe, expect, test } from 'bun:test'
import {
  createMapVoteRng,
  DEFAULT_MAP_VOTE_SELECTION,
  formatMapVoteResultLabel,
  formatMapVoteResultTitle,
  getMapVoteMapIdForResult,
  isMapVoteSelectionConfirmable,
  isMapVoteSupportedForMode,
  normalizeMapVoteEnabled,
  normalizeMapVoteSelection,
  resolveMapVoteWinner,
} from '../src/map-vote.ts'

describe('map vote helpers', () => {
  test('supports non-red-death duel, team, and FFA modes', () => {
    expect(isMapVoteSupportedForMode('2v2')).toBe(true)
    expect(isMapVoteSupportedForMode('6v6')).toBe(true)
    expect(isMapVoteSupportedForMode('1v1')).toBe(true)
    expect(isMapVoteSupportedForMode('ffa')).toBe(true)
    expect(isMapVoteSupportedForMode('1v1', { redDeath: true })).toBe(false)
    expect(isMapVoteSupportedForMode('ffa', { redDeath: true })).toBe(false)
    expect(isMapVoteSupportedForMode('4v4', { redDeath: true })).toBe(false)
  })

  test('normalizes unsupported toggles off', () => {
    expect(normalizeMapVoteEnabled('2v2', true)).toBe(true)
    expect(normalizeMapVoteEnabled('1v1', true)).toBe(true)
    expect(normalizeMapVoteEnabled('ffa', true)).toBe(true)
    expect(normalizeMapVoteEnabled('3v3', true, { redDeath: true })).toBe(false)
  })

  test('normalizes ranked ballots and still accepts legacy stored ballots', () => {
    expect(normalizeMapVoteSelection({
      maps: ['lakes', 'random', 'lakes', 'inland-sea', 'tilted-axis'],
    })).toEqual({
      maps: ['lakes', 'random', 'inland-sea'],
    })

    expect(normalizeMapVoteSelection({
      mapTypes: ['east-vs-west'],
      mapScripts: ['pangaea-ultima', 'seven-seas'],
    })).toEqual({
      maps: ['pangaea-ultima-east-vs-west', 'seven-seas'],
    })

    expect(normalizeMapVoteSelection({
      maps: ['terra', 'pangaea'],
    })).toEqual({
      maps: ['terra', 'pangaea'],
    })
  })

  test('maps Terra and classic Pangaea only for standard results', () => {
    for (const mapId of ['pangaea', 'terra'] as const) {
      expect(getMapVoteMapIdForResult('standard', mapId)).toBe(mapId)
      expect(getMapVoteMapIdForResult('east-vs-west', mapId)).toBeNull()
    }
  })

  test('treats empty ballots as no vote and allows confirming partial ranked ballots', () => {
    expect(DEFAULT_MAP_VOTE_SELECTION).toEqual({ maps: [] })
    expect(isMapVoteSelectionConfirmable(DEFAULT_MAP_VOTE_SELECTION)).toBe(false)
    expect(isMapVoteSelectionConfirmable({ maps: ['lakes'] })).toBe(true)
    expect(isMapVoteSelectionConfirmable({ mapTypes: ['standard'], mapScripts: [] })).toBe(true)
  })

  test('resolves ranked-choice map scripts through elimination rounds', () => {
    const result = resolveMapVoteWinner([
      { maps: ['pangaea-ultima'] },
      { maps: ['pangaea-ultima'] },
      { maps: ['pangaea-ultima'] },
      { maps: ['pangaea-ultima'] },
      { maps: ['seven-seas'] },
      { maps: ['seven-seas'] },
      { maps: ['seven-seas'] },
      { maps: ['lakes', 'seven-seas'] },
      { maps: ['lakes', 'seven-seas'] },
      { maps: ['rich-highlands', 'seven-seas'] },
    ], () => 0, 'seed-1')

    expect(result).toEqual({
      mapType: 'standard',
      mapScript: 'seven-seas',
      winningSeatCount: 6,
      seed: 'seed-1',
      mapTypeWinner: 'standard',
      mapScriptWinner: 'seven-seas',
      mapTypeRounds: [],
      mapScriptRounds: [],
      resolvedRandomMapType: null,
      resolvedRandomMapScript: null,
    })
  })

  test('keeps random as a candidate until it wins and only then resolves it', () => {
    const result = resolveMapVoteWinner([
      { maps: ['random'] },
      { maps: ['random'] },
      { maps: ['lakes'] },
    ], () => 0, 'seed-2')

    expect(result).toEqual({
      mapType: 'standard',
      mapScript: 'pangaea-ultima',
      winningSeatCount: 2,
      seed: 'seed-2',
      mapTypeWinner: 'random',
      mapScriptWinner: 'random',
      mapTypeRounds: [],
      mapScriptRounds: [],
      resolvedRandomMapType: 'standard',
      resolvedRandomMapScript: 'pangaea-ultima',
    })
  })

  test('breaks final ties deterministically from the provided rng and seed rules', () => {
    const rngA = createMapVoteRng('match-1')
    const rngB = createMapVoteRng('match-1')

    const votes = [
      { maps: ['seven-seas'] },
      { maps: ['seven-seas'] },
      { maps: ['inland-sea-east-vs-west'] },
      { maps: ['inland-sea-east-vs-west'] },
    ] as const

    expect(resolveMapVoteWinner(votes, rngA, 'match-1')).toEqual(resolveMapVoteWinner(votes, rngB, 'match-1'))
  })

  test('formats map type labels compactly', () => {
    expect(formatMapVoteResultLabel('east-vs-west', 'pangaea-ultima-no-wrap')).toBe('Pangaea Ultima (No Wrap) EvW')
    expect(formatMapVoteResultLabel('standard', 'seven-seas')).toBe('Seven Seas Stnd')
    expect(formatMapVoteResultLabel('east-vs-west', 'seven-seas')).toBe('Seven Seas EvW')
    expect(formatMapVoteResultLabel('standard', 'pangaea')).toBe('Pangaea (Classic) Stnd')
    expect(formatMapVoteResultLabel('standard', 'terra')).toBe('Terra Stnd')
  })

  test('formats map type titles fully', () => {
    expect(formatMapVoteResultTitle('east-vs-west', 'pangaea-ultima-no-wrap')).toBe('Pangaea Ultima (No Wrap) East vs West')
    expect(formatMapVoteResultTitle('standard', 'seven-seas')).toBe('Seven Seas Standard')
    expect(formatMapVoteResultTitle('standard', 'pangaea')).toBe('Pangaea (Classic) Standard')
    expect(formatMapVoteResultTitle('standard', 'terra')).toBe('Terra Standard')
  })
})
