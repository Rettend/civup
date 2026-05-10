import type { RatingUpdate } from '@civup/rating'
import { calculateRatings, displayRating } from '@civup/rating'

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

  const hasStoredTeams = participantRows.every(participant => participant.team != null)
  const pairedRows = hasStoredTeams
    ? buildStoredTeamPairs(participantRows)
    : buildAdjacentPlacementPairs(participantRows)
  if ('error' in pairedRows) return pairedRows

  return pairedRows.flatMap((teamRows, teamPlacement) => teamRows.map(row => ({
    ...row,
    team: teamPlacement,
    placement: teamPlacement + 1,
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
          playerId: `permanent-ally-team:${teamIndex}`,
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
    if (!synthetic) return { error: 'Failed to calculate Permanent Ally FFA team ratings.' }

    const muDelta = synthetic.after.mu - synthetic.before.mu
    const sigmaDelta = synthetic.after.sigma - synthetic.before.sigma
    for (const participant of teamRows) {
      const before = resolveRating(participant.playerId)
      const after = {
        mu: before.mu + muDelta,
        sigma: Math.max(0.0001, before.sigma + sigmaDelta),
      }
      const displayBefore = displayRating(before.mu, before.sigma)
      const displayAfter = displayRating(after.mu, after.sigma)
      updates.push({
        playerId: participant.playerId,
        before,
        after,
        displayBefore,
        displayAfter,
        displayDelta: displayAfter - displayBefore,
      })
    }
  }

  return updates
}

function buildStoredTeamPairs<T extends PermanentAllyParticipantRow>(participantRows: readonly T[]): T[][] | { error: string } {
  const byTeam = new Map<number, T[]>()
  for (const participant of participantRows) {
    const team = participant.team
    if (team == null) return { error: 'Permanent Ally FFA participant team data is missing.' }
    const rows = byTeam.get(team) ?? []
    rows.push(participant)
    byTeam.set(team, rows)
  }

  const pairs = [...byTeam.entries()].sort((left, right) => {
    const leftPlacement = minPlacement(left[1])
    const rightPlacement = minPlacement(right[1])
    if (leftPlacement !== rightPlacement) return leftPlacement - rightPlacement
    return left[0] - right[0]
  })

  if (pairs.some(([, rows]) => rows.length !== 2)) return { error: 'Permanent Ally FFA teams must have exactly two players.' }
  return pairs.map(([, rows]) => [...rows].sort((left, right) => left.playerId.localeCompare(right.playerId)))
}

function buildAdjacentPlacementPairs<T extends PermanentAllyParticipantRow>(participantRows: readonly T[]): T[][] | { error: string } {
  const ordered = [...participantRows].sort((left, right) => {
    const leftPlacement = left.placement ?? Number.MAX_SAFE_INTEGER
    const rightPlacement = right.placement ?? Number.MAX_SAFE_INTEGER
    if (leftPlacement !== rightPlacement) return leftPlacement - rightPlacement
    return left.playerId.localeCompare(right.playerId)
  })

  const pairs: T[][] = []
  for (let index = 0; index < ordered.length; index += 2) {
    const left = ordered[index]
    const right = ordered[index + 1]
    if (!left || !right) return { error: 'Permanent Ally FFA requires complete teammate pairs.' }
    pairs.push([left, right])
  }
  return pairs
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
