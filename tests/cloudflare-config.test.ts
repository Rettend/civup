import type activityCloudflareConfig from '../apps/activity/cloudflare.config.ts'
import type botCloudflareConfig from '../apps/bot/cloudflare.config.ts'
import type { CloudflareTargetName } from '../config/cloudflare-targets.ts'
import type { InferEnv, UnwrapConfig } from 'cf/config'
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  botDurableObjectMigrations,
  cloudflareSecretKeys,
  resolveCloudflareStorage,
  resolveCloudflareTarget,
} from '../config/cloudflare-targets.ts'
import { assertCloudflareDeploymentSupported, createBotLegacyDeploymentConfig } from '../config/cloudflare-workers.ts'
import { fixtureLocalTargetsFile, fixturePplTarget, fixtureTargetOptions } from './cloudflare-fixtures.ts'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))

// Compile-time checks protect cf workers types from broad helper annotations
// that would turn its inferred Env into an empty map or a string index signature.
type KnownBindingName<T> = string extends keyof T ? never : keyof T
type BotEnvironment = InferEnv<UnwrapConfig<typeof botCloudflareConfig>['worker']>
type ActivityEnvironment = InferEnv<UnwrapConfig<typeof activityCloudflareConfig>['worker']>
const botBindingNames = [
  'DB',
  'KV',
  'Activity',
  'SessionDO',
  'MaintenanceDO',
  'DISCORD_TOKEN',
  'CIVUP_SECRET',
  'DISCORD_APPLICATION_ID',
] as const satisfies readonly KnownBindingName<BotEnvironment>[]
const activityBindingNames = [
  'BOT',
  'ASSETS',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'CIVUP_SECRET',
] as const satisfies readonly KnownBindingName<ActivityEnvironment>[]

interface LegacyConfig {
  name: string
  account_id: string
  main: string
  compatibility_date: string
  compatibility_flags?: string[]
  keep_vars?: boolean
  vars: Record<string, string>
  observability: { logs: { enabled: boolean; invocation_logs: boolean } }
  d1_databases?: { binding: string; database_name: string; database_id: string; migrations_dir?: string }[]
  kv_namespaces?: { binding: string; id: string }[]
  r2_buckets?: { binding: string; bucket_name: string }[]
  durable_objects?: { bindings: { name: string; class_name: string; script_name?: string }[] }
  migrations?: { tag: string; new_sqlite_classes: string[] }[]
  rules?: { type: string; globs: string[]; fallthrough: boolean }[]
  triggers?: { crons: string[] }
  services?: { binding: string; service: string }[]
  assets?: { binding: string; directory?: string; not_found_handling: string }
}

function legacyConfig(worker: 'bot' | 'activity', target: CloudflareTargetName): LegacyConfig {
  if (target === 'ppl') {
    // Synthetic PPL expectations, not the intentionally untracked local config.
    const base = legacyConfig(worker, 'standard')
    const fixture = fixturePplTarget
    const vars = {
      ACTIVITY_PUBLIC_ORIGIN: fixture.activityOrigin,
      ALLOWED_DISCORD_GUILD_ID: fixture.discord.guildId,
    }
    if (worker === 'activity')
      return {
        ...base,
        account_id: fixture.accountId,
        compatibility_flags: [...fixture.activity.compatibilityFlags],
        vars: { ...vars, DISCORD_CLIENT_ID: fixture.discord.applicationId },
      }
    return {
      ...base,
      account_id: fixture.accountId,
      compatibility_flags: [...fixture.bot.compatibilityFlags],
      vars: {
        ...vars,
        DISCORD_APPLICATION_ID: fixture.discord.applicationId,
        DISCORD_PUBLIC_KEY: fixture.discord.publicKey,
        ALLOWED_DISCORD_GUILD_IDS: fixture.discord.guildIds!,
      },
      d1_databases: base.d1_databases!.map(binding => ({ ...binding, database_id: fixture.d1.id })),
      kv_namespaces: [{ binding: fixture.kv.binding, id: fixture.kv.id }],
      r2_buckets: [{ binding: fixture.r2!.binding, bucket_name: fixture.r2!.name }],
      rules: [{ type: 'Data', globs: [...fixture.bot.fontGlobs], fallthrough: false }],
    }
  }
  const extension = worker === 'bot' ? 'jsonc' : 'json'
  const filename = `${worker}.legacy.${extension}`
  const content = readFileSync(resolve(repoRoot, `tests/fixtures/cloudflare/${filename}`), 'utf8')
  // Strip comments, not URL slashes or escaped quotes in JSON strings.
  const parsed: LegacyConfig & { $schema?: string } = JSON.parse(
    content.replace(/("(?:\\.|[^"\\])*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, (_match, string) => string ?? ''),
  )
  const { $schema: _schema, ...config } = parsed
  return config
}

