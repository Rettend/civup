export type ServerConfigKey = 'ban_timer' | 'pick_timer' | 'queue_timeout' | 'match_category'

interface ServerConfigValues {
  banTimerSeconds: number
  pickTimerSeconds: number
  queueTimeoutMinutes: number
  matchCategoryId: string | null
}

interface DraftTimerConfig {
  banTimerSeconds: number | null
  pickTimerSeconds: number | null
}

interface ConfigSetResult {
  ok: boolean
  value?: string
  error?: string
}

const CONFIG_KEY_PREFIX = 'config:'

export const SERVER_CONFIG_KEYS = ['ban_timer', 'pick_timer', 'queue_timeout', 'match_category'] as const satisfies readonly ServerConfigKey[]

export const SERVER_CONFIG_DESCRIPTIONS: Record<ServerConfigKey, string> = {
  ban_timer: 'Ban phase timer in seconds',
  pick_timer: 'Pick phase timer in seconds',
  queue_timeout: 'Queue timeout in minutes',
  match_category: 'Category ID for temp voice channels',
}

export const MAX_CONFIG_TIMER_SECONDS = 30 * 60
export const DEFAULT_QUEUE_TIMEOUT_MINUTES = 30
export const DEFAULT_BAN_TIMER_SECONDS = 120
export const DEFAULT_PICK_TIMER_SECONDS = 60
const MAX_QUEUE_TIMEOUT_MINUTES = 24 * 60
const RESET_VALUES = new Set(['null', 'default'])

function configKey(key: ServerConfigKey): string {
  return `${CONFIG_KEY_PREFIX}${key}`
}

function parseIntegerInput(value: string): number | null {
  if (!/^-?\d+$/.test(value)) return null
  const numeric = Number(value)
  if (!Number.isSafeInteger(numeric)) return null
  return numeric
}

function parseStoredTimerSeconds(value: string | null, fallback: number): number {
  if (!value) return fallback
  const parsed = parseIntegerInput(value.trim())
  if (parsed == null) return fallback
  if (parsed < 0 || parsed > MAX_CONFIG_TIMER_SECONDS) return fallback
  return parsed
}

function parseStoredQueueTimeoutMinutes(value: string | null): number {
  if (!value) return DEFAULT_QUEUE_TIMEOUT_MINUTES
  const parsed = parseIntegerInput(value.trim())
  if (parsed == null) return DEFAULT_QUEUE_TIMEOUT_MINUTES
  if (parsed <= 0 || parsed > MAX_QUEUE_TIMEOUT_MINUTES) return DEFAULT_QUEUE_TIMEOUT_MINUTES
  return parsed
}

function parseStoredCategoryId(value: string | null): string | null {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed
}

function defaultTimerSecondsForKey(key: 'ban_timer' | 'pick_timer'): number {
  if (key === 'ban_timer') return DEFAULT_BAN_TIMER_SECONDS
  return DEFAULT_PICK_TIMER_SECONDS
}

function formatOptionalText(value: string | null): string {
  if (value == null) return 'null'
  return value
}

async function getServerConfigValues(kv: KVNamespace): Promise<ServerConfigValues> {
  const [banTimerRaw, pickTimerRaw, queueTimeoutRaw, matchCategoryRaw] = await Promise.all([
    kv.get(configKey('ban_timer')),
    kv.get(configKey('pick_timer')),
    kv.get(configKey('queue_timeout')),
    kv.get(configKey('match_category')),
  ])

  return {
    banTimerSeconds: parseStoredTimerSeconds(banTimerRaw, DEFAULT_BAN_TIMER_SECONDS),
    pickTimerSeconds: parseStoredTimerSeconds(pickTimerRaw, DEFAULT_PICK_TIMER_SECONDS),
    queueTimeoutMinutes: parseStoredQueueTimeoutMinutes(queueTimeoutRaw),
    matchCategoryId: parseStoredCategoryId(matchCategoryRaw),
  }
}

export function parseServerConfigKey(key: string | undefined): ServerConfigKey | null {
  if (!key) return null
  const normalized = key.trim().toLowerCase()
  if (normalized === 'ban_timer') return 'ban_timer'
  if (normalized === 'pick_timer') return 'pick_timer'
  if (normalized === 'queue_timeout') return 'queue_timeout'
  if (normalized === 'match_category') return 'match_category'
  return null
}

