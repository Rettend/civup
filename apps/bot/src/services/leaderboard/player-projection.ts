import type { Database } from '@civup/db'
import type { LeaderboardMode } from '@civup/game'
import type { LeaderboardSnapshotRow } from './snapshot.ts'
import { buildActivityAdjustedLeaderboard, getLeaderboardMinGames } from '@civup/rating'
import { getStoredPlayerProfiles } from '../player/profile.ts'

export interface PlayerLeaderboardProjectionOptions {
  rowLimit: number
  now?: number
}

export interface PlayerLeaderboardProjectionInput {
  mode: LeaderboardMode
  rows: readonly LeaderboardSnapshotRow[]
  options: PlayerLeaderboardProjectionOptions
}

export interface PlayerLeaderboardProjectionRow {
  playerId: string
  displayName: string | null
  avatarUrl: string | null
  rank: number
  rawRank: number
  inactivityOffset: number
  publicRating: number
  gamesPlayed: number
  wins: number
  winRate: number
}

export interface PlayerLeaderboardProjection {
  mode: LeaderboardMode
  rows: PlayerLeaderboardProjectionRow[]
}

/** Canonical ranking and profile projection used by image and public transports. */
export async function buildPlayerLeaderboardProjections(
  db: Database,
  inputs: readonly PlayerLeaderboardProjectionInput[],
): Promise<PlayerLeaderboardProjection[]> {
  const now = Date.now()
  const prepared = inputs.map(input => ({
    input,
    entries: buildActivityAdjustedLeaderboard(
      input.rows,
      getLeaderboardMinGames(input.mode),
      input.options.now ?? now,
    ).slice(0, normalizeLimit(input.options.rowLimit)),
  }))
  const profiles = await getStoredPlayerProfiles(db, prepared.flatMap(item => item.entries.map(entry => entry.playerId)))

  return prepared.map(({ input, entries }) => ({
    mode: input.mode,
    rows: entries.map((entry) => {
      const profile = profiles.get(entry.playerId)
      const displayName = profile?.displayName.trim() || null
      return {
        playerId: entry.playerId,
        displayName,
        avatarUrl: profile?.avatarUrl ?? null,
        rank: entry.rank,
        rawRank: entry.rawRank,
        inactivityOffset: entry.inactivityOffset,
        publicRating: entry.publicRating,
        gamesPlayed: entry.gamesPlayed,
        wins: entry.wins,
        winRate: entry.winRate,
      }
    }),
  }))
}

function normalizeLimit(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.round(value))
}