interface LoadedConfig {
  target: CloudflareTargetName
  worker: 'bot' | 'activity'
  wrangler: LegacyConfig
  exports?: Record<string, { type: string; storage: string }>
  secrets: string[]
  bindingNames: string[]
  tooling?: { rules: LegacyConfig['rules'] }
  dependencies: string[]
}

function loadUnderNode(): LoadedConfig[] {
  const source = `
    import { resolve } from 'node:path'
    import { loadAndParseConfig, loadConfig, convertToWranglerConfig } from '@cloudflare/config'
    const loaded = []
    for (const target of ['standard', 'ppl']) {
      process.env.CIVUP_TARGET = target
      for (const worker of ['bot', 'activity']) {
        const { result, dependencies } = await loadAndParseConfig(resolve('apps', worker, 'cloudflare.config.ts'), { mode: target, isPreview: false })
        if (!result.success) throw result.error
        let tooling
        if (worker === 'bot') {
          const { config } = await loadConfig(resolve('apps/bot/wrangler.config.ts'))
          tooling = typeof config === 'function' ? await config({ mode: target, isPreview: false }) : await config
        }
        const secrets = Object.entries(result.data.worker.env).filter(([, value]) => value.type === 'secret').map(([name]) => name)
        loaded.push({ target, worker, wrangler: convertToWranglerConfig(result.data), exports: result.data.worker.exports, secrets, bindingNames: Object.keys(result.data.worker.env), tooling, dependencies: [...dependencies] })
      }
    }
    console.log(JSON.stringify(loaded))
  `
  const result = spawnSync('node', ['--input-type=module', '--eval', source], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      // A stray account override must not select a different account in config.
      CLOUDFLARE_ACCOUNT_ID: 'wrong-account',
      CF_SEND_TELEMETRY: 'false',
      WRANGLER_SEND_METRICS: 'false',
      CIVUP_LOCAL_TARGETS_FILE: fixtureLocalTargetsFile,
    },
  })
  expect(result.status, result.stderr || String(result.error ?? '')).toBe(0)
  return JSON.parse(result.stdout)
}

