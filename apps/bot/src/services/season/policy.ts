import type { Database } from '@civup/db'
import { eq } from 'drizzle-orm'
import { seasonMatchReports, seasons } from '@civup/db'

export const SEASON_REPORTING_WINDOW_MS = 48 * 60 * 60 * 1000
export const MATCH_CORRECTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

export function matchCorrectionAgeError(match: SeasonMatchIdentity, now: number): string | null {
  return now - match.createdAt > MATCH_CORRECTION_WINDOW_MS
    ? 'This match is older than 30 days and cannot be changed with mod commands anymore.'
    : null
}

type SeasonMutationAction = 'first-report' | 'unreported-cancellation' | 'correction'

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
  action: SeasonMutationAction,
  now: number,
  acceptedAt?: number | null,
): string | null {
  if (!Number.isSafeInteger(now) || now < 0) return 'Could not check when this match was played.'
  if (
    season.id !== match.seasonId ||
    match.createdAt < season.startsAt ||
    (season.endsAt != null && match.createdAt >= season.endsAt)
  ) {
    return 'This match is linked to the wrong season. Ask a server admin to check it.'
  }
  if (season.active && season.endsAt == null && season.finalizedAt == null)
    return action === 'correction' ? matchCorrectionAgeError(match, now) : null
  if (
    season.finalizedAt == null &&
    action !== 'correction' &&
    match.status === 'active' &&
    season.reportingDeadline != null
  ) {
    const claimTime = action === 'first-report' ? (acceptedAt ?? now) : now
    if (
      Number.isSafeInteger(claimTime) &&
      claimTime >= match.createdAt &&
      claimTime <= now &&
      claimTime < season.reportingDeadline
    )
      return null
  }
  return 'This match belongs to an older season and cannot be changed with mod commands anymore.'
}

export async function getSeasonMutationError(
  db: Database,
  match: SeasonMatchIdentity,
  action: SeasonMutationAction,
  now = Date.now(),
  acceptedAt?: number | null,
  seededCorrection = false,
): Promise<string | null> {
  if (!match.seasonId) {
    const ageError = action === 'correction' || seededCorrection ? matchCorrectionAgeError(match, now) : null
    if (ageError) return ageError
    const [publicSeason] = await db
      .select({ id: seasons.id })
      .from(seasons)
      .where(eq(seasons.ratingSystem, 'rp'))
      .limit(1)
    return publicSeason ? 'This match has no season. Ask a server admin to check it.' : null
  }
  const [season] = await db.select().from(seasons).where(eq(seasons.id, match.seasonId)).limit(1)
  if (!season) return 'The season for this match could not be found. Ask a server admin to check it.'
  if (seededCorrection) {
    if (!season.active || season.endsAt != null || season.finalizedAt != null)
      return 'This match belongs to an older season and cannot be changed with mod commands anymore.'
    const ageError = matchCorrectionAgeError(match, now)
    if (ageError) return ageError
  }
  if (season.isolatedRatingsEnabled && action === 'first-report') {
    const [report] = await db
      .select()
      .from(seasonMatchReports)
      .where(eq(seasonMatchReports.matchId, match.id ?? ''))
      .limit(1)
    if (report?.seasonId === season.id) return null
  }
  const error = seasonMutationError(season, match, action, now, acceptedAt)
  if (error) return error
  if (
    (season.ratingSystem === 'rp' || !season.active) &&
    !(season.isolatedRatingsEnabled && (action !== 'correction' || seededCorrection))
  ) {
    console.error('[season-policy] unsupported rating operation', {
      matchId: match.id,
      matchStatus: match.status,
      seasonId: season.id,
      action,
      ratingSystem: season.ratingSystem,
      isolatedRatingsEnabled: season.isolatedRatingsEnabled,
      seededCorrection,
    })
    if (season.isolatedRatingsEnabled && action === 'correction') return 'A moderator must change this result.'
    return 'The bot cannot update this match because its season settings are incomplete. Ask a server admin to check them.'
  }
  return null
}