export async function getServerConfigDisplayValue(
  kv: KVNamespace,
  key: ServerConfigKey,
): Promise<string> {
  const values = await getServerConfigValues(kv)

  if (key === 'ban_timer') return String(values.banTimerSeconds)
  if (key === 'pick_timer') return String(values.pickTimerSeconds)
  if (key === 'queue_timeout') return String(values.queueTimeoutMinutes)
  return formatOptionalText(values.matchCategoryId)
}

export async function getServerConfigRows(
  kv: KVNamespace,
): Promise<Array<{ key: ServerConfigKey, value: string, description: string }>> {
  const values = await getServerConfigValues(kv)
  return [
    {
      key: 'ban_timer',
      value: String(values.banTimerSeconds),
      description: SERVER_CONFIG_DESCRIPTIONS.ban_timer,
    },
    {
      key: 'pick_timer',
      value: String(values.pickTimerSeconds),
      description: SERVER_CONFIG_DESCRIPTIONS.pick_timer,
    },
    {
      key: 'queue_timeout',
      value: String(values.queueTimeoutMinutes),
      description: SERVER_CONFIG_DESCRIPTIONS.queue_timeout,
    },
    {
      key: 'match_category',
      value: formatOptionalText(values.matchCategoryId),
      description: SERVER_CONFIG_DESCRIPTIONS.match_category,
    },
  ]
}

export async function setServerConfigValue(
  kv: KVNamespace,
  key: ServerConfigKey,
  value: string,
): Promise<ConfigSetResult> {
  const trimmed = value.trim()
  const lowered = trimmed.toLowerCase()
  const shouldReset = RESET_VALUES.has(lowered)

  if (key === 'ban_timer' || key === 'pick_timer') {
    if (shouldReset) {
      await kv.delete(configKey(key))
      return { ok: true, value: String(defaultTimerSecondsForKey(key)) }
    }

    const parsed = parseIntegerInput(trimmed)
    if (parsed == null || parsed < 0 || parsed > MAX_CONFIG_TIMER_SECONDS) {
      return {
        ok: false,
        error: `\`${key}\` must be an integer between 0 and ${MAX_CONFIG_TIMER_SECONDS}, or \`null\` to reset to default (${defaultTimerSecondsForKey(key)}).`,
      }
    }

    await kv.put(configKey(key), String(parsed))
    return { ok: true, value: String(parsed) }
  }

  if (key === 'queue_timeout') {
    if (shouldReset) {
      await kv.delete(configKey(key))
      return { ok: true, value: String(DEFAULT_QUEUE_TIMEOUT_MINUTES) }
    }

    const parsed = parseIntegerInput(trimmed)
    if (parsed == null || parsed <= 0 || parsed > MAX_QUEUE_TIMEOUT_MINUTES) {
      return {
        ok: false,
        error: `\`${key}\` must be an integer between 1 and ${MAX_QUEUE_TIMEOUT_MINUTES}, or \`null\` to reset to ${DEFAULT_QUEUE_TIMEOUT_MINUTES}.`,
      }
    }

    await kv.put(configKey(key), String(parsed))
    return { ok: true, value: String(parsed) }
  }

  if (shouldReset) {
    await kv.delete(configKey(key))
    return { ok: true, value: 'null' }
  }

  if (!/^\d{17,20}$/.test(trimmed)) {
    return {
      ok: false,
      error: `\`${key}\` must be a Discord snowflake (17-20 digits), or \`null\` to clear it.`,
    }
  }

  await kv.put(configKey(key), trimmed)
  return { ok: true, value: trimmed }
}

export async function resolveDraftTimerConfig(
  kv: KVNamespace,
  draftConfig: DraftTimerConfig,
): Promise<DraftTimerConfig> {
  const values = await getServerConfigValues(kv)
  return {
    banTimerSeconds: draftConfig.banTimerSeconds ?? values.banTimerSeconds,
    pickTimerSeconds: draftConfig.pickTimerSeconds ?? values.pickTimerSeconds,
  }
}

export async function getServerDraftTimerDefaults(kv: KVNamespace): Promise<DraftTimerConfig> {
  const values = await getServerConfigValues(kv)
  return {
    banTimerSeconds: values.banTimerSeconds,
    pickTimerSeconds: values.pickTimerSeconds,
  }
}

export async function getQueueTimeoutMs(kv: KVNamespace): Promise<number> {
  const values = await getServerConfigValues(kv)
  return values.queueTimeoutMinutes * 60 * 1000
}
