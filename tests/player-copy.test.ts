import { describe, expect, test } from 'bun:test'
import { Linter } from 'eslint'
import { playerCopyRule } from '../scripts/eslint-player-copy.js'

function lint(code: string) {
  return new Linter().verify(code, [{
    languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { copy: { rules: { plain: playerCopyRule } } },
    rules: { 'copy/plain': 'error' },
  }])
}

describe('player-facing copy lint', () => {
  test.each([
    'function report() { return "Season-isolated reporting is not enabled." }',
    // eslint-disable-next-line no-template-curly-in-string -- This is source code passed to the linter.
    'const result = { error: `Seed-aware corrections are unavailable for ${id}.` }',
    'setError("SessionDO binding is required.")',
    'reply("Finish pending report projections.")',
    'const banner = <p>Season-isolated reporting is not enabled.</p>',
    'throw new SeasonSelectionError("No hidden-rating substitute is shown.")',
    'const result = { error: ok ? null : "Season correction failed safely." }',
  ])('rejects jargon in a displayed message: %s', (code) => {
    expect(lint(code).map(message => message.ruleId)).toEqual(['copy/plain'])
  })

  test.each([
    'function report() { return "This match was cancelled. You cannot report a result for it." }',
    'console.error("Season-isolated reporting failed", error)',
    'throw new Error("SessionDO binding is required")',
    'const result = { error: "Choose a leader for every player." }',
    'const seedAware = true // seed-aware internal implementation',
    'function query() { return sql`select "rating scope"` }',
  ])('allows plain messages and internal diagnostics: %s', (code) => {
    expect(lint(code)).toEqual([])
  })
})
