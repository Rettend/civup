export const PUBLIC_RATING_DECAY_VERSION = 'rp-decay-v1'
export const PUBLIC_RATING_DECAY = { entry: 1550, floor: 1500, reserveDays: 60, daysPerGame: 14, ratingPerDay: 2 } as const
const DAY = 86_400_000

/** Exact next rounded display change for an already-settled rating; no polling is needed. */
export function nextPublicRatingDisplayChangeAt(rating: number, state: PublicRatingDecayState | null | undefined, now: number): number | null {
  if (!state?.active || rating <= PUBLIC_RATING_DECAY.floor || Math.round(rating) <= PUBLIC_RATING_DECAY.floor) return null
  const remaining = rating - (Math.round(rating) - 0.5)
  return Math.max(now, state.bankUntil) + Math.max(1, Math.ceil(remaining / PUBLIC_RATING_DECAY.ratingPerDay * DAY) + 1)
}

export interface PublicRatingDecayState {
  version: string
  bankUntil: number
  checkedAt: number
  active: boolean
}

export interface PublicRatingDecayPolicy {
  version: string
  enabledAt: number
}

export function settlePublicRatingDecay(rating: number, state: PublicRatingDecayState | null | undefined, at: number, policy: PublicRatingDecayPolicy, eligibleSince = policy.enabledAt) {
  if (policy.version !== PUBLIC_RATING_DECAY_VERSION || !Number.isSafeInteger(policy.enabledAt) || policy.enabledAt < 0) throw new Error('Unknown or invalid RP decay policy.')
  if (!Number.isFinite(rating) || rating < 0 || !Number.isSafeInteger(at) || at < 0) throw new Error('Invalid RP decay input.')
  if (state && (state.version !== policy.version || !Number.isSafeInteger(state.bankUntil) || !Number.isSafeInteger(state.checkedAt) || state.bankUntil < 0 || state.checkedAt < policy.enabledAt || typeof state.active !== 'boolean')) throw new Error('Invalid RP decay state.')
  at = Math.max(at, state?.checkedAt ?? 0)
  if (at < policy.enabledAt) {
    if (state) throw new Error('RP decay state predates its policy.')
    return { rating, state: null, delta: 0 }
  }
  const start = Math.max(policy.enabledAt, eligibleSince)
  const previous = state ?? (rating >= PUBLIC_RATING_DECAY.entry && at >= start
    ? { version: policy.version, bankUntil: start + PUBLIC_RATING_DECAY.reserveDays * DAY, checkedAt: start, active: true }
    : null)
  if (!previous) return { rating, state: null, delta: 0 }
  const elapsed = previous.active ? Math.max(0, at - Math.max(previous.checkedAt, previous.bankUntil)) : 0
  const after = Math.max(Math.min(rating, PUBLIC_RATING_DECAY.floor), rating - elapsed / DAY * PUBLIC_RATING_DECAY.ratingPerDay)
  return { rating: after, state: { ...previous, checkedAt: at, active: previous.active && after > PUBLIC_RATING_DECAY.floor }, delta: after - rating }
}

export function recordPublicRatingDecayGame(ratingAfter: number, state: PublicRatingDecayState | null, at: number, policy: PublicRatingDecayPolicy, earnsActivity = true): PublicRatingDecayState | null {
  at = Math.max(at, state?.checkedAt ?? 0)
  if (at < policy.enabledAt) return null
  const settled = settlePublicRatingDecay(ratingAfter, state, at, policy, at).state
  if (!settled) return null
  return {
    ...settled,
    bankUntil: earnsActivity ? Math.min(at + PUBLIC_RATING_DECAY.reserveDays * DAY, Math.max(at, settled.bankUntil) + PUBLIC_RATING_DECAY.daysPerGame * DAY) : settled.bankUntil,
    active: ratingAfter > PUBLIC_RATING_DECAY.floor && (settled.active || ratingAfter >= PUBLIC_RATING_DECAY.entry),
  }
}
