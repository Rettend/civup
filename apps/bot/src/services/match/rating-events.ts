import type { Database } from '@civup/db'
import { playerRatingEvents } from '@civup/db'
import { LEADERBOARD_MODES } from '@civup/game'
import { and, inArray } from 'drizzle-orm'
import { getStoredGameModeContext } from './draft-data.ts'

const RATING_EVENT_MATCH_ID_BATCH_SIZE = 90

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

export async function hydrateModeRatingSnapshotsFromEvents<T extends ModeRatingSnapshotTarget>(db: Database, rows: readonly T[]): Promise<T[]> {
  if (rows.length === 0) return [...rows]

  const matchIds = [...new Set(rows.map(row => row.matchId))]
  const playerIds = [...new Set(rows.map(row => row.playerId))]
  const events = new Map<string, Pick<ModeRatingSnapshotTarget, 'ratingBeforeMu' | 'ratingBeforeSigma' | 'ratingAfterMu' | 'ratingAfterSigma'>>()

  for (const matchIdBatch of chunk(matchIds, RATING_EVENT_MATCH_ID_BATCH_SIZE)) {
    const eventRows = await db
      .select({
        matchId: playerRatingEvents.matchId,
        playerId: playerRatingEvents.playerId,
        mode: playerRatingEvents.mode,
        ratingBeforeMu: playerRatingEvents.ratingBeforeMu,
        ratingBeforeSigma: playerRatingEvents.ratingBeforeSigma,
        ratingAfterMu: playerRatingEvents.ratingAfterMu,
        ratingAfterSigma: playerRatingEvents.ratingAfterSigma,
      })
      .from(playerRatingEvents)
      .where(and(
        inArray(playerRatingEvents.matchId, matchIdBatch),
        inArray(playerRatingEvents.playerId, playerIds),
        inArray(playerRatingEvents.mode, [...LEADERBOARD_MODES]),
      ))

    for (const event of eventRows) {
      events.set(eventKey(event.matchId, event.playerId, event.mode), {
        ratingBeforeMu: event.ratingBeforeMu,
        ratingBeforeSigma: event.ratingBeforeSigma,
        ratingAfterMu: event.ratingAfterMu,
        ratingAfterSigma: event.ratingAfterSigma,
      })
    }
  }

  return rows.map((row) => {
    const leaderboardMode = getStoredGameModeContext(row.gameMode, row.draftData)?.leaderboardMode ?? null
    const event = leaderboardMode ? events.get(eventKey(row.matchId, row.playerId, leaderboardMode)) : null
    return event ? { ...row, ...event } : row
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
