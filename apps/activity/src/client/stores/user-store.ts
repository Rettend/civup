import type { ActivityIdentity } from '@civup/utils'
import { createSignal } from 'solid-js'

// ── State ──────────────────────────────────────────────────

export const [user, setUser] = createSignal<ActivityIdentity | null>(null)

/** Set the authenticated user (called after Discord SDK auth) */
export function setAuthenticatedUser(identity: ActivityIdentity) {
  setUser(identity)
}

// ── Derived Helpers ────────────────────────────────────────

/** Discord user ID */
export function userId(): string | null {
  return user()?.userId ?? null
}

/** Display name (global_name or username) */
export function displayName(): string {
  const u = user()
  if (!u) return ''
  return u.displayName ?? ''
}

/** Avatar URL */
export function avatarUrl(): string | null {
  const u = user()
  if (!u) return null
  return u.avatarUrl
}

/** Verified server context used to launch or sign into the Activity. */
export function guildId(): string | null {
  return user()?.guildId ?? null
}
