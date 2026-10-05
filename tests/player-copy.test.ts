import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { checkPlayerCopy, checkPlayerCopyFiles, findPlayerCopyFiles } from '../scripts/player-copy/check.ts'

function fixture(name: string) {
  return checkPlayerCopy(
    readFileSync(new URL(`./fixtures/player-copy/${name}.fixture`, import.meta.url), 'utf-8'),
    name,
  )
}

describe('player-facing copy lint', () => {
  test.each([
    'function report() { return "Season-isolated reporting is not enabled." }',
    'const result = { error: `Seed-aware corrections are unavailable for ${id}.` }',
    'setError("SessionDO binding is required.")',
    'reply("Finish pending report projections.")',
    'const banner = <p>Season-isolated reporting is not enabled.</p>',
    'throw new SeasonSelectionError("No hidden-rating substitute is shown.")',
    'const result = { error: ok ? null : "Season correction failed safely." }',
  ])('rejects jargon in a displayed message: %s', code => {
    expect(checkPlayerCopy(code)).toHaveLength(1)
  })

  test.each([
    'function report() { return "This match was cancelled. You cannot report a result for it." }',
    'console.error("Season-isolated reporting failed", error)',
    'throw new Error("SessionDO binding is required")',
    'const result = { error: "Choose a leader for every player." }',
    'const seedAware = true // seed-aware internal implementation',
    'function query() { return sql`select "rating scope"` }',
  ])('allows plain messages and internal diagnostics: %s', code => {
    expect(checkPlayerCopy(code)).toEqual([])
  })

  test('rejects the player-message fixture at its source location', () => {
    expect(fixture('player-message.ts')).toMatchObject([{ line: 2, column: 19, phrase: 'Season-isolated' }])
  })

  test('allows logs, technical exceptions, tagged templates, and plain messages', () => {
    expect(fixture('allowed-log.ts')).toEqual([])
  })

  test('checks JSX text, attributes, fragments, and interpolated templates', () => {
    expect(fixture('jsx-and-template.tsx').map(message => message.phrase)).toEqual([
      'SessionDO binding',
      'Season-isolated',
      'Seed-aware',
      'validated season assignment',
      'hidden-rating substitute',
    ])
  })

  test('does not allow ESLint or Oxlint comments to suppress the copy check', () => {
    expect(fixture('inline-suppression.ts')).toMatchObject([{ line: 6, phrase: 'failed safely' }])
  })

  test('reports malformed source rather than silently skipping it', () => {
    expect(checkPlayerCopy('return { error:')).toMatchObject([
      { message: expect.stringContaining('Cannot check player copy:') },
    ])
  })

  test('keeps UTF-16 columns correct after a Unicode player name and CRLF', () => {
    expect(checkPlayerCopy('// 😀\r\nreply("rating scope")')).toMatchObject([
      { line: 2, column: 7, phrase: 'rating scope' },
    ])
  })

  test('checks every app source directory without applying lint ignores', () => {
    const temporaryDirectory = join(tmpdir(), 'opencode')
    mkdirSync(temporaryDirectory, { recursive: true })
    const root = mkdtempSync(join(temporaryDirectory, 'player-copy-'))
    try {
      for (const directory of ['apps/bot/src', 'apps/activity/src/client', 'apps/extra/src/.cache', 'apps/bot/tests'])
        mkdirSync(join(root, directory), { recursive: true })
      writeFileSync(join(root, 'apps/bot/src/report.ts'), 'reply("rating scope")')
      writeFileSync(join(root, 'apps/activity/src/client/banner.tsx'), '<p>SessionDO binding is required.</p>')
      writeFileSync(join(root, 'apps/extra/src/.cache/message.ts'), '/* oxlint-disable */\nreply("seed-aware")')
      writeFileSync(join(root, 'apps/bot/tests/report.ts'), 'reply("seed-aware")')
      writeFileSync(join(root, 'apps/bot/src/legacy.js'), 'reply("seed-aware")')

      expect(findPlayerCopyFiles(root).map(file => relative(root, file).replaceAll('\\', '/'))).toEqual([
        'apps/activity/src/client/banner.tsx',
        'apps/bot/src/report.ts',
        'apps/extra/src/.cache/message.ts',
      ])
      const result = checkPlayerCopyFiles(root)
      expect(result.files).toBe(3)
      expect(result.diagnostics.map(message => message.phrase)).toEqual([
        'SessionDO binding',
        'rating scope',
        'seed-aware',
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
