import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

export type CloudflareTargetName = 'standard' | 'ppl'
export type CloudflareWorker = 'bot' | 'activity'
export type CloudflareStorageLocation = 'local' | 'remote'

interface WorkerCompatibility {
  readonly compatibilityDate: string
  readonly compatibilityFlags: readonly string[]
}

export interface CloudflareTarget {
  readonly accountId: string
  readonly workers: { readonly bot: 'civup-bot'; readonly activity: 'civup-activity' }
  readonly discord: {
    readonly applicationId: string
    readonly publicKey: string
    readonly guildId: string
    readonly guildIds?: string
  }
  readonly activityOrigin: string
  readonly d1: {
    readonly binding: 'DB'
    readonly name: string
    readonly id: string
    readonly migrationsDirectory: string
    readonly migrationsTable: string
    readonly migrationsPattern: string
  }
  readonly kv: { readonly binding: 'KV'; readonly id: string }
  readonly r2?: { readonly binding: 'AUTOSAVE_UPLOADS'; readonly name: string }
  readonly bot: WorkerCompatibility & {
    readonly keepVars: boolean
    readonly variables: Readonly<Record<string, string>> & { readonly ENABLE_DEBUG_LOBBY_FILL?: string }
    readonly fontGlobs: readonly string[]
  }
  readonly activity: WorkerCompatibility
}

export interface CloudflareProvisioningTarget {
  readonly accountId: string
  readonly d1: { readonly name: string }
  readonly r2?: { readonly name: string }
}

export interface CloudflareStorageSelection {
  readonly target: CloudflareTargetName
  readonly location: CloudflareStorageLocation
  readonly accountId: string
  readonly d1: CloudflareTarget['d1']
  readonly kv: CloudflareTarget['kv']
  readonly r2?: CloudflareTarget['r2']
  readonly persistenceDirectory: string | undefined
}

export interface CloudflareLocalTargets {
  readonly ppl?: CloudflareTarget
}

export interface CloudflareTargetOptions {
  readonly localTargets?: CloudflareLocalTargets
  readonly localTargetsFile?: string | URL
}

export interface CloudflareProvisioningTargetOptions extends Pick<CloudflareTargetOptions, 'localTargetsFile'> {
  readonly localTargets?: { readonly ppl?: CloudflareProvisioningTarget }
}

const defaultLocalTargetsFile = new URL('./cloudflare-targets.local.json', import.meta.url)
const missingPplTargetMessage =
  'PPL target settings are missing. Add a ppl entry to config/cloudflare-targets.local.json.'

// Paths in shared target data are relative to the repository, not a caller's cwd.
export const cloudflareLocalPersistenceDirectory = 'apps/bot/.wrangler/state'
// Names only. Secret values remain in the existing secret/env files.
export const cloudflareSecretKeys = {
  bot: ['DISCORD_TOKEN', 'CIVUP_SECRET'],
  activity: ['DISCORD_CLIENT_SECRET', 'CIVUP_SECRET'],
} as const

const migrations = {
  migrationsDirectory: 'packages/db/migrations',
  migrationsTable: 'd1_migrations',
  migrationsPattern: '*.sql',
} as const

// These tags are deployed history. The cf 0.23 schema cannot represent them.
// Keep them until deployment tooling can preserve the existing namespaces.
export const botDurableObjectMigrations = [
  { tag: 'v3', newSqliteClasses: ['SessionDO'] },
  { tag: 'v4', newSqliteClasses: ['Activity'] },
  { tag: 'v5', newSqliteClasses: ['MaintenanceDO'] },
] as const

export const botCronSchedules = ['0 * * * *', '*/15 * * * *', '0 0,2,4,6,8,10,12,14,16,18,20 * * *'] as const

