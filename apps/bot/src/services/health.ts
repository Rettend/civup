import type { Env } from '../env.ts'
import { EXPECTED_GUILD_COMMANDS } from '../commands/expected.ts'
import { getBrowserAccessIntent, isSafeBrowserPreferenceRole, normalizeDiscordId, normalizePublicOrigin } from './activity/browser-access.ts'

export type HealthCheckStatus = 'OK' | 'WARN' | 'FAIL'

export interface HealthCheckResult {
  name: string
  status: HealthCheckStatus
  reason?: string
}

interface DiscordApplication {
  id?: unknown
  verify_key?: unknown
  interactions_endpoint_url?: unknown
}

interface DiscordCommand {
  name?: unknown
  type?: unknown
}

interface DiscordRole {
  id?: unknown
  permissions?: unknown
  managed?: unknown
  hoist?: unknown
  mentionable?: unknown
}

interface HealthOptions {
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  interactionEndpointUrl?: string
}

const DISCORD_API = 'https://discord.com/api/v10'
const HEALTH_KV_KEY = 'system:health-probe'

export async function runHealthChecks(env: Env['Bindings'], options: HealthOptions = {}): Promise<HealthCheckResult[]> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? 3_000
  const applicationId = env.DISCORD_APPLICATION_ID?.trim() ?? ''
  const publicKey = env.DISCORD_PUBLIC_KEY?.trim() ?? ''
  const guildId = env.ALLOWED_DISCORD_GUILD_ID?.trim() ?? ''
  const activityOrigin = normalizePublicOrigin(env.ACTIVITY_PUBLIC_ORIGIN)
  const endpoint = normalizeEndpoint(options.interactionEndpointUrl)

  const checks = [
    runCheck('Config', timeoutMs, async () => {
      const invalid: string[] = []
      if (!normalizeDiscordId(applicationId)) invalid.push('application ID')
      if (!/^[a-f\d]{64}$/i.test(publicKey)) invalid.push('public key')
      if (!env.DISCORD_TOKEN?.trim()) invalid.push('bot token')
      if (!env.CIVUP_SECRET?.trim()) invalid.push('CIVUP secret')
      if (!normalizeDiscordId(guildId)) invalid.push('guild ID')
      if (!activityOrigin) invalid.push('Activity origin')
      if (!env.SessionDO || !env.Activity) invalid.push('Durable Object bindings')
      return invalid.length === 0 ? ok('Config') : fail('Config', `invalid ${invalid.join(', ')}`)
    }),
    runCheck('Discord application', timeoutMs, async () => {
      if (!normalizeDiscordId(applicationId) || !/^[a-f\d]{64}$/i.test(publicKey) || !env.DISCORD_TOKEN?.trim()) {
        return fail('Discord application', 'config is invalid')
      }
      const application = await discordGet<DiscordApplication>(fetchImpl, '/oauth2/applications/@me', env.DISCORD_TOKEN, timeoutMs)
      if (application.id !== applicationId) return fail('Discord application', 'application ID does not match')
      if (typeof application.verify_key !== 'string' || application.verify_key.toLowerCase() !== publicKey.toLowerCase()) {
        return fail('Discord application', 'public key does not match')
      }
      const configuredEndpoint = normalizeEndpoint(application.interactions_endpoint_url)
      if (!endpoint || !configuredEndpoint || endpoint !== configuredEndpoint) {
        return fail('Discord application', 'interactions endpoint does not match')
      }
      return ok('Discord application')
    }),
    runCheck('Discord server', timeoutMs, async () => {
      if (!normalizeDiscordId(guildId) || !env.DISCORD_TOKEN?.trim()) return fail('Discord server', 'guild config is invalid')
      await discordGet(fetchImpl, `/guilds/${guildId}`, env.DISCORD_TOKEN, timeoutMs)
      return ok('Discord server')
    }),
    runCheck('Commands', timeoutMs, async () => {
      if (!normalizeDiscordId(applicationId) || !normalizeDiscordId(guildId) || !env.DISCORD_TOKEN?.trim()) return fail('Commands', 'command config is invalid')
      const commands = await discordGet<DiscordCommand[]>(fetchImpl, `/applications/${applicationId}/guilds/${guildId}/commands`, env.DISCORD_TOKEN, timeoutMs)
      if (!Array.isArray(commands)) return fail('Commands', 'Discord returned an invalid command list')
      const registered = new Set(commands.map(command => `${typeof command.type === 'number' ? command.type : 1}:${String(command.name ?? '')}`))
      const missing = EXPECTED_GUILD_COMMANDS.filter(command => !registered.has(`${command.type}:${command.name}`))
      return missing.length === 0 ? ok('Commands') : fail('Commands', `missing ${missing.map(command => command.name).join(', ')}`)
    }),
    runCheck('D1', timeoutMs, async () => {
      const row = await env.DB.prepare('SELECT 1 AS ok').bind().first<{ ok: number }>()
      return row?.ok === 1 ? ok('D1') : fail('D1', 'SELECT 1 returned no row')
    }),
    runCheck('KV', timeoutMs, async () => {
      await env.KV.get(HEALTH_KV_KEY)
      return ok('KV')
    }),
    runCheck('Saved game uploads', timeoutMs, async () => {
      if (!env.AUTOSAVE_UPLOADS) return warn('Saved game uploads', 'disabled')
      await env.AUTOSAVE_UPLOADS.list({ limit: 1 })
      return ok('Saved game uploads')
    }),
    runCheck('Activity', timeoutMs, async () => {
      if (!activityOrigin) return fail('Activity', 'public origin is invalid')
      const response = await fetchWithTimeout(fetchImpl, activityOrigin, { method: 'HEAD', redirect: 'manual' }, timeoutMs)
      return response.ok ? ok('Activity') : fail('Activity', `HTTP ${response.status}`)
    }),
    runCheck('Browser Access', timeoutMs, async () => {
      const intent = await getBrowserAccessIntent(env.KV)
      if (!intent.enabled) return ok('Browser Access', 'disabled')
      if (!intent.valid || !activityOrigin || !intent.preferenceRoleId || !normalizeDiscordId(guildId) || !env.DISCORD_TOKEN?.trim()) {
        return fail('Browser Access', 'enabled configuration is invalid')
      }
      const roles = await discordGet<DiscordRole[]>(fetchImpl, `/guilds/${guildId}/roles`, env.DISCORD_TOKEN, timeoutMs)
      const role = Array.isArray(roles) ? roles.find(candidate => candidate.id === intent.preferenceRoleId) : null
      if (!role) return fail('Browser Access', 'preference role is missing')
      if (!isSafeBrowserPreferenceRole(role)) return fail('Browser Access', 'preference role permissions are unsafe')
      return ok('Browser Access')
    }),
  ]

  return Promise.all(checks)
}

