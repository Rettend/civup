import type { Database } from '@civup/db'
import { seasonMatchReports, seasons } from '@civup/db'
import { eq } from 'drizzle-orm'

export const SEASON_REPORTING_WINDOW_MS = 48 * 60 * 60 * 1000

export interface SeasonMutationState {
  id: string
  name: string
  startsAt: number
  endsAt: number | null
  active: boolean
  reportingDeadline: number | null
  finalizedAt: number | null
}

export interface SeasonMatchIdentity {
  id?: string
  seasonId: string | null
  createdAt: number
  status: string
}

export function seasonMutationError(
  season: SeasonMutationState,
  match: SeasonMatchIdentity,
  action: 'first-report' | 'correction',
  now: number,
  acceptedAt?: number | null,
): string | null {
  if (!Number.isSafeInteger(now) || now < 0) return 'Invalid season operation time.'
  if (season.id !== match.seasonId || match.createdAt < season.startsAt || (season.endsAt != null && match.createdAt >= season.endsAt)) {
    return 'The match does not belong to the selected season. Its historical assignment needs owner review.'
  }
  if (season.active && season.endsAt == null && season.finalizedAt == null) return null
  if (season.finalizedAt == null && action === 'first-report' && match.status === 'active' && season.reportingDeadline != null) {
    const claimTime = acceptedAt ?? now
    if (Number.isSafeInteger(claimTime) && claimTime >= match.createdAt && claimTime <= now && claimTime < season.reportingDeadline) return null
  }
  return `**${season.name}** is closed to result changes. Historical repairs require the owner's local maintenance tools.`
}

export async function getSeasonMutationError(
  db: Database,
  match: SeasonMatchIdentity,
  action: 'first-report' | 'correction',
  now = Date.now(),
  acceptedAt?: number | null,
  seededCorrection = false,
): Promise<string | null> {
  if (!match.seasonId) {
    const [publicSeason] = await db.select({ id: seasons.id }).from(seasons).where(eq(seasons.ratingSystem, 'rp')).limit(1)
    return publicSeason ? 'This match needs a validated season assignment before its result can change.' : null
  }
  const [season] = await db.select().from(seasons).where(eq(seasons.id, match.seasonId)).limit(1)
  if (!season) return 'The match references a missing season. Its historical assignment needs owner review.'
  if (season.isolatedRatingsEnabled && action === 'first-report') {
    const [report] = await db.select().from(seasonMatchReports).where(eq(seasonMatchReports.matchId, match.id ?? '')).limit(1)
    if (report?.seasonId === season.id) return null
  }
  const error = seasonMutationError(season, match, action, now, acceptedAt)
  if (error) return error
  if ((season.ratingSystem === 'rp' || !season.active) && !(season.isolatedRatingsEnabled && (action === 'first-report' || seededCorrection))) return 'Season-isolated reporting and corrections are not enabled yet. No ratings were changed.'
  return null
}
