import type { Env } from '../../env.ts'
import { parseRoleIds } from '../permissions/index.ts'

export type LaunchMode = 'activity' | 'browser'

export interface BrowserAccessState {
  enabled: boolean
  preferenceRoleId: string | null
}

export interface BrowserAccessConfig {
  origin: string
  preferenceRoleId: string
  guildId: string | null
}

export type LaunchModeResolution
  = | { ok: true, mode: LaunchMode, config: BrowserAccessConfig | null }
    | { ok: false, error: string }

interface BrowserAccessStateCacheEntry {
  expiresAt: number
  state: BrowserAccessState
}

interface StoredBrowserAccessState {
  enabled?: unknown
  preferenceRoleId?: unknown
}

export interface BrowserAccessIntent {
  enabled: boolean
  preferenceRoleId: string | null
  valid: boolean
}

const BROWSER_ACCESS_STATE_KEY = 'system:browser-access'
const BROWSER_ACCESS_STATE_CACHE_MS = 60_000
let browserAccessStateCache = new WeakMap<KVNamespace, Map<string, BrowserAccessStateCacheEntry>>()

interface BrowserAccessScope {
  guildId?: string | null
  legacyGuildId?: string | null
}

export async function getBrowserAccessState(kv: KVNamespace, scope: BrowserAccessScope = {}): Promise<BrowserAccessState> {
  const key = browserAccessStateKey(scope.guildId)
  const cached = browserAccessStateCache.get(kv)?.get(key)
  if (cached && cached.expiresAt > Date.now()) return cached.state

  let stored = await kv.get(key, 'json') as StoredBrowserAccessState | null
  if (!stored && scope.guildId && scope.guildId === scope.legacyGuildId) {
    stored = await kv.get(BROWSER_ACCESS_STATE_KEY, 'json') as StoredBrowserAccessState | null
  }
  const state = normalizeBrowserAccessState(stored)
  cacheBrowserAccessState(kv, key, state)
  return state
}

export async function getBrowserAccessIntent(kv: KVNamespace, scope: BrowserAccessScope = {}): Promise<BrowserAccessIntent> {
  let stored = await kv.get(browserAccessStateKey(scope.guildId), 'json') as StoredBrowserAccessState | null
  if (!stored && scope.guildId && scope.guildId === scope.legacyGuildId) stored = await kv.get(BROWSER_ACCESS_STATE_KEY, 'json') as StoredBrowserAccessState | null
  const enabled = stored?.enabled === true
  const preferenceRoleId = normalizeDiscordId(stored?.preferenceRoleId)
  return {
    enabled,
    preferenceRoleId,
    valid: !enabled || preferenceRoleId != null,
  }
}

export async function setBrowserAccessState(kv: KVNamespace, state: BrowserAccessState, guildId?: string | null): Promise<void> {
  const normalized = normalizeBrowserAccessState(state)
  const key = browserAccessStateKey(guildId)
  await kv.put(key, JSON.stringify(normalized))
  cacheBrowserAccessState(kv, key, normalized)
}

export async function resolveBrowserAccessConfig(env: Env['Bindings'], guildId?: string | null): Promise<BrowserAccessConfig | null> {
  const state = await getBrowserAccessState(env.KV, { guildId, legacyGuildId: env.ALLOWED_DISCORD_GUILD_ID })
  if (!state.enabled || !state.preferenceRoleId) return null

  const origin = normalizePublicOrigin(env.ACTIVITY_PUBLIC_ORIGIN)
  if (!origin) return null
  return { origin, preferenceRoleId: state.preferenceRoleId, guildId: guildId ?? null }
}

export async function resolveInteractionLaunchMode(
  env: Env['Bindings'],
  memberRoles: unknown,
  guildId?: string | null,
): Promise<LaunchModeResolution> {
  const state = await getBrowserAccessState(env.KV, { guildId, legacyGuildId: env.ALLOWED_DISCORD_GUILD_ID })
  if (!state.enabled) {
    return { ok: true, mode: 'activity', config: null }
  }

  const config = await resolveBrowserAccessConfig(env, guildId)
  if (!config) {
    return { ok: false, error: 'Browser access is enabled but not fully configured. Please contact a server administrator.' }
  }
  if (!Array.isArray(memberRoles)) {
    return { ok: false, error: 'Could not read your Discord roles. Please use this control inside the configured server and try again.' }
  }

  return {
    ok: true,
    mode: parseRoleIds(memberRoles).includes(config.preferenceRoleId) ? 'browser' : 'activity',
    config,
  }
}

export function buildBrowserSessionUrl(config: BrowserAccessConfig, sessionId: string): string {
  return appendSourceGuild(`${config.origin}/web/session/${encodeURIComponent(sessionId)}`, config.guildId)
}

export function buildBrowserChannelUrl(config: BrowserAccessConfig, channelId: string): string {
  return appendSourceGuild(`${config.origin}/web/channel/${encodeURIComponent(channelId)}`, config.guildId)
}

function appendSourceGuild(value: string, guildId: string | null): string {
  if (!guildId) return value
  const url = new URL(value)
  url.searchParams.set('sourceGuild', guildId)
  return url.toString()
}

export function normalizePublicOrigin(value: string | undefined): string | null {
  const normalized = value?.trim() ?? ''
  if (!normalized) return null
  try {
    const url = new URL(normalized)
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null
    return url.origin
  }
  catch {
    return null
  }
}

export function normalizeDiscordId(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : ''
  return /^\d{17,20}$/.test(normalized) ? normalized : null
}

export function isSafeBrowserPreferenceRole(role: {
  hoist?: unknown
  managed?: unknown
  mentionable?: unknown
  permissions?: unknown
}): boolean {
  return role.managed === false
    && role.permissions === '0'
    && role.hoist === false
    && role.mentionable === false
}

export function resetBrowserAccessStateCache(): void {
  browserAccessStateCache = new WeakMap<KVNamespace, Map<string, BrowserAccessStateCacheEntry>>()
}

function normalizeBrowserAccessState(value: StoredBrowserAccessState | BrowserAccessState | null): BrowserAccessState {
  const preferenceRoleId = normalizeDiscordId(value?.preferenceRoleId)
  return {
    enabled: value?.enabled === true && preferenceRoleId != null,
    preferenceRoleId,
  }
}

function cacheBrowserAccessState(kv: KVNamespace, key: string, state: BrowserAccessState): void {
  const cache = browserAccessStateCache.get(kv) ?? new Map<string, BrowserAccessStateCacheEntry>()
  cache.set(key, {
    expiresAt: Date.now() + BROWSER_ACCESS_STATE_CACHE_MS,
    state,
  })
  browserAccessStateCache.set(kv, cache)
}

function browserAccessStateKey(guildId?: string | null): string {
  return guildId ? `${BROWSER_ACCESS_STATE_KEY}:${guildId}` : BROWSER_ACCESS_STATE_KEY
}
