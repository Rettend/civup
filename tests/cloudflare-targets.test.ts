import type {
  CloudflareProvisioningTarget,
  CloudflareStorageLocation,
  CloudflareTarget,
  CloudflareTargetName,
} from '../config/cloudflare-targets.ts'
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

const fixtureStandardTarget = fixtureLocalTargets.standard!

function withLocalTargetsFile(contents: string, run: (file: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'civup-cloudflare-targets-'))
  const file = join(directory, 'targets.local.json')
  try {
    writeFileSync(file, contents)
    run(file)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('Cloudflare target selection', () => {
  test.each([undefined, ''])('rejects an implicit or invalid target: %s', value => {
    expect(() => resolveCloudflareTargetName(value)).toThrow('Set CIVUP_TARGET explicitly to a local target name.')
    expect(() => resolveCloudflareProvisioningTarget(value)).toThrow(
      'Set CIVUP_TARGET explicitly to a local target name.',
    )
  })

  test.each([
    'ALTERNATE',
    ' alternate',
    'alternate ',
    '../outside',
    'one/two',
    'one\\two',
    '.',
    '..',
    '--remote',
    'one--two',
    'one-',
    '1name',
    '__proto__',
    'constructor',
    'prototype',
    'toString',
    'hasOwnProperty',
  ])('rejects an unsafe target name: %s', value => {
    expect(() => resolveCloudflareTargetName(value)).toThrow('Use a target name')
    expect(() => resolveCloudflareTarget(value, fixtureTargetOptions)).toThrow('Use a target name')
    expect(() => resolveCloudflareProvisioningTarget(value, fixtureTargetOptions)).toThrow('Use a target name')
    expect(() => parseCloudflareLocalTargets({ [value]: fixtureAlternateTarget })).toThrow('Use a target name')
  })

  test.each(['weekend-2', 'production', 'dev', 'a'])('loads an arbitrary locally configured target: %s', name => {
    expect(resolveCloudflareTargetName(name)).toBe(name)
    const settings = { [name]: fixtureAlternateTarget }
    expect(parseCloudflareLocalTargets(settings)).toEqual(settings)
    withLocalTargetsFile(JSON.stringify(settings), localTargetsFile => {
      expect(resolveCloudflareTarget(name, { localTargetsFile })).toEqual(fixtureAlternateTarget)
      expect(resolveCloudflareProvisioningTarget(name, { localTargetsFile }).accountId).toBe(
        fixtureAlternateTarget.accountId,
      )
    })
    expect(() => resolveCloudflareTarget(name, fixtureTargetOptions)).toThrow(`${name} target settings are missing`)
  })

  test('unknown targets cannot inherit settings from the config prototype', () => {
    const localTargets = Object.create({ inherited: fixtureAlternateTarget })
    expect(() => resolveCloudflareTarget('inherited', { localTargets })).toThrow(
      'inherited target settings are missing',
    )
    expect(() => resolveCloudflareProvisioningTarget('inherited', { localTargets })).toThrow(
      'inherited target settings are missing',
    )
    expect(parseCloudflareLocalTargets(localTargets)).toEqual({})
  })

  test('parsing validates every record instead of silently dropping unknown names', () => {
    expect(() => parseCloudflareLocalTargets({ standard: fixtureStandardTarget, unfinished: {} })).toThrow(
      'need an object for workers',
    )
    expect(parseCloudflareLocalTargets({})).toEqual({})
  })

  test('the same Worker and database names do not choose the same account or resources', () => {
    const standard = resolveCloudflareTarget('standard', fixtureTargetOptions)
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
    expect(() => resolveCloudflareStorage('alternate', undefined as unknown as CloudflareStorageLocation)).toThrow(
      'Choose local or remote storage explicitly.',
    )
  })

  test('browser and bot IDs come from the same selected target', () => {
    for (const name of ['standard', 'alternate'] as const) {
      const target = resolveCloudflareTarget(name, fixtureTargetOptions)
      expect(cloudflarePublicVariables(target, 'activity').DISCORD_CLIENT_ID).toBe(
        cloudflarePublicVariables(target, 'bot').DISCORD_APPLICATION_ID!,
      )
    }
    expect(cloudflarePublicVariables(fixtureStandardTarget, 'bot').ENABLE_DEBUG_LOBBY_FILL).toBe('1')
    expect(cloudflarePublicVariables(fixtureAlternateTarget, 'bot').ENABLE_DEBUG_LOBBY_FILL).toBeUndefined()
    expect(cloudflarePublicVariables(fixtureStandardTarget, 'bot').ALLOWED_DISCORD_GUILD_IDS).toBeUndefined()
    expect(cloudflarePublicVariables(fixtureAlternateTarget, 'bot').ALLOWED_DISCORD_GUILD_IDS).toBe(
      fixtureAlternateTarget.discord.guildId,
    )
    expect(cloudflarePublicVariables(fixtureAlternateTarget, 'activity')).not.toHaveProperty(
      'ALLOWED_DISCORD_GUILD_IDS',
    )
  })

  test('neither target falls back to the public example when local settings are missing', () => {
    const options = { localTargetsFile: new URL('./missing-targets.local.json', import.meta.url) }
    expect(Object.keys(cloudflareTargets)).toEqual(['standard'])
    for (const name of ['standard', 'alternate'] as const) {
      expect(() => resolveCloudflareTarget(name, options)).toThrow('Local target settings were not found')
      expect(() => resolveCloudflareTarget(name, { localTargets: {} })).toThrow(`${name} target settings are missing`)
      const other = name === 'standard' ? 'alternate' : 'standard'
      expect(() => resolveCloudflareTarget(name, { localTargets: { [other]: fixtureLocalTargets[other] } })).toThrow(
        `${name} target settings are missing`,
      )
    }
  })

  test('standard uses the configured identity and settings instead of the public example', () => {
    const standard = {
      ...fixtureStandardTarget,
      accountId: '66666666666666666666666666666666',
      activityOrigin: 'https://custom-activity.example.invalid',
      d1: { ...fixtureStandardTarget.d1, id: '66666666-6666-4666-8666-666666666666' },
      kv: { ...fixtureStandardTarget.kv, id: '77777777777777777777777777777777' },
      bot: { ...fixtureStandardTarget.bot, variables: {} },
    }
    expect(resolveCloudflareTarget('standard', { localTargets: { standard } })).toEqual(standard)
    withLocalTargetsFile(JSON.stringify({ standard }), localTargetsFile => {
      expect(resolveCloudflareTarget('standard', { localTargetsFile })).toEqual(standard)
      expect(resolveCloudflareStorage('standard', 'remote', { localTargetsFile })).toMatchObject({
        accountId: standard.accountId,
        d1: standard.d1,
        kv: standard.kv,
      })
    })
  })

  test.each(['standard', 'alternate'] as const)('%s ignores unfinished settings for the other target', name => {
    const other = name === 'standard' ? 'alternate' : 'standard'
    const settings = { [name]: fixtureLocalTargets[name], [other]: { accountId: 'YOUR_ACCOUNT_ID' } }
    withLocalTargetsFile(JSON.stringify(settings), localTargetsFile => {
      expect(resolveCloudflareTarget(name, { localTargetsFile })).toEqual(fixtureLocalTargets[name]!)
      expect(resolveCloudflareProvisioningTarget(name, { localTargetsFile })).toEqual(
        resolveCloudflareProvisioningTarget(name, fixtureTargetOptions),
      )
      expect(() => resolveCloudflareTarget(other, { localTargetsFile })).toThrow('need an object for workers')
    })
  })

  test.each(['standard', 'alternate'] as const)(
    '%s metadata validation rejects placeholders, changed Worker names, and secrets',
    name => {
      const fixture = fixtureLocalTargets[name]!
      expect(() => parseCloudflareLocalTargets({ [name]: { ...fixture, accountId: 'YOUR_ACCOUNT_ID' } })).toThrow(
        'invalid accountId',
      )
      expect(() =>
        parseCloudflareLocalTargets({
          [name]: { ...fixture, workers: { ...fixture.workers, bot: 'renamed-bot' } },
        }),
      ).toThrow('invalid workers.bot')
      expect(() =>
        parseCloudflareLocalTargets({
          [name]: { ...fixture, bot: { ...fixture.bot, variables: { DISCORD_TOKEN: 'fixture-value' } } },
        }),
      ).toThrow('Keep secret values out')
      expect(parseCloudflareLocalTargets(fixtureLocalTargets)).toEqual(fixtureLocalTargets)
    },
  )

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
      targets: [fixtureStandardTarget, fixtureAlternateTarget],
      provisioning: ['standard', 'alternate'].map(name =>
        resolveCloudflareProvisioningTarget(name, fixtureTargetOptions),
      ),
    })
  })
})

