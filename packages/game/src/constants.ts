export const MAX_TIMER_SECONDS = 30 * 60
export const DEFAULT_BANS_PER_TEAM = 3
export const MIN_BANS_PER_TEAM = 1
export const MAX_BANS_PER_TEAM = 5

export function normalizeBansPerTeam(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_BANS_PER_TEAM
  const rounded = Math.round(value)
  return rounded >= MIN_BANS_PER_TEAM && rounded <= MAX_BANS_PER_TEAM ? rounded : DEFAULT_BANS_PER_TEAM
}
