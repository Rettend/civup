import type { CloudflareConfig, TextBinding, WorkerConfig } from '@cloudflare/config/public'
import type { CloudflareTarget, CloudflareWorker } from './cloudflare-targets.ts'
import { bindings, exports, triggers } from '@cloudflare/config/public'
import { botCronSchedules, botDurableObjectMigrations, cloudflarePublicVariables, cloudflareSecretKeys } from './cloudflare-targets.ts'

function textBindings<T extends Record<string, string | undefined>>(variables: T) {
  return Object.fromEntries(Object.entries(variables)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => [name, bindings.text(value!)])) as { [K in keyof T]: TextBinding<Extract<T[K], string>> }
}

const secretBindings = {
  bot: {
    [cloudflareSecretKeys.bot[0]]: bindings.secret(),
    [cloudflareSecretKeys.bot[1]]: bindings.secret(),
  },
  activity: {
    [cloudflareSecretKeys.activity[0]]: bindings.secret(),
    [cloudflareSecretKeys.activity[1]]: bindings.secret(),
  },
}

const sessionClass = botDurableObjectMigrations[0].newSqliteClasses[0]
const activityClass = botDurableObjectMigrations[1].newSqliteClasses[0]
const maintenanceClass = botDurableObjectMigrations[2].newSqliteClasses[0]

const observability = { logs: { enabled: true, invocationLogs: true } }

export function createBotCloudflareConfig(target: CloudflareTarget) {
  const worker = {
    name: target.workers.bot,
    entrypoint: 'src/index.ts',
    compatibilityDate: target.bot.compatibilityDate,
    compatibilityFlags: [...target.bot.compatibilityFlags],
    env: {
      ...textBindings(cloudflarePublicVariables(target, 'bot')),
      ...secretBindings.bot,
      [target.d1.binding]: bindings.d1({ name: target.d1.name, id: target.d1.id }),
      [target.kv.binding]: bindings.kv({ id: target.kv.id }),
      ...(target.r2 === undefined ? {} : { [target.r2.binding]: bindings.r2({ name: target.r2.name }) }),
      [sessionClass]: bindings.durableObject({ worker: target.workers.bot, exportName: sessionClass }),
      [activityClass]: bindings.durableObject({ worker: target.workers.bot, exportName: activityClass }),
      [maintenanceClass]: bindings.durableObject({ worker: target.workers.bot, exportName: maintenanceClass }),
    },
    exports: {
      [sessionClass]: exports.durableObject({ storage: 'sqlite' }),
      [activityClass]: exports.durableObject({ storage: 'sqlite' }),
      [maintenanceClass]: exports.durableObject({ storage: 'sqlite' }),
    },
    triggers: botCronSchedules.map(schedule => triggers.scheduled({ schedule })),
    observability,
  } satisfies WorkerConfig
  return { accountId: target.accountId, worker } satisfies CloudflareConfig
}

export function createActivityCloudflareConfig(target: CloudflareTarget) {
  return {
    accountId: target.accountId,
    worker: {
      name: target.workers.activity,
      entrypoint: 'src/server/index.ts',
      compatibilityDate: target.activity.compatibilityDate,
      compatibilityFlags: [...target.activity.compatibilityFlags],
      env: {
        ...textBindings(cloudflarePublicVariables(target, 'activity')),
        ...secretBindings.activity,
        BOT: bindings.worker({ worker: target.workers.bot }),
        ASSETS: bindings.assets(),
      },
      assets: { notFoundHandling: 'single-page-application' },
      observability,
    },
  } satisfies CloudflareConfig
}

export function createBotWranglerConfig(target: CloudflareTarget) {
  // The app's defineWranglerConfig checks this against Wrangler's build schema.
  return { rules: [{ type: 'Data' as const, globs: [...target.bot.fontGlobs], fallthrough: false }] }
}

// Unsupported-operation adapter only: the new schema has no tagged migration
// history or keep_vars. Derive them from the same target data, never another
// maintained deployment config. A caller writing this to a temporary directory
// must make main and migrations_dir absolute before invoking Wrangler.
export function createBotLegacyDeploymentConfig(target: CloudflareTarget) {
  return {
    name: target.workers.bot,
    account_id: target.accountId,
    main: 'src/index.ts',
    keep_vars: target.bot.keepVars,
    compatibility_date: target.bot.compatibilityDate,
    compatibility_flags: [...target.bot.compatibilityFlags],
    rules: createBotWranglerConfig(target).rules,
    vars: cloudflarePublicVariables(target, 'bot'),
    durable_objects: { bindings: [activityClass, sessionClass, maintenanceClass]
      .map(name => ({ name, class_name: name })) },
    migrations: botDurableObjectMigrations.map(migration => ({
      tag: migration.tag,
      new_sqlite_classes: [...migration.newSqliteClasses],
    })),
    d1_databases: [{
      binding: target.d1.binding,
      database_name: target.d1.name,
      database_id: target.d1.id,
      migrations_dir: `../../${target.d1.migrationsDirectory}`,
      ...(target.d1.migrationsTable === 'd1_migrations' ? {} : { migrations_table: target.d1.migrationsTable }),
    }],
    kv_namespaces: [{ binding: target.kv.binding, id: target.kv.id }],
    ...(target.r2 === undefined ? {} : { r2_buckets: [{ binding: target.r2.binding, bucket_name: target.r2.name }] }),
    triggers: { crons: [...botCronSchedules] },
    observability: { logs: { enabled: true, invocation_logs: true } },
  }
}

// cf@1.0.0-beta.12 / @cloudflare/config@0.23.0 cannot encode these
// deployment settings. Use the derived Wrangler adapter for bot deployment.
export const botCloudflareDeploymentBlockers = [
  'Tagged Durable Object migrations (v3, v4, v5) are not supported by the cf configuration schema.',
  'keep_vars is not supported by the cf configuration schema.',
] as const

export function assertCloudflareDeploymentSupported(worker: CloudflareWorker, driver: 'cf' | 'wrangler-adapter' = 'cf'): void {
  if (worker === 'bot' && driver === 'cf') {
    throw new Error(`Native cf bot deployment is blocked: ${botCloudflareDeploymentBlockers.join(' ')} Use the derived Wrangler deployment adapter.`)
  }
}
