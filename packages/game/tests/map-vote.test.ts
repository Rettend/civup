import { describe, expect, test } from 'bun:test'
import {
  createMapVoteRng,
  DEFAULT_MAP_VOTE_SELECTION,
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

  test('normalizes ranked ballots and still accepts legacy stored ballots', () => {
    expect(normalizeMapVoteSelection({
      mapTypes: ['standard', 'random', 'standard', 'east-vs-west'],
      mapScripts: ['lakes', 'random', 'lakes', 'inland-sea', 'tilted-axis'],
    })).toEqual({
      mapTypes: ['standard', 'random', 'east-vs-west'],
      mapScripts: ['lakes', 'random', 'inland-sea'],
    })

    expect(normalizeMapVoteSelection({
      mapType: 'random',
      mapScripts: ['seven-seas'],
    })).toEqual({
      mapTypes: ['random'],
      mapScripts: ['seven-seas'],
    })
  })

  test('treats empty ballots as no vote and allows confirming partial ranked ballots', () => {
    expect(DEFAULT_MAP_VOTE_SELECTION).toEqual({ mapTypes: [], mapScripts: [] })
    expect(isMapVoteSelectionConfirmable(DEFAULT_MAP_VOTE_SELECTION)).toBe(false)
    expect(isMapVoteSelectionConfirmable({ mapTypes: ['standard'], mapScripts: [] })).toBe(true)
    expect(isMapVoteSelectionConfirmable({ mapTypes: [], mapScripts: ['lakes'] })).toBe(true)
  })

  test('resolves ranked-choice map scripts through elimination rounds', () => {
    const result = resolveMapVoteWinner([
      { mapTypes: ['standard'], mapScripts: ['pangaea-ultima'] },
      { mapTypes: ['standard'], mapScripts: ['pangaea-ultima'] },
      { mapTypes: ['standard'], mapScripts: ['pangaea-ultima'] },
      { mapTypes: ['standard'], mapScripts: ['pangaea-ultima'] },
      { mapTypes: ['standard'], mapScripts: ['seven-seas'] },
      { mapTypes: ['standard'], mapScripts: ['seven-seas'] },
      { mapTypes: ['standard'], mapScripts: ['seven-seas'] },
      { mapTypes: ['standard'], mapScripts: ['lakes', 'seven-seas'] },
      { mapTypes: ['standard'], mapScripts: ['lakes', 'seven-seas'] },
      { mapTypes: ['standard'], mapScripts: ['rich-highlands', 'seven-seas'] },
    ], () => 0, 'seed-1')

    expect(result).toEqual({
      mapType: 'standard',
      mapScript: 'seven-seas',
      winningSeatCount: 6,
      seed: 'seed-1',
      mapTypeWinner: 'standard',
      mapScriptWinner: 'seven-seas',
      mapTypeRounds: [
        {
          round: 1,
          tallies: [{ id: 'standard', votes: 10 }],
          activeBallotCount: 10,
          majorityThreshold: 6,
          eliminatedId: null,
          winnerId: 'standard',
          tieBreak: null,
        },
      ],
      mapScriptRounds: [
        {
          round: 1,
          tallies: [
            { id: 'pangaea-ultima', votes: 4 },
            { id: 'seven-seas', votes: 3 },
            { id: 'lakes', votes: 2 },
            { id: 'rich-highlands', votes: 1 },
          ],
          activeBallotCount: 10,
          majorityThreshold: 6,
          eliminatedId: 'rich-highlands',
          winnerId: null,
          tieBreak: null,
        },
        {
          round: 2,
          tallies: [
            { id: 'pangaea-ultima', votes: 4 },
            { id: 'seven-seas', votes: 4 },
            { id: 'lakes', votes: 2 },
          ],
          activeBallotCount: 10,
          majorityThreshold: 6,
          eliminatedId: 'lakes',
          winnerId: null,
          tieBreak: null,
        },
        {
          round: 3,
          tallies: [
            { id: 'seven-seas', votes: 6 },
            { id: 'pangaea-ultima', votes: 4 },
          ],
          activeBallotCount: 10,
          majorityThreshold: 6,
          eliminatedId: null,
          winnerId: 'seven-seas',
          tieBreak: null,
        },
      ],
      resolvedRandomMapType: null,
      resolvedRandomMapScript: null,
    })
  })

  test('keeps random as a candidate until it wins and only then resolves it', () => {
    const result = resolveMapVoteWinner([
      { mapTypes: ['random'], mapScripts: ['random'] },
      { mapTypes: ['random'], mapScripts: ['random'] },
      { mapTypes: ['standard'], mapScripts: ['lakes'] },
    ], () => 0, 'seed-2')

    expect(result).toEqual({
      mapType: 'standard',
      mapScript: 'pangaea-ultima',
      winningSeatCount: 2,
      seed: 'seed-2',
      mapTypeWinner: 'random',
      mapScriptWinner: 'random',
      mapTypeRounds: [
        {
          round: 1,
          tallies: [
            { id: 'random', votes: 2 },
            { id: 'standard', votes: 1 },
          ],
          activeBallotCount: 3,
          majorityThreshold: 2,
          eliminatedId: null,
          winnerId: 'random',
          tieBreak: null,
        },
      ],
      mapScriptRounds: [
        {
          round: 1,
          tallies: [
            { id: 'random', votes: 2 },
            { id: 'lakes', votes: 1 },
          ],
          activeBallotCount: 3,
          majorityThreshold: 2,
          eliminatedId: null,
          winnerId: 'random',
          tieBreak: null,
        },
      ],
      resolvedRandomMapType: 'standard',
      resolvedRandomMapScript: 'pangaea-ultima',
    })
  })

  test('breaks final ties deterministically from the provided rng and seed rules', () => {
    const rngA = createMapVoteRng('match-1')
    const rngB = createMapVoteRng('match-1')

    const votes = [
      { mapTypes: ['standard'], mapScripts: ['seven-seas'] },
      { mapTypes: ['standard'], mapScripts: ['seven-seas'] },
      { mapTypes: ['east-vs-west'], mapScripts: ['lakes'] },
      { mapTypes: ['east-vs-west'], mapScripts: ['lakes'] },
    ] as const

    expect(resolveMapVoteWinner(votes, rngA, 'match-1')).toEqual(resolveMapVoteWinner(votes, rngB, 'match-1'))
  })

  test('formats east-vs-west labels compactly', () => {
    expect(formatMapVoteResultLabel('east-vs-west', 'pangaea-ultima-no-wrap')).toBe('Pangaea Ultima (No Wrap) EvW')
    expect(formatMapVoteResultLabel('standard', 'seven-seas')).toBe('Seven Seas')
    expect(formatMapVoteResultLabel('east-vs-west', 'seven-seas')).toBe('Seven Seas EvW')
  })
})
