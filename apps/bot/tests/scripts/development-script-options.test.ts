import { describe, expect, test } from 'bun:test'
import { parseTournamentEmojiOptions } from '../../scripts/generate-tournament-emoji-icons.ts'
import { resolveDevLeaderPlayer } from '../../scripts/seed-dev-leaders.ts'

describe('tournament emoji sources', () => {
  test('file, emoji, and existing-output sources do not select a database', () => {
    expect(parseTournamentEmojiOptions([])).toEqual({ database: null, emojis: [], files: [], allowEmpty: false })
    expect(parseTournamentEmojiOptions(['players.csv', '--emoji', '🏆', '--emoji=🎲', '--allow-empty'])).toEqual({
      database: null,
      emojis: ['🏆', '🎲'],
      files: ['players.csv'],
      allowEmpty: true,
    })
  })

  test.each([
    { target: 'standard', location: 'local' },
    { target: 'standard', location: 'remote' },
    { target: 'alternate', location: 'local' },
    { target: 'alternate', location: 'remote' },
  ])('database sources use the explicit target and storage: %j', ({ target, location }) => {
    expect(
      parseTournamentEmojiOptions(['--d1-tournament-id=fixture-tournament', '--target', target, `--${location}`]),
    ).toEqual({
      database: { tournamentId: 'fixture-tournament', target, location },
      emojis: [],
      files: [],
      allowEmpty: false,
    })
  })

  test.each(
    [
      ['--d1-tournament-id', 'fixture-tournament'],
      ['--d1-tournament-id', 'fixture-tournament', '--target', 'standard'],
      ['--d1-tournament-id', 'fixture-tournament', '--remote'],
      ['--target', 'standard'],
      ['--local'],
      ['--remote'],
      ['--local', '--remote'],
      ['--remote', '--local'],
      ['--local', '--local'],
      ['--remote', '--remote'],
    ].map(args => ({ args })),
  )('rejects incomplete or ambiguous database options: %j', ({ args }) => {
    expect(() => parseTournamentEmojiOptions(args)).toThrow()
  })

  test.each(
    [
      ['--current'],
      ['--unknown'],
      ['--d1-tournament-id'],
      ['--d1-tournament-id='],
      ['--target', '--remote'],
      ['--emoji', ' '],
      ['--target', 'standard', '--target', 'standard'],
      ['--d1-tournament-id', 'first', '--d1-tournament-id', 'second'],
      ['--d1-tournament-id', 'fixture-tournament', '--target', 'custom', '--remote'],
      ['--d1-tournament-id', 'fixture-tournament', '--target', 'unknown', '--remote'],
    ].map(args => ({ args })),
  )('rejects unsupported, missing, repeated, or invalid options: %j', ({ args }) => {
    expect(() => parseTournamentEmojiOptions(args)).toThrow()
  })
})

describe('development leader seed identity', () => {
  test('defaults to a synthetic identity', () => {
    expect(resolveDevLeaderPlayer({})).toEqual({ id: 'dev-leaders-player', displayName: 'Dev Player' })
  })

  test('accepts an explicitly configured identity without storing it in source', () => {
    expect(
      resolveDevLeaderPlayer({
        CIVUP_DEV_PLAYER_ID: '  fixture-player  ',
        CIVUP_DEV_PLAYER_NAME: '  Fixture Player  ',
      }),
    ).toEqual({ id: 'fixture-player', displayName: 'Fixture Player' })
  })

  test('empty overrides retain the synthetic defaults', () => {
    expect(resolveDevLeaderPlayer({ CIVUP_DEV_PLAYER_ID: ' ', CIVUP_DEV_PLAYER_NAME: '' })).toEqual({
      id: 'dev-leaders-player',
      displayName: 'Dev Player',
    })
  })

  test('each identity override can be provided independently', () => {
    expect(resolveDevLeaderPlayer({ CIVUP_DEV_PLAYER_ID: 'fixture-player' })).toEqual({
      id: 'fixture-player',
      displayName: 'Dev Player',
    })
    expect(resolveDevLeaderPlayer({ CIVUP_DEV_PLAYER_NAME: 'Fixture Player' })).toEqual({
      id: 'dev-leaders-player',
      displayName: 'Fixture Player',
    })
  })
})
