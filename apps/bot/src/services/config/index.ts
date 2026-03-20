export type ServerConfigKey = 'ban_timer' | 'pick_timer'

interface ServerConfigValues {
  banTimerSeconds: number
  pickTimerSeconds: number
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

export const SERVER_CONFIG_KEYS = ['ban_timer', 'pick_timer'] as const satisfies readonly ServerConfigKey[]

export const SERVER_CONFIG_DESCRIPTIONS: Record<ServerConfigKey, string> = {
  ban_timer: 'Ban phase timer in seconds',
  pick_timer: 'Pick phase timer in seconds',
}

export const MAX_CONFIG_TIMER_SECONDS = 30 * 60
export const DEFAULT_BAN_TIMER_SECONDS = 180
export const DEFAULT_PICK_TIMER_SECONDS = 180
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

function defaultTimerSecondsForKey(key: ServerConfigKey): number {
  if (key === 'ban_timer') return DEFAULT_BAN_TIMER_SECONDS
  return DEFAULT_PICK_TIMER_SECONDS
}

async function getServerConfigValues(kv: KVNamespace): Promise<ServerConfigValues> {
  const [banTimerRaw, pickTimerRaw] = await Promise.all([
    kv.get(configKey('ban_timer')),
    kv.get(configKey('pick_timer')),
  ])

  return {
    banTimerSeconds: parseStoredTimerSeconds(banTimerRaw, DEFAULT_BAN_TIMER_SECONDS),
    pickTimerSeconds: parseStoredTimerSeconds(pickTimerRaw, DEFAULT_PICK_TIMER_SECONDS),
  }
}

export function parseServerConfigKey(key: string | undefined): ServerConfigKey | null {
  if (!key) return null
  const normalized = key.trim().toLowerCase()
  if (normalized === 'ban_timer') return 'ban_timer'
  if (normalized === 'pick_timer') return 'pick_timer'
  return null
}

export async function getServerConfigDisplayValue(
  kv: KVNamespace,
  key: ServerConfigKey,
): Promise<string> {
  const values = await getServerConfigValues(kv)

  if (key === 'ban_timer') return String(values.banTimerSeconds)
  return String(values.pickTimerSeconds)
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
