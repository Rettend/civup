import type { Env } from '../../env.ts'

const DEFAULT_ACTIVITY_DATA_ADMIN_USER_IDS = new Set(['992886382366492711'])

export function isActivityDataAdmin(env: Env['Bindings'], userId: string): boolean {
  if (DEFAULT_ACTIVITY_DATA_ADMIN_USER_IDS.has(userId)) return true
  return (env.AUTOSAVE_ADMIN_USER_IDS?.split(',') ?? []).some(id => id.trim() === userId)
}