// Tracked public identity only. Importing performs no I/O or env loading.
// PPL account details deliberately remain in the git-ignored local JSON file.
export const cloudflareTargets = {
  standard: {
    accountId: 'bee9950f4935b08fbc80f8e9ea881286',
    workers: { bot: 'civup-bot', activity: 'civup-activity' },
    discord: {
      applicationId: '1469447716751933533',
      publicKey: '9848e4e0f1a377fe65e7fc4699e499c3c1f4c1f0a3ca3b7ea78b2bc34ea0ee9b',
      guildId: '1372172102362337362',
    },
    activityOrigin: 'https://civup-activity.rettend.workers.dev',
    d1: { binding: 'DB', name: 'civup', id: 'c8a78a06-ac43-467a-8056-3df1da6fd729', ...migrations },
    kv: { binding: 'KV', id: '12f56ed27c7944c8b997fadf1d63530c' },
    r2: { binding: 'AUTOSAVE_UPLOADS', name: 'civup-autosave-uploads' },
    bot: {
      compatibilityDate: '2025-02-19',
      compatibilityFlags: ['nodejs_compat'],
      keepVars: true,
      variables: { ENABLE_DEBUG_LOBBY_FILL: '1' },
      fontGlobs: ['**/*.woff2'],
    },
    activity: { compatibilityDate: '2025-01-01', compatibilityFlags: [] },
  },
} as const satisfies Readonly<Partial<Record<CloudflareTargetName, CloudflareTarget>>>

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Local PPL target settings need an object for ${field}.`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, field: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || !value.trim() || (pattern && !pattern.test(value))) {
    throw new Error(`Local PPL target settings have an invalid ${field}.`)
  }
  return value
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string' && item.trim())) {
    throw new Error(`Local PPL target settings need a list of strings for ${field}.`)
  }
  return value
}

function identity<const T extends string>(value: unknown, expected: T, field: string): T {
  if (value !== expected) throw new Error(`Local PPL target settings have an invalid ${field}.`)
  return expected
}

function compatibility(value: unknown, field: string): WorkerCompatibility {
  const config = object(value, field)
  return {
    compatibilityDate: string(config.compatibilityDate, `${field}.compatibilityDate`, /^\d{4}-\d{2}-\d{2}$/),
    compatibilityFlags: strings(config.compatibilityFlags, `${field}.compatibilityFlags`),
  }
}

export function parseCloudflareLocalTargets(value: unknown): CloudflareLocalTargets {
  const root = object(value, 'targets')
  if (root.ppl === undefined) return {}
  const target = object(root.ppl, 'ppl')
  const workers = object(target.workers, 'workers')
  const discord = object(target.discord, 'discord')
  const d1 = object(target.d1, 'd1')
  const kv = object(target.kv, 'kv')
  const bot = object(target.bot, 'bot')
  const variables = Object.fromEntries(
    Object.entries(object(bot.variables, 'bot.variables')).map(([key, value]) => {
      if (Object.values(cloudflareSecretKeys).some(keys => keys.some(name => name === key))) {
        throw new Error('Keep secret values out of the local target settings. Use the existing secret files.')
      }
      if (
        [
          'ACTIVITY_PUBLIC_ORIGIN',
          'ALLOWED_DISCORD_GUILD_ID',
          'ALLOWED_DISCORD_GUILD_IDS',
          'DISCORD_APPLICATION_ID',
          'DISCORD_CLIENT_ID',
          'DISCORD_PUBLIC_KEY',
        ].includes(key)
      ) {
        throw new Error('Put Discord and Activity settings in their named target fields, not bot.variables.')
      }
      return [key, string(value, `bot.variables.${key}`)]
    }),
  )
  if (typeof bot.keepVars !== 'boolean') throw new Error('Local PPL target settings need a boolean for bot.keepVars.')
  const activityOrigin = string(target.activityOrigin, 'activityOrigin')
  try {
    const origin = new URL(activityOrigin)
    if (origin.protocol !== 'https:' || origin.origin !== activityOrigin)
      throw new Error('Public HTTPS origin required')
  } catch {
    throw new Error('Local PPL target settings need an HTTPS activityOrigin.')
  }
  const r2 = target.r2 === undefined ? undefined : object(target.r2, 'r2')
  return {
    ppl: {
      accountId: string(target.accountId, 'accountId', /^[a-f0-9]{32}$/),
      workers: {
        bot: identity(workers.bot, 'civup-bot', 'workers.bot'),
        activity: identity(workers.activity, 'civup-activity', 'workers.activity'),
      },
      discord: {
        applicationId: string(discord.applicationId, 'discord.applicationId', /^\d{17,20}$/),
        publicKey: string(discord.publicKey, 'discord.publicKey', /^[a-f0-9]{64}$/),
        guildId: string(discord.guildId, 'discord.guildId', /^\d{17,20}$/),
        ...(discord.guildIds === undefined
          ? {}
          : { guildIds: string(discord.guildIds, 'discord.guildIds', /^\d{17,20}(,\d{17,20})*$/) }),
      },
      activityOrigin,
      d1: {
        binding: identity(d1.binding, 'DB', 'd1.binding'),
        name: string(d1.name, 'd1.name'),
        id: string(d1.id, 'd1.id', /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
        migrationsDirectory: string(d1.migrationsDirectory, 'd1.migrationsDirectory'),
        migrationsTable: string(d1.migrationsTable, 'd1.migrationsTable'),
        migrationsPattern: string(d1.migrationsPattern, 'd1.migrationsPattern'),
      },
      kv: { binding: identity(kv.binding, 'KV', 'kv.binding'), id: string(kv.id, 'kv.id', /^[a-f0-9]{32}$/) },
      ...(r2 === undefined
        ? {}
        : {
            r2: {
              binding: identity(r2.binding, 'AUTOSAVE_UPLOADS', 'r2.binding'),
              name: string(r2.name, 'r2.name'),
            },
          }),
      bot: {
        ...compatibility(bot, 'bot'),
        keepVars: bot.keepVars,
        variables,
        fontGlobs: strings(bot.fontGlobs, 'bot.fontGlobs'),
      },
      activity: compatibility(target.activity, 'activity'),
    },
  }
}

function readCloudflareLocalTargets(file: string | URL = defaultLocalTargetsFile): unknown {
  const path = file instanceof URL ? fileURLToPath(file) : file
  if (!/\.json$/i.test(path)) throw new Error('Local target settings must be a JSON file.')
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      throw new Error(
        `PPL target settings were not found at ${path}. Copy config/cloudflare-targets.local.example.json to config/cloudflare-targets.local.json and fill in your local settings.`,
      )
    }
    throw new Error(`Could not read PPL target settings at ${path}.`, { cause: error })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error(`PPL target settings are not valid JSON: ${path}.`)
  }
  return parsed
}

export function loadCloudflareLocalTargets(file: string | URL = defaultLocalTargetsFile): CloudflareLocalTargets {
  return parseCloudflareLocalTargets(readCloudflareLocalTargets(file))
}

export function resolveCloudflareTargetName(value: string | undefined): CloudflareTargetName {
  if (value === 'standard' || value === 'ppl') return value
  throw new Error('Set CIVUP_TARGET to standard or ppl explicitly.')
}

export function resolveCloudflareTarget(
  value: string | undefined,
  options: CloudflareTargetOptions = {},
): CloudflareTarget {
  const name = resolveCloudflareTargetName(value)
  if (name === 'standard') return cloudflareTargets.standard
  const local = options.localTargets ?? loadCloudflareLocalTargets(options.localTargetsFile)
  if (!local.ppl) throw new Error(missingPplTargetMessage)
  return local.ppl
}

function provisioningTarget(value: unknown): CloudflareProvisioningTarget {
  const target = object(value, 'ppl')
  const d1 = object(target.d1, 'd1')
  const r2 = target.r2 === undefined ? undefined : object(target.r2, 'r2')
  return {
    accountId: string(target.accountId, 'accountId', /^[a-f0-9]{32}$/),
    d1: { name: string(d1.name, 'd1.name') },
    ...(r2 === undefined ? {} : { r2: { name: string(r2.name, 'r2.name') } }),
  }
}

// Resource creation needs names and an account, not existing storage IDs or
// Worker settings. Deployment and migrations still use the full target.
export function resolveCloudflareProvisioningTarget(
  value: string | undefined,
  options: CloudflareProvisioningTargetOptions = {},
): CloudflareProvisioningTarget {
  const name = resolveCloudflareTargetName(value)
  if (name === 'standard') return provisioningTarget(cloudflareTargets.standard)
  const local = object(options.localTargets ?? readCloudflareLocalTargets(options.localTargetsFile), 'targets')
  if (local.ppl === undefined) throw new Error(missingPplTargetMessage)
  return provisioningTarget(local.ppl)
}

function commonPublicVariables(target: CloudflareTarget) {
  return {
    ACTIVITY_PUBLIC_ORIGIN: target.activityOrigin,
    ALLOWED_DISCORD_GUILD_ID: target.discord.guildId,
  }
}

function botPublicVariables(target: CloudflareTarget) {
  return {
    ...commonPublicVariables(target),
    DISCORD_APPLICATION_ID: target.discord.applicationId,
    DISCORD_PUBLIC_KEY: target.discord.publicKey,
    ...(target.discord.guildIds === undefined ? {} : { ALLOWED_DISCORD_GUILD_IDS: target.discord.guildIds }),
    ...target.bot.variables,
  }
}

function activityPublicVariables(target: CloudflareTarget) {
  return { ...commonPublicVariables(target), DISCORD_CLIENT_ID: target.discord.applicationId }
}

export function cloudflarePublicVariables(
  target: CloudflareTarget,
  worker: 'bot',
): ReturnType<typeof botPublicVariables>
export function cloudflarePublicVariables(
  target: CloudflareTarget,
  worker: 'activity',
): ReturnType<typeof activityPublicVariables>
export function cloudflarePublicVariables(target: CloudflareTarget, worker: CloudflareWorker): Record<string, string>
export function cloudflarePublicVariables(target: CloudflareTarget, worker: CloudflareWorker) {
  return worker === 'bot' ? botPublicVariables(target) : activityPublicVariables(target)
}

// Transport is a separate, required choice. Selecting PPL never implies remote.
export function resolveCloudflareStorage(
  value: string | undefined,
  location: CloudflareStorageLocation,
  options: CloudflareTargetOptions = {},
): CloudflareStorageSelection {
  if (location !== 'local' && location !== 'remote') throw new Error('Choose local or remote storage explicitly.')
  const name = resolveCloudflareTargetName(value)
  const target = resolveCloudflareTarget(name, options)
  return {
    target: name,
    location,
    accountId: target.accountId,
    d1: target.d1,
    kv: target.kv,
    r2: target.r2,
    persistenceDirectory: location === 'local' ? cloudflareLocalPersistenceDirectory : undefined,
  }
}
