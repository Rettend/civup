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

const BROWSER_ACCESS_STATE_KEY = 'system:browser-access'
const BROWSER_ACCESS_STATE_CACHE_MS = 60_000
let browserAccessStateCache = new WeakMap<KVNamespace, BrowserAccessStateCacheEntry>()

export async function getBrowserAccessState(kv: KVNamespace): Promise<BrowserAccessState> {
  const cached = browserAccessStateCache.get(kv)
  if (cached && cached.expiresAt > Date.now()) return cached.state

  const stored = await kv.get(BROWSER_ACCESS_STATE_KEY, 'json') as StoredBrowserAccessState | null
  const state = normalizeBrowserAccessState(stored)
  cacheBrowserAccessState(kv, state)
  return state
}

export async function setBrowserAccessState(kv: KVNamespace, state: BrowserAccessState): Promise<void> {
  const normalized = normalizeBrowserAccessState(state)
  await kv.put(BROWSER_ACCESS_STATE_KEY, JSON.stringify(normalized))
  cacheBrowserAccessState(kv, normalized)
}

export async function resolveBrowserAccessConfig(env: Env['Bindings']): Promise<BrowserAccessConfig | null> {
  const state = await getBrowserAccessState(env.KV)
  if (!state.enabled || !state.preferenceRoleId) return null

  const origin = normalizePublicOrigin(env.ACTIVITY_PUBLIC_ORIGIN)
  if (!origin) return null
  return { origin, preferenceRoleId: state.preferenceRoleId }
}

export async function resolveInteractionLaunchMode(
  env: Env['Bindings'],
  memberRoles: unknown,
): Promise<LaunchModeResolution> {
  const state = await getBrowserAccessState(env.KV)
  if (!state.enabled) {
    return { ok: true, mode: 'activity', config: null }
  }

  const config = await resolveBrowserAccessConfig(env)
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
  return `${config.origin}/web/session/${encodeURIComponent(sessionId)}`
}

export function buildBrowserChannelUrl(config: BrowserAccessConfig, channelId: string): string {
  return `${config.origin}/web/channel/${encodeURIComponent(channelId)}`
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

export function resetBrowserAccessStateCache(): void {
  browserAccessStateCache = new WeakMap<KVNamespace, BrowserAccessStateCacheEntry>()
}

function normalizeBrowserAccessState(value: StoredBrowserAccessState | BrowserAccessState | null): BrowserAccessState {
  const preferenceRoleId = normalizeDiscordId(value?.preferenceRoleId)
  return {
    enabled: value?.enabled === true && preferenceRoleId != null,
    preferenceRoleId,
  }
}

function cacheBrowserAccessState(kv: KVNamespace, state: BrowserAccessState): void {
  browserAccessStateCache.set(kv, {
    expiresAt: Date.now() + BROWSER_ACCESS_STATE_CACHE_MS,
    state,
  })
}