describe('Cloudflare resource creation target selection', () => {
  test('standard derives only creation fields from configured local settings', () => {
    const target: CloudflareProvisioningTarget = resolveCloudflareProvisioningTarget('standard', fixtureTargetOptions)
    expect(target).toEqual({
      accountId: fixtureStandardTarget.accountId,
      d1: { name: fixtureStandardTarget.d1.name },
      r2: { name: fixtureStandardTarget.r2!.name },
    })
    expect(target).not.toHaveProperty('kv')
    expect(target.d1).not.toHaveProperty('id')
  })

  test.each(['standard', 'alternate'] as const)(
    '%s can use the local example before storage IDs or deployment settings are filled in',
    name => {
      const examples: Record<CloudflareTargetName, CloudflareTarget> = JSON.parse(
        readFileSync(new URL('../config/cloudflare-targets.local.example.json', import.meta.url), 'utf8'),
      )
      const example = examples[name]!
      const fixture = fixtureLocalTargets[name]!
      const localTargets = { [name]: { ...example, accountId: fixture.accountId, r2: fixture.r2 } }
      withLocalTargetsFile(JSON.stringify(localTargets), localTargetsFile => {
        expect(resolveCloudflareProvisioningTarget(name, { localTargetsFile })).toEqual({
          accountId: fixture.accountId,
          d1: { name: example.d1.name },
          r2: { name: fixture.r2!.name },
        })
        expect(() => resolveCloudflareTarget(name, { localTargetsFile })).toThrow('HTTPS activityOrigin')

        const unsetIds = {
          [name]: {
            ...fixture,
            d1: { ...fixture.d1, id: example.d1.id },
            kv: { ...fixture.kv, id: example.kv.id },
          },
        }
        writeFileSync(localTargetsFile, JSON.stringify(unsetIds))
        expect(resolveCloudflareProvisioningTarget(name, { localTargetsFile }).d1.name).toBe(fixture.d1.name)
        expect(() => resolveCloudflareTarget(name, { localTargetsFile })).toThrow('invalid d1.id')
        writeFileSync(localTargetsFile, JSON.stringify({ [name]: { ...unsetIds[name], d1: fixture.d1 } }))
        expect(() => resolveCloudflareTarget(name, { localTargetsFile })).toThrow('invalid kv.id')
      })
    },
  )

  test.each(['standard', 'alternate'] as const)(
    '%s creation accepts injected minimal settings and omits absent R2',
    name => {
      const fixture = fixtureLocalTargets[name]!
      const target = { accountId: fixture.accountId, d1: { name: 'fixture-database' } }
      expect(resolveCloudflareProvisioningTarget(name, { localTargets: { [name]: target } })).toEqual(target)
      expect(resolveCloudflareProvisioningTarget(name, fixtureTargetOptions)).toEqual({
        accountId: fixture.accountId,
        d1: { name: fixture.d1.name },
        r2: { name: fixture.r2!.name },
      })
    },
  )

  test.each(['', ' ', 'YOUR_ALTERNATE_ACCOUNT_ID', '1'.repeat(31), 'g'.repeat(32)])(
    'rejects an invalid creation account: %s',
    accountId => {
      expect(() =>
        resolveCloudflareProvisioningTarget('alternate', {
          localTargets: { alternate: { accountId, d1: { name: 'fixture-database' } } },
        }),
      ).toThrow('invalid accountId')
    },
  )

  test.each(['', '   '])('rejects empty resource names: %s', name => {
    expect(() =>
      resolveCloudflareProvisioningTarget('alternate', {
        localTargets: { alternate: { accountId: fixtureAlternateTarget.accountId, d1: { name } } },
      }),
    ).toThrow('invalid d1.name')
    expect(() =>
      resolveCloudflareProvisioningTarget('alternate', {
        localTargets: {
          alternate: { accountId: fixtureAlternateTarget.accountId, d1: { name: 'fixture-database' }, r2: { name } },
        },
      }),
    ).toThrow('invalid r2.name')
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

  test.each(['standard', 'alternate'] as const)(
    'missing %s settings never fall back to examples and share file errors',
    name => {
      expect(() => resolveCloudflareProvisioningTarget(name, { localTargets: {} })).toThrow(
        `${name} target settings are missing`,
      )
      expect(() =>
        resolveCloudflareProvisioningTarget(name, {
          localTargetsFile: new URL('./missing-targets.local.json', import.meta.url),
        }),
      ).toThrow('Local target settings were not found')
      expect(() => resolveCloudflareProvisioningTarget(name, { localTargetsFile: 'targets.yaml' })).toThrow(
        'must be a JSON file',
      )
      withLocalTargetsFile('{', localTargetsFile => {
        expect(() => resolveCloudflareProvisioningTarget(name, { localTargetsFile })).toThrow(
          'Local target settings are not valid JSON',
        )
        expect(() => resolveCloudflareTarget(name, { localTargetsFile })).toThrow(
          'Local target settings are not valid JSON',
        )
      })
      withLocalTargetsFile('{}', localTargetsFile => {
        expect(() => resolveCloudflareProvisioningTarget(name, { localTargetsFile })).toThrow(
          `${name} target settings are missing`,
        )
      })
      withLocalTargetsFile('[]', localTargetsFile => {
        expect(() => resolveCloudflareProvisioningTarget(name, { localTargetsFile })).toThrow(
          'need an object for targets',
        )
      })
    },
  )
})
