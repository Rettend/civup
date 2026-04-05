import type { PlayerRating } from '@civup/rating'
import { DEFAULT_MU, DISPLAY_RATING_BASE, DISPLAY_RATING_SCALE, predictWinProbabilities } from '@civup/rating'

/** Project a lineup to the display rating of an even 50/50 opponent team. */
export function projectLineupDisplayRating(players: PlayerRating[]): number {
  if (players.length === 0) return 1000

  const averageSigma = players.reduce((total, player) => total + player.sigma, 0) / players.length
  let low = 500
  let high = 2000

  for (let iteration = 0; iteration < 32; iteration++) {
    const mid = (low + high) / 2
    const comparisonTeam = players.map((player, index) => createComparisonPlayer(player.playerId || `cmp-${index + 1}`, mid, averageSigma))
    const probability = predictWinProbabilities([players, comparisonTeam])[0] ?? 0.5
    if (probability >= 0.5) low = mid
    else high = mid
  }

  return (low + high) / 2
}

function createComparisonPlayer(playerId: string, display: number, sigma: number): PlayerRating {
  return {
    playerId,
    mu: DEFAULT_MU + ((display - DISPLAY_RATING_BASE) / DISPLAY_RATING_SCALE),
    sigma,
  }
}
