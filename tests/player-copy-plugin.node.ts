import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { RuleTester } from 'vite-plus/lint/plugins-dev'
import plugin from '../scripts/player-copy/plugin.js'

RuleTester.describe = describe
RuleTester.it = it

function fixture(name: string) {
  return {
    filename: name,
    code: readFileSync(new URL(`./fixtures/player-copy/${name}.fixture`, import.meta.url), 'utf-8'),
  }
}

new RuleTester().run('plain-language', plugin.rules['plain-language']!, {
  valid: [fixture('allowed-log.ts')],
  invalid: [
    {
      ...fixture('player-message.ts'),
      errors: [{ messageId: 'jargon', data: { phrase: 'Season-isolated' }, line: 2 }],
    },
    {
      ...fixture('jsx-and-template.tsx'),
      errors: [
        { messageId: 'jargon', data: { phrase: 'SessionDO binding' } },
        { messageId: 'jargon', data: { phrase: 'Season-isolated' } },
        { messageId: 'jargon', data: { phrase: 'Seed-aware' } },
        { messageId: 'jargon', data: { phrase: 'validated season assignment' } },
        { messageId: 'jargon', data: { phrase: 'hidden-rating substitute' } },
      ],
    },
  ],
})
