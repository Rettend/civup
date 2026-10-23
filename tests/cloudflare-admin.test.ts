import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checkMigrationResult, cloudflareAdminCommand } from '../scripts/cloudflare-admin'
import { fixtureAlternateTarget, fixtureLocalTargetsFile } from './cloudflare-fixtures'

const target = {
  ...fixtureAlternateTarget,
  accountId: 'fixture-account',
  discord: { applicationId: 'fixture-application', publicKey: 'fixture-key', guildId: 'fixture-guild' },
  d1: { ...fixtureAlternateTarget.d1, id: 'fixture-database' },
}

describe('Cloudflare admin commands', () => {
  test('keeps target identity and storage location independent', () => {
    const local = cloudflareAdminCommand('migrate', 'alternate', target, {
      location: 'local',
      persistenceDirectory: 'test-state',
    })
    expect(local.env.CLOUDFLARE_ACCOUNT_ID).toBe('fixture-account')
    expect(local.cmd).toContain('fixture-database')
    expect(local.cmd).toContain('--local')
    expect(local.cmd.at(-1)).toMatch(/test-state$/)
    const remote = cloudflareAdminCommand('migrate', 'alternate', target, { location: 'remote' })
    expect(remote.cmd).not.toContain('--local')
    expect(remote.cmd).not.toContain('--persist-to')
    expect(() => cloudflareAdminCommand('migrate', 'alternate', target)).toThrow('local or --remote')
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

  test('registration uses arbitrary target secret files or an explicit file', () => {
    expect(cloudflareAdminCommand('register', 'alternate', target).cmd).toContain('--env-file=.alternate.secrets')
    expect(cloudflareAdminCommand('register', 'weekend-2', target).cmd).toContain('--env-file=.weekend-2.secrets')
    expect(cloudflareAdminCommand('register', 'alternate', target, { envFile: 'custom.env' }).cmd).toContain(
      '--env-file=custom.env',
    )
    expect(() => cloudflareAdminCommand('register', '../outside', target)).toThrow('Use a target name')
  })

  test('registration CLI preview accepts an explicit secret path without reading it', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--no-env-file',
        'scripts/cloudflare-admin.ts',
        'register',
        '--target',
        'alternate',
        '--env-file',
        'missing-fixture.secrets',
        '--print-commands',
      ],
      {
        cwd: resolve('.'),
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          CIVUP_LOCAL_TARGETS_FILE: fixtureLocalTargetsFile,
        },
      },
    )
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).cmd).toContain(`--env-file=${resolve('missing-fixture.secrets')}`)
  })

  test('fresh resource setup can be previewed before database and namespace IDs exist', () => {
    const temporaryRoot = join(tmpdir(), 'opencode')
    mkdirSync(temporaryRoot, { recursive: true })
    const directory = mkdtempSync(join(temporaryRoot, 'civup-provisioning-'))
    const file = join(directory, 'targets.json')
    writeFileSync(file, JSON.stringify({ alternate: { accountId: '1'.repeat(32), d1: { name: 'fixture-database' } } }))
    const run = (action: string, extra: string[] = []) =>
      spawnSync(
        process.execPath,
        ['--no-env-file', 'scripts/cloudflare-admin.ts', action, '--target', 'alternate', '--print-commands', ...extra],
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