describe('Node-loaded Cloudflare config parity', () => {
  test('configuration mode does not supply an implicit deployment target', () => {
    const source = `
      import assert from 'node:assert/strict'
      import { resolve } from 'node:path'
      import { loadAndParseConfig } from '@cloudflare/config'
      for (const worker of ['bot', 'activity']) {
        for (const target of [undefined, '', 'production']) {
          if (target === undefined) delete process.env.CIVUP_TARGET
          else process.env.CIVUP_TARGET = target
          await assert.rejects(
            loadAndParseConfig(resolve('apps', worker, 'cloudflare.config.ts'), { mode: 'production', isPreview: false }),
            /Set CIVUP_TARGET to standard or ppl explicitly/
          )
        }
      }
    `
    const result = spawnSync('node', ['--input-type=module', '--eval', source], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    })
    expect(result.status, result.stderr || String(result.error ?? '')).toBe(0)
  })

  test('both targets preserve all supported Worker deployment settings', () => {
    const loaded = loadUnderNode()
    expect(loaded).toHaveLength(4)
    for (const current of loaded) {
      const legacy = legacyConfig(current.worker, current.target)
      const converted = current.wrangler
      expect(converted.account_id).toBe(legacy.account_id)
      expect(converted.name).toBe(legacy.name)
      expect(converted.main).toBe(legacy.main)
      expect(converted.compatibility_date).toBe(legacy.compatibility_date)
      expect(converted.compatibility_flags ?? []).toEqual(legacy.compatibility_flags ?? [])
      expect(converted.vars).toEqual(legacy.vars)
      expect(current.secrets).toEqual([...cloudflareSecretKeys[current.worker]])
      expect(current.bindingNames).toEqual(
        expect.arrayContaining(current.worker === 'bot' ? botBindingNames : activityBindingNames),
      )
      expect(converted.observability).toEqual(legacy.observability)
      expect(current.dependencies.some(path => /[\\/]config[\\/]cloudflare-targets\.ts$/.test(path))).toBe(true)
      expect(
        current.dependencies.every(path => !path.endsWith('src/index.ts') && !path.endsWith('src/server/index.ts')),
      ).toBe(true)

      if (current.worker === 'activity') {
        expect(converted.services).toEqual(legacy.services)
        const { directory: _directory, ...assetBehavior } = legacy.assets!
        expect(converted.assets).toEqual(assetBehavior)
        continue
      }

      expect(converted.d1_databases).toEqual(
        legacy.d1_databases!.map(({ migrations_dir: _directory, ...binding }) => binding),
      )
      expect(converted.kv_namespaces).toEqual(legacy.kv_namespaces!)
      expect(converted.r2_buckets).toEqual(legacy.r2_buckets!)
      expect(converted.triggers).toEqual(legacy.triggers!)
      expect(converted.keep_vars).toBeUndefined()
      expect(converted.migrations).toBeUndefined()
      expect(current.tooling?.rules).toEqual(legacy.rules!)
      expect(
        converted.durable_objects?.bindings
          .map(({ script_name, ...binding }) => {
            expect(script_name).toBe(legacy.name)
            return binding
          })
          .sort((a, b) => a.name.localeCompare(b.name)),
      ).toEqual(legacy.durable_objects!.bindings.toSorted((a, b) => a.name.localeCompare(b.name)))
      expect(Object.keys(current.exports ?? {}).sort()).toEqual(
        legacy.durable_objects!.bindings.map(binding => binding.class_name).sort(),
      )
      for (const declaration of Object.values(current.exports ?? {})) {
        expect(declaration).toEqual({ type: 'durable-object', storage: 'sqlite' })
      }
    }
  })

  test('keeps migration bookkeeping and unsupported bot settings instead of claiming deploy parity', () => {
    for (const name of ['standard', 'ppl'] as const) {
      const legacy = legacyConfig('bot', name)
      const target = resolveCloudflareTarget(name, fixtureTargetOptions)
      expect<boolean>(target.bot.keepVars).toBe(legacy.keep_vars!)
      const history: NonNullable<LegacyConfig['migrations']> = botDurableObjectMigrations.map(
        ({ tag, newSqliteClasses }) => ({ tag, new_sqlite_classes: [...newSqliteClasses] }),
      )
      expect(history).toEqual(legacy.migrations!)
      const storage = resolveCloudflareStorage(name, 'local', fixtureTargetOptions)
      expect(resolve(repoRoot, storage.d1.migrationsDirectory)).toBe(
        resolve(repoRoot, 'apps/bot', legacy.d1_databases![0]!.migrations_dir!),
      )
      expect(storage.d1.migrationsTable).toBe('d1_migrations')
      expect(storage.d1.migrationsPattern).toBe('*.sql')
    }
    expect(() => assertCloudflareDeploymentSupported('bot')).toThrow('v3, v4, v5')
    expect(() => assertCloudflareDeploymentSupported('bot')).toThrow('keep_vars')
    expect(() => assertCloudflareDeploymentSupported('bot', 'wrangler-adapter')).not.toThrow()
    expect(() => assertCloudflareDeploymentSupported('activity')).not.toThrow()
  })

  test('the derived Wrangler adapter preserves the complete legacy bot deployment configuration', () => {
    for (const name of ['standard', 'ppl'] as const) {
      const target = resolveCloudflareTarget(name, fixtureTargetOptions)
      const config = createBotLegacyDeploymentConfig(target)
      expect<LegacyConfig>(config).toEqual(legacyConfig('bot', name))
      expect(config.account_id).toBe(target.accountId)
      expect(config.migrations.map(migration => migration.tag)).toEqual(['v3', 'v4', 'v5'])
    }
  })
})
