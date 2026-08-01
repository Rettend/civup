import type { RatingUpdate } from '@civup/rating'
import { calculateRatings, hiddenRatingScore } from '@civup/rating'

export interface PermanentAllyParticipantRow {
  playerId: string
  team: number | null
  placement: number | null
}

type EffectivePermanentAllyRow<T extends PermanentAllyParticipantRow> = T & { team: number, placement: number }

export function buildPermanentAllyFfaEffectiveRows<T extends PermanentAllyParticipantRow>(
  participantRows: readonly T[],
): EffectivePermanentAllyRow<T>[] | { error: string } {
  if (participantRows.length === 0) return []
  if (participantRows.length % 2 !== 0) return { error: 'Permanent Ally FFA requires an even number of players.' }

  const pairedRows = buildPlacementPairs(participantRows)
  if ('error' in pairedRows) return pairedRows

  return pairedRows.flatMap((teamRows, teamIndex) => teamRows.map(row => ({
    ...row,
    team: teamIndex,
    placement: row.placement!,
  })))
}

export function buildPermanentAllyFfaPlacementByPlayerId(
  participantRows: readonly PermanentAllyParticipantRow[],
): Map<string, number> | { error: string } {
  const effectiveRows = buildPermanentAllyFfaEffectiveRows(participantRows)
  if ('error' in effectiveRows) return effectiveRows
  return new Map(effectiveRows.map(participant => [participant.playerId, participant.placement]))
}

export function calculatePermanentAllyFfaRatingUpdates(
  participantRows: readonly PermanentAllyParticipantRow[],
  resolveRating: (playerId: string) => { mu: number, sigma: number },
): RatingUpdate[] | { error: string } {
  const effectiveRows = buildPermanentAllyFfaEffectiveRows(participantRows)
  if ('error' in effectiveRows) return effectiveRows

  const teams = groupEffectiveRowsByTeam(effectiveRows)
  const syntheticUpdates = calculateRatings({
    type: 'team',
    teams: teams.map((teamRows, teamIndex) => {
      const ratings = teamRows.map(row => resolveRating(row.playerId))
      return {
        players: [{
          playerId: `permanent-ally-pair:${teamIndex}`,
          mu: average(ratings.map(rating => rating.mu)),
          sigma: average(ratings.map(rating => rating.sigma)),
        }],
      }
    }),
  })

  const updates: RatingUpdate[] = []
  for (let teamIndex = 0; teamIndex < teams.length; teamIndex++) {
    const teamRows = teams[teamIndex] ?? []
    const synthetic = syntheticUpdates[teamIndex]
    if (!synthetic) return { error: 'Failed to calculate Permanent Ally FFA pair ratings.' }

    const muDelta = synthetic.after.mu - synthetic.before.mu
    const sigmaDelta = synthetic.after.sigma - synthetic.before.sigma
    for (const participant of teamRows) {
      const before = resolveRating(participant.playerId)
      const after = {
        mu: before.mu + muDelta,
        sigma: Math.max(0.0001, before.sigma + sigmaDelta),
      }
      const hiddenScoreBefore = hiddenRatingScore(before.mu, before.sigma)
      const hiddenScoreAfter = hiddenRatingScore(after.mu, after.sigma)
      updates.push({
        playerId: participant.playerId,
        before,
        after,
        hiddenScoreBefore,
        hiddenScoreAfter,
        hiddenScoreDelta: hiddenScoreAfter - hiddenScoreBefore,
        displayBefore: hiddenScoreBefore,
        displayAfter: hiddenScoreAfter,
        displayDelta: hiddenScoreAfter - hiddenScoreBefore,
      })
    }
  }

  return updates
}

function buildPlacementPairs<T extends PermanentAllyParticipantRow>(participantRows: readonly T[]): T[][] | { error: string } {
  const byPlacement = new Map<number, T[]>()
  for (const participant of participantRows) {
    const placement = participant.placement
    if (placement == null) return { error: 'Permanent Ally FFA participant placement data is missing.' }
    const rows = byPlacement.get(placement) ?? []
    rows.push(participant)
    byPlacement.set(placement, rows)
  }

  const pairs = [...byPlacement.entries()].sort((left, right) => left[0] - right[0])

  if (pairs.some(([, rows]) => rows.length !== 2)) return { error: 'Permanent Ally FFA placements must have exactly two players each.' }
  return pairs.map(([, rows]) => [...rows].sort((left, right) => left.playerId.localeCompare(right.playerId)))
}

function groupEffectiveRowsByTeam<T extends PermanentAllyParticipantRow>(rows: EffectivePermanentAllyRow<T>[]): EffectivePermanentAllyRow<T>[][] {
  const byTeam = new Map<number, EffectivePermanentAllyRow<T>[]>()
  for (const row of rows) {
    const teamRows = byTeam.get(row.team) ?? []
    teamRows.push(row)
    byTeam.set(row.team, teamRows)
  }
  return [...byTeam.entries()]
    .sort((left, right) => {
      const leftPlacement = minPlacement(left[1])
      const rightPlacement = minPlacement(right[1])
      if (leftPlacement !== rightPlacement) return leftPlacement - rightPlacement
      return left[0] - right[0]
    })
    .map(([, teamRows]) => teamRows)
}

function minPlacement(rows: readonly PermanentAllyParticipantRow[]): number {
  return Math.min(...rows.map(row => row.placement ?? Number.MAX_SAFE_INTEGER))
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
}
