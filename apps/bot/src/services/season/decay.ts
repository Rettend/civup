import type { Database } from '@civup/db'
import type { PublicRatingDecayState } from '@civup/rating'
import { publicRatingDecayPolicies } from '@civup/db'
import { settlePublicRatingDecay } from '@civup/rating'
import { getDisplaySeason } from './index.ts'

export async function loadPublicRatingDecayPolicy(db: Database) {
  const policies = await db.select().from(publicRatingDecayPolicies).limit(2)
  if (policies.length > 1) throw new Error('Multiple RP decay policies require a versioned transition.')
  return policies[0] ?? null
}

export async function projectPublicRatingDecay<T extends { publicRating?: number | null, publicDecay?: PublicRatingDecayState | null }>(
  db: Database, rows: readonly T[], now = Date.now(), selectedSeason?: { ratingSystem: string, startsAt: number, endsAt: number | null } | null,
): Promise<T[]> {
  const season = selectedSeason === undefined ? await getDisplaySeason(db) : selectedSeason
  if (season?.ratingSystem !== 'rp') return [...rows]
  const policy = await loadPublicRatingDecayPolicy(db)
  if (!policy) return [...rows]
  const at = Math.min(now, season.endsAt ?? now)
  return rows.map(row => {
    if (row.publicRating == null) return row
    const decay = settlePublicRatingDecay(row.publicRating, row.publicDecay, at, policy, season.startsAt)
    return { ...row, publicRating: decay.rating, publicDecay: decay.state }
  })
}

export function samePublicRatingDecay(a: PublicRatingDecayState | null | undefined, b: PublicRatingDecayState | null | undefined) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}
