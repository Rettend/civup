import { describe, expect, test } from 'bun:test'
import { resolveCloudflareTarget } from '../config/cloudflare-targets'
import { parseEnvFile, secretUploadCommand, selectWorkerSecrets } from '../scripts/upload-worker-secrets'

describe('Worker secret uploads', () => {
  test('uploads only the chosen Worker secrets from a mixed environment file', () => {
    const source = parseEnvFile(`
      # Public registration values must not overwrite Worker variables.
      DISCORD_APPLICATION_ID=public-application
      ALLOWED_DISCORD_GUILD_ID=public-guild
      DISCORD_TOKEN="bot=token"
      DISCORD_CLIENT_SECRET='activity-secret'
      CIVUP_SECRET=shared-secret
    `)

    expect(selectWorkerSecrets('bot', source)).toEqual({ DISCORD_TOKEN: 'bot=token', CIVUP_SECRET: 'shared-secret' })
    expect(selectWorkerSecrets('activity', source)).toEqual({
      DISCORD_CLIENT_SECRET: 'activity-secret',
      CIVUP_SECRET: 'shared-secret',
    })
  })

  test('requires the entire secret set before uploading', () => {
    expect(() => selectWorkerSecrets('bot', { DISCORD_TOKEN: 'bot-secret', CIVUP_SECRET: '  ' })).toThrow(
      'CIVUP_SECRET',
    )
    expect(() => selectWorkerSecrets('activity', { CIVUP_SECRET: 'shared' })).toThrow('DISCORD_CLIENT_SECRET')
  })

  test('selects the supplied Worker name without putting secrets in arguments', () => {
    const target = resolveCloudflareTarget('standard')
    const command = secretUploadCommand('activity', target)
    expect(command.slice(2)).toEqual(['secret', 'bulk', '--name', target.workers.activity])
    expect(command).not.toContain('--config')
    expect(command).not.toContain('--body')
    expect(command).not.toContain('--file')
  })
})
