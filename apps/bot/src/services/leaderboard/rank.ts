import type { LeaderboardModeSnapshot } from './snapshot.ts'
import { displayRating, getLeaderboardMinGames } from '@civup/rating'

export function buildLeaderboardRankByPlayer(snapshot: LeaderboardModeSnapshot): Map<string, number> {
  const publicEra = snapshot.ratingSystem === 'rp'
  if (publicEra && (!snapshot.publicReadsEnabled || snapshot.rows.some(row => row.publicRating == null)))
    return new Map()
  const ranked = snapshot.rows
    .filter(row => row.gamesPlayed >= getLeaderboardMinGames(snapshot.mode))
    .map(row => ({ playerId: row.playerId, rating: publicEra ? row.publicRating! : displayRating(row.mu, row.sigma) }))
    .sort((left, right) => right.rating - left.rating || (publicEra ? left.playerId.localeCompare(right.playerId) : 0))
  return new Map(ranked.map((row, index) => [row.playerId, index + 1]))
}
