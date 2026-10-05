import type { CloudflareProvisioningTarget, CloudflareStorageLocation, CloudflareTarget, CloudflareTargetName } from '../config/cloudflare-targets.ts'
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cloudflarePublicVariables,
  cloudflareTargets,
  parseCloudflareLocalTargets,
  resolveCloudflareProvisioningTarget,
  resolveCloudflareStorage,
  resolveCloudflareTarget,
  resolveCloudflareTargetName,
} from '../config/cloudflare-targets.ts'
import { fixtureLocalTargets, fixtureAlternateTarget, fixtureTargetOptions } from './cloudflare-fixtures.ts'

function withLocalTargetsFile(contents: string, run: (file: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'civup-cloudflare-targets-'))
  const file = join(directory, 'targets.local.json')
  try {
    writeFileSync(file, contents)
    run(file)
  }
  finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('Cloudflare target selection', () => {
  test.each([undefined, '', 'production', 'dev', 'ALTERNATE', ' alternate', 'alternate ', '__proto__'])('rejects an implicit or invalid target: %s', value => {
    expect(() => resolveCloudflareTargetName(value)).toThrow('Set CIVUP_TARGET to standard or alternate explicitly.')
    expect(() => resolveCloudflareProvisioningTarget(value)).toThrow('Set CIVUP_TARGET to standard or alternate explicitly.')
  })

  test('the same Worker and database names do not choose the same account or resources', () => {
    const standard = resolveCloudflareTarget('standard')
    const alternate = resolveCloudflareTarget('alternate', fixtureTargetOptions)
    expect(standard.workers).toEqual(alternate.workers)
    expect(standard.d1.name).toBe(alternate.d1.name)
    expect(standard.accountId).not.toBe(alternate.accountId)
    expect(standard.d1.id).not.toBe(alternate.d1.id)
    expect(standard.kv.id).not.toBe(alternate.kv.id)
    expect(standard.discord.applicationId).not.toBe(alternate.discord.applicationId)
  })

  for (const target of ['standard', 'alternate'] satisfies CloudflareTargetName[]) {
    test(`${target} keeps transport separate from account selection`, () => {
      const local = resolveCloudflareStorage(target, 'local', fixtureTargetOptions)
      const remote = resolveCloudflareStorage(target, 'remote', fixtureTargetOptions)
      expect(local.location).toBe('local')
      expect(remote.location).toBe('remote')
      expect(local.accountId).toBe(resolveCloudflareTarget(target, fixtureTargetOptions).accountId)
      expect(remote.accountId).toBe(local.accountId)
      expect(remote.d1).toEqual(local.d1)
      expect(remote.kv).toEqual(local.kv)
      expect(local.persistenceDirectory).toBe('apps/bot/.wrangler/state')
      expect(remote.persistenceDirectory).toBeUndefined()
    })
  }

  test('storage also requires an explicit transport at runtime', () => {
    expect(() => resolveCloudflareStorage('alternate', undefined as unknown as CloudflareStorageLocation))
      .toThrow('Choose local or remote storage explicitly.')
  })

  test('production browser and bot IDs come from the same public target', () => {
    for (const name of ['standard', 'alternate'] as const) {
      const target = resolveCloudflareTarget(name, fixtureTargetOptions)
      expect(cloudflarePublicVariables(target, 'activity').DISCORD_CLIENT_ID)
        .toBe(cloudflarePublicVariables(target, 'bot').DISCORD_APPLICATION_ID!)
    }
    expect(cloudflarePublicVariables(cloudflareTargets.standard, 'bot').ENABLE_DEBUG_LOBBY_FILL).toBe('1')
    expect(cloudflarePublicVariables(fixtureAlternateTarget, 'bot').ENABLE_DEBUG_LOBBY_FILL).toBeUndefined()
    expect(cloudflarePublicVariables(cloudflareTargets.standard, 'bot').ALLOWED_DISCORD_GUILD_IDS).toBeUndefined()
    expect(cloudflarePublicVariables(fixtureAlternateTarget, 'bot').ALLOWED_DISCORD_GUILD_IDS).toBe(fixtureAlternateTarget.discord.guildId)
    expect(cloudflarePublicVariables(fixtureAlternateTarget, 'activity')).not.toHaveProperty('ALLOWED_DISCORD_GUILD_IDS')
  })

  test('standard works without local settings, and ALTERNATE never falls back to standard', () => {
    const options = { localTargetsFile: new URL('./missing-targets.local.json', import.meta.url) }
    expect(Object.keys(cloudflareTargets)).toEqual(['standard'])
    expect(resolveCloudflareTarget('standard', options)).toEqual(cloudflareTargets.standard)
    expect(() => resolveCloudflareTarget('alternate', options)).toThrow('ALTERNATE target settings were not found')
    expect(() => resolveCloudflareTarget('alternate', { localTargets: {} })).toThrow('ALTERNATE target settings are missing')
  })

  test('local metadata validation rejects placeholders, changed Worker names, and secret values', () => {
    expect(() => parseCloudflareLocalTargets({ alternate: { ...fixtureAlternateTarget, accountId: 'YOUR_ALTERNATE_ACCOUNT_ID' } })).toThrow('invalid accountId')
    expect(() => parseCloudflareLocalTargets({ alternate: { ...fixtureAlternateTarget, workers: { ...fixtureAlternateTarget.workers, bot: 'civup-bot-alternate' } } })).toThrow('invalid workers.bot')
    expect(() => parseCloudflareLocalTargets({ alternate: { ...fixtureAlternateTarget, bot: { ...fixtureAlternateTarget.bot, variables: { DISCORD_TOKEN: 'fixture-value' } } } })).toThrow('Keep secret values out')
    expect(parseCloudflareLocalTargets(fixtureLocalTargets)).toEqual(fixtureLocalTargets)
  })

  test('Node can import targets and resolve injected metadata without config or credential file reads', () => {
    const moduleUrl = new URL('../config/cloudflare-targets.ts', import.meta.url).href
    const source = `
      import fs from 'node:fs'
      import { registerHooks, syncBuiltinESMExports } from 'node:module'
      const readFileSync = fs.readFileSync
      fs.readFileSync = (file, ...args) => {
        if (String(file).endsWith('cloudflare-targets.ts')) return readFileSync(file, ...args)
        throw new Error('Unexpected metadata file read')
      }
      syncBuiltinESMExports()
      registerHooks({ resolve(specifier, context, next) {
        if (!specifier.startsWith('file:') && !specifier.startsWith('node:')) throw new Error('Target data unexpectedly imports ' + specifier)
        return next(specifier, context)
      } })
      const { resolveCloudflareTarget, resolveCloudflareProvisioningTarget } = await import(${JSON.stringify(moduleUrl)})
      const localTargets = ${JSON.stringify(fixtureLocalTargets)}
      console.log(JSON.stringify({
        targets: ['standard', 'alternate'].map(name => resolveCloudflareTarget(name, { localTargets })),
        provisioning: ['standard', 'alternate'].map(name => resolveCloudflareProvisioningTarget(name, { localTargets })),
      }))
    `
    const result = spawnSync('node', ['--input-type=module', '--eval', source], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    })
    expect(result.status, result.stderr || String(result.error ?? '')).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      targets: [cloudflareTargets.standard, fixtureAlternateTarget],
      provisioning: ['standard', 'alternate'].map(name => resolveCloudflareProvisioningTarget(name, fixtureTargetOptions)),
    })
  })
})

