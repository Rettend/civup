import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fixtureLocalTargetsFile, fixturePplTarget } from './cloudflare-fixtures'

test.each([200, 403])('registration exits according to Discord response %i', status => {
  const script = `
    globalThis.fetch = async request => {
      const url = String(request instanceof Request ? request.url : request)
      if (!url.endsWith('/applications/${fixturePplTarget.discord.applicationId}/guilds/${fixturePplTarget.discord.guildId}/commands')) throw new Error('Unexpected fixture request')
      return new Response('${status === 200 ? '[]' : '{"message":"fixture denied"}'}', { status: ${status} })
    }
    await import('./apps/bot/src/register.ts')
  `
  const result = spawnSync(process.execPath, ['--no-env-file', '-e', script], {
    cwd: resolve('.'),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: process.env.TEMP,
      CIVUP_TARGET: 'ppl',
      CIVUP_LOCAL_TARGETS_FILE: fixtureLocalTargetsFile,
      DISCORD_TOKEN: 'fixture-token',
    },
  })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(status === 200 ? 0 : 1)
  expect(result.stdout.includes('Done!')).toBe(status === 200)
  if (status === 403) expect(result.stderr).toContain('fixture denied')
})
