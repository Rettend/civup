import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveCloudflareTarget } from '../config/cloudflare-targets'
import { checkMigrationResult, cloudflareAdminCommand } from '../scripts/cloudflare-admin'

const target = {
  ...resolveCloudflareTarget('standard'),
  accountId: 'fixture-account',
  discord: { applicationId: 'fixture-application', publicKey: 'fixture-key', guildId: 'fixture-guild' },
  d1: { ...resolveCloudflareTarget('standard').d1, id: 'fixture-database' },
}

describe('Cloudflare admin commands', () => {
  test('keeps target identity and storage location independent', () => {
    const local = cloudflareAdminCommand('migrate', 'ppl', target, {
      location: 'local',
      persistenceDirectory: 'test-state',
    })
    expect(local.env.CLOUDFLARE_ACCOUNT_ID).toBe('fixture-account')
    expect(local.cmd).toContain('fixture-database')
    expect(local.cmd).toContain('--local')
    expect(local.cmd.at(-1)).toMatch(/test-state$/)
    const remote = cloudflareAdminCommand('migrate', 'ppl', target, { location: 'remote' })
    expect(remote.cmd).not.toContain('--local')
    expect(remote.cmd).not.toContain('--persist-to')
    expect(() => cloudflareAdminCommand('migrate', 'ppl', target)).toThrow('local or --remote')
  })

  test('registers the chosen Discord application and guild', () => {
    const plan = cloudflareAdminCommand('register', 'standard', target, {
      localTargetsFile: 'tests/cloudflare-targets.fixture.json',
    })
    expect(plan.env.DISCORD_APPLICATION_ID).toBe('fixture-application')
    expect(plan.env.ALLOWED_DISCORD_GUILD_ID).toBe('fixture-guild')
    expect(plan.cmd).toContain('--env-file=.prod.secrets')
    expect(plan.env).not.toHaveProperty('DISCORD_TOKEN')
    expect(plan.env.CIVUP_LOCAL_TARGETS_FILE).toBe(resolve('tests/cloudflare-targets.fixture.json'))
  })

  test('rejects unsuccessful migrations even when the CLI exits successfully', () => {
    expect(() => checkMigrationResult('[]')).not.toThrow()
    expect(() => checkMigrationResult('[{"name":"0001.sql","status":"✅"}]')).not.toThrow()
    expect(() => checkMigrationResult('[{"name":"0001.sql","status":"❌"}]')).toThrow('did not complete')
    expect(() => checkMigrationResult('{}')).toThrow('did not complete')
  })

  test('fresh resource setup can be previewed before database and namespace IDs exist', () => {
    const temporaryRoot = join(tmpdir(), 'opencode')
    mkdirSync(temporaryRoot, { recursive: true })
    const directory = mkdtempSync(join(temporaryRoot, 'civup-provisioning-'))
    const file = join(directory, 'targets.json')
    writeFileSync(file, JSON.stringify({ ppl: { accountId: '1'.repeat(32), d1: { name: 'fixture-database' } } }))
    const run = (action: string, extra: string[] = []) =>
      spawnSync(
        process.execPath,
        ['--no-env-file', 'scripts/cloudflare-admin.ts', action, '--target', 'ppl', '--print-commands', ...extra],
        {
          cwd: resolve('.'),
          encoding: 'utf8',
          env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, CIVUP_LOCAL_TARGETS_FILE: file },
        },
      )
    try {
      for (const action of ['d1-create', 'kv-create']) {
        const result = run(action)
        expect(result.status, result.stderr).toBe(0)
        const plan = JSON.parse(result.stdout)
        expect(plan.env.CLOUDFLARE_ACCOUNT_ID).toBe('1'.repeat(32))
        expect(plan.cmd.at(-1)).toBe('fixture-database')
      }
      expect(run('migrate', ['--local']).status).toBe(1)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