describe('Cloudflare resource creation target selection', () => {
  test('standard derives only creation fields without loading local settings', () => {
    const options = { localTargetsFile: new URL('./missing-targets.local.json', import.meta.url) }
    const target: CloudflareProvisioningTarget = resolveCloudflareProvisioningTarget('standard', options)
    expect(target).toEqual({
      accountId: cloudflareTargets.standard.accountId,
      d1: { name: cloudflareTargets.standard.d1.name },
      r2: { name: cloudflareTargets.standard.r2.name },
    })
    expect(target).not.toHaveProperty('kv')
    expect(target.d1).not.toHaveProperty('id')
  })

  test('ALTERNATE can use the local example before storage IDs or deployment settings are filled in', () => {
    const example: { alternate: CloudflareTarget } = JSON.parse(readFileSync(new URL('../config/cloudflare-targets.local.example.json', import.meta.url), 'utf8'))
    const localTargets = { alternate: { ...example.alternate, accountId: fixtureAlternateTarget.accountId, r2: fixtureAlternateTarget.r2 } }
    withLocalTargetsFile(JSON.stringify(localTargets), localTargetsFile => {
      expect(resolveCloudflareProvisioningTarget('alternate', { localTargetsFile })).toEqual({
        accountId: fixtureAlternateTarget.accountId,
        d1: { name: example.alternate.d1.name },
        r2: { name: fixtureAlternateTarget.r2!.name },
      })
      expect(() => resolveCloudflareTarget('alternate', { localTargetsFile })).toThrow('HTTPS activityOrigin')

      const unsetIds = {
        alternate: {
          ...fixtureAlternateTarget,
          d1: { ...fixtureAlternateTarget.d1, id: example.alternate.d1.id },
          kv: { ...fixtureAlternateTarget.kv, id: example.alternate.kv.id },
        },
      }
      writeFileSync(localTargetsFile, JSON.stringify(unsetIds))
      expect(resolveCloudflareProvisioningTarget('alternate', { localTargetsFile }).d1.name).toBe(fixtureAlternateTarget.d1.name)
      expect(() => resolveCloudflareTarget('alternate', { localTargetsFile })).toThrow('invalid d1.id')
      writeFileSync(localTargetsFile, JSON.stringify({ alternate: { ...unsetIds.alternate, d1: fixtureAlternateTarget.d1 } }))
      expect(() => resolveCloudflareTarget('alternate', { localTargetsFile })).toThrow('invalid kv.id')
    })
  })

  test('ALTERNATE creation accepts injected minimal settings and omits absent R2', () => {
    const target = { accountId: fixtureAlternateTarget.accountId, d1: { name: 'fixture-database' } }
    expect(resolveCloudflareProvisioningTarget('alternate', { localTargets: { alternate: target } })).toEqual(target)
    expect(resolveCloudflareProvisioningTarget('alternate', fixtureTargetOptions)).toEqual({
      accountId: fixtureAlternateTarget.accountId,
      d1: { name: fixtureAlternateTarget.d1.name },
      r2: { name: fixtureAlternateTarget.r2!.name },
    })
  })

  test.each(['', ' ', 'YOUR_ALTERNATE_ACCOUNT_ID', '1'.repeat(31), 'g'.repeat(32)])('rejects an invalid creation account: %s', accountId => {
    expect(() => resolveCloudflareProvisioningTarget('alternate', {
      localTargets: { alternate: { accountId, d1: { name: 'fixture-database' } } },
    })).toThrow('invalid accountId')
  })

  test.each(['', '   '])('rejects empty resource names: %s', name => {
    expect(() => resolveCloudflareProvisioningTarget('alternate', {
      localTargets: { alternate: { accountId: fixtureAlternateTarget.accountId, d1: { name } } },
    })).toThrow('invalid d1.name')
    expect(() => resolveCloudflareProvisioningTarget('alternate', {
      localTargets: { alternate: { accountId: fixtureAlternateTarget.accountId, d1: { name: 'fixture-database' }, r2: { name } } },
    })).toThrow('invalid r2.name')
  })

  test('validates the required field types and optional R2 structure', () => {
    const target = { accountId: fixtureAlternateTarget.accountId, d1: { name: 'fixture-database' } }
    for (const [alternate, message] of [
      [{ ...target, accountId: 123 }, 'invalid accountId'],
      [{ ...target, d1: {} }, 'invalid d1.name'],
      [{ ...target, d1: { name: 123 } }, 'invalid d1.name'],
      [{ ...target, d1: null }, 'need an object for d1'],
      [{ ...target, r2: null }, 'need an object for r2'],
      [{ ...target, r2: {} }, 'invalid r2.name'],
      [{ ...target, r2: { name: 123 } }, 'invalid r2.name'],
    ] as const) {
      withLocalTargetsFile(JSON.stringify({ alternate }), localTargetsFile => {
        expect(() => resolveCloudflareProvisioningTarget('alternate', { localTargetsFile })).toThrow(message)
      })
    }
  })

  test('missing ALTERNATE settings never fall back to standard and share the existing file errors', () => {
    expect(() => resolveCloudflareProvisioningTarget('alternate', { localTargets: {} })).toThrow('ALTERNATE target settings are missing')
    expect(() => resolveCloudflareProvisioningTarget('alternate', {
      localTargetsFile: new URL('./missing-targets.local.json', import.meta.url),
    })).toThrow('ALTERNATE target settings were not found')
    expect(() => resolveCloudflareProvisioningTarget('alternate', { localTargetsFile: 'targets.yaml' })).toThrow('must be a JSON file')
    withLocalTargetsFile('{', localTargetsFile => {
      expect(() => resolveCloudflareProvisioningTarget('alternate', { localTargetsFile })).toThrow('ALTERNATE target settings are not valid JSON')
      expect(() => resolveCloudflareTarget('alternate', { localTargetsFile })).toThrow('ALTERNATE target settings are not valid JSON')
    })
    withLocalTargetsFile('{}', localTargetsFile => {
      expect(() => resolveCloudflareProvisioningTarget('alternate', { localTargetsFile })).toThrow('ALTERNATE target settings are missing')
    })
    withLocalTargetsFile('[]', localTargetsFile => {
      expect(() => resolveCloudflareProvisioningTarget('alternate', { localTargetsFile })).toThrow('need an object for targets')
    })
  })
})