export function formatHealthReport(results: readonly HealthCheckResult[]): string {
  return ['CivUp health', ...results.map((result) => {
    const reason = result.reason ? ` — ${sanitizeReason(result.reason)}` : ''
    return `${result.status} ${result.name}${reason}`
  })].join('\n')
}

async function runCheck(name: string, timeoutMs: number, check: () => Promise<HealthCheckResult>): Promise<HealthCheckResult> {
  try {
    return await withTimeout(check(), timeoutMs)
  }
  catch (error) {
    if (error instanceof HealthTimeoutError) return fail(name, 'timed out')
    return fail(name, describeError(error))
  }
}

async function discordGet<T = unknown>(fetchImpl: typeof globalThis.fetch, path: string, token: string, timeoutMs: number): Promise<T> {
  const response = await fetchWithTimeout(fetchImpl, `${DISCORD_API}${path}`, {
    headers: { Authorization: `Bot ${token}` },
  }, timeoutMs)
  if (!response.ok) throw new Error(`Discord HTTP ${response.status}`)
  return response.json<T>()
}

async function fetchWithTimeout(fetchImpl: typeof globalThis.fetch, input: RequestInfo | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(input, { ...init, signal: controller.signal })
  }
  finally {
    clearTimeout(timer)
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new HealthTimeoutError()), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  }
  finally {
    if (timer) clearTimeout(timer)
  }
}

class HealthTimeoutError extends Error {}

function normalizeEndpoint(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value)
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  }
  catch {
    return null
  }
}

function ok(name: string, reason?: string): HealthCheckResult {
  return { name, status: 'OK', reason }
}

function warn(name: string, reason: string): HealthCheckResult {
  return { name, status: 'WARN', reason }
}

function fail(name: string, reason: string): HealthCheckResult {
  return { name, status: 'FAIL', reason }
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'timed out'
  if (error instanceof Error && error.message.trim()) return error.message
  return 'check failed'
}

function sanitizeReason(reason: string): string {
  return reason.replace(/[\r\n]+/g, ' ').slice(0, 160)
}
