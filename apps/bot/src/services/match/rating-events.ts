import type { Database } from '@civup/db'
import type { PublicRatingSnapshot } from '@civup/rating'
import { and, eq, inArray } from 'drizzle-orm'
import { matches, playerRatingEvents, seasons } from '@civup/db'
import { LEADERBOARD_MODES } from '@civup/game'
import { getStoredGameModeContext } from './draft-data.ts'

const RATING_EVENT_MATCH_ID_BATCH_SIZE = 40

interface ModeRatingSnapshotTarget {
  matchId: string
  playerId: string
  gameMode: string
  draftData: string | null
  ratingBeforeMu: number | null
  ratingBeforeSigma: number | null
  ratingAfterMu: number | null
  ratingAfterSigma: number | null
}

export async function hydrateModeRatingSnapshotsFromEvents<T extends ModeRatingSnapshotTarget>(
  db: Database,
  rows: readonly T[],
): Promise<Array<T & PublicRatingSnapshot>> {
  if (rows.length === 0) return [...rows]

  const matchIds = [...new Set(rows.map(row => row.matchId))]
  const eras = new Map<string, { publicEra: boolean; enabled: boolean }>()
  const events = new Map<
    string,
    Pick<ModeRatingSnapshotTarget, 'ratingBeforeMu' | 'ratingBeforeSigma' | 'ratingAfterMu' | 'ratingAfterSigma'> &
      PublicRatingSnapshot
  >()

  for (const matchIdBatch of chunk(matchIds, RATING_EVENT_MATCH_ID_BATCH_SIZE)) {
    const eventRows = await db
      .select({
        matchId: matches.id,
        playerId: playerRatingEvents.playerId,
        mode: playerRatingEvents.mode,
        ratingBeforeMu: playerRatingEvents.ratingBeforeMu,
        ratingBeforeSigma: playerRatingEvents.ratingBeforeSigma,
        ratingAfterMu: playerRatingEvents.ratingAfterMu,
        ratingAfterSigma: playerRatingEvents.ratingAfterSigma,
        publicRatingBefore: playerRatingEvents.publicRatingBefore,
        publicRatingAfter: playerRatingEvents.publicRatingAfter,
        ratingSystem: seasons.ratingSystem,
        publicReadsEnabled: seasons.publicReadsEnabled,
      })
      .from(matches)
      .leftJoin(seasons, eq(seasons.id, matches.seasonId))
      .leftJoin(
        playerRatingEvents,
        and(eq(playerRatingEvents.matchId, matches.id), inArray(playerRatingEvents.mode, [...LEADERBOARD_MODES])),
      )
      .where(inArray(matches.id, matchIdBatch))

    for (const event of eventRows) {
      eras.set(event.matchId, { publicEra: event.ratingSystem === 'rp', enabled: event.publicReadsEnabled === true })
      if (!event.playerId || !event.mode) continue
      events.set(eventKey(event.matchId, event.playerId, event.mode), {
        ratingBeforeMu: event.ratingBeforeMu,
        ratingBeforeSigma: event.ratingBeforeSigma,
        ratingAfterMu: event.ratingAfterMu,
        ratingAfterSigma: event.ratingAfterSigma,
        ...(event.ratingSystem === 'rp'
          ? ({
              ratingSystem: 'rp',
              publicRatingBefore: event.publicReadsEnabled ? event.publicRatingBefore : null,
              publicRatingAfter: event.publicReadsEnabled ? event.publicRatingAfter : null,
              publicRatingReady:
                event.publicReadsEnabled === true &&
                event.publicRatingBefore != null &&
                event.publicRatingAfter != null,
            } as const)
          : {}),
      })
    }
  }

  return rows.map(row => {
    const leaderboardMode = getStoredGameModeContext(row.gameMode, row.draftData)?.leaderboardMode ?? null
    const event = leaderboardMode ? events.get(eventKey(row.matchId, row.playerId, leaderboardMode)) : null
    if (event) return { ...row, ...event }
    return leaderboardMode && eras.get(row.matchId)?.publicEra
      ? { ...row, ratingSystem: 'rp', publicRatingBefore: null, publicRatingAfter: null, publicRatingReady: false }
      : row
  })
}

function eventKey(matchId: string, playerId: string, mode: string): string {
  return `${matchId}:${playerId}:${mode}`
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size))
  return chunks
}
