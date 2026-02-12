import type { Auth } from '~/client/discord'
import { createSignal } from 'solid-js'

// ── State ──────────────────────────────────────────────────

export const [user, setUser] = createSignal<Auth | null>(null)

/** Set the authenticated user (called after Discord SDK auth) */
export function setAuthenticatedUser(auth: Auth) {
  setUser(auth)
}

// ── Derived Helpers ────────────────────────────────────────

/** Discord user ID */
export function userId(): string | null {
  return user()?.user.id ?? null
}

/** Display name (global_name or username) */
export function displayName(): string {
  const u = user()
  if (!u) return ''
  return u.user.global_name ?? u.user.username
}

/** Avatar URL */
export function avatarUrl(): string | null {
  const u = user()
  if (!u?.user.avatar) return null
  return `https://cdn.discordapp.com/avatars/${u.user.id}/${u.user.avatar}.png?size=128`
}
