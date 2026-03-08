import type { GameMode } from '@civup/game'
import type { ParticipantRow } from './types.ts'
import { isTeamMode } from '@civup/game'

export function resolveWinningTeamIndex(
  placements: string,
  participants: ParticipantRow[],
): { winningTeamIndex: 0 | 1 } | { error: string } {
  const token = placements.trim()
  if (!token) {
    return { error: 'For team and 1v1 games, provide a winner (`A`, `B`, or a winning player mention).' }
  }

  const upper = token.toUpperCase()
  if (upper === 'A') return { winningTeamIndex: 0 }
  if (upper === 'B') return { winningTeamIndex: 1 }

  const playerId = token.replace(/[<@!>]/g, '')
  if (!playerId) {
    return { error: 'For team and 1v1 games, provide a winner (`A`, `B`, or a winning player mention).' }
  }

  const winner = participants.find(participant => participant.playerId === playerId)
  if (!winner) {
    return { error: `<@${playerId}> is not part of match **${participants[0]?.matchId ?? 'unknown'}**.` }
  }

  if (winner.team === null || (winner.team !== 0 && winner.team !== 1)) {
    return { error: 'Could not map winner to Team A or Team B for this match.' }
  }

  return { winningTeamIndex: winner.team }
}

export function parseOrderedParticipantIds(
  placements: string,
  participants: ParticipantRow[],
): { orderedIds: string[] } | { error: string } {
  const tokens = placements
    .split(/\r?\n|,/)
    .map(token => token.trim())
    .filter(token => token.length > 0)

  if (tokens.length === 0) {
    return { error: 'For FFA results, provide at least one player in placement order.' }
  }

  const participantIds = new Set(participants.map(participant => participant.playerId))
  const orderedIds: string[] = []

  for (const token of tokens) {
    const playerId = token.replace(/[<@!>]/g, '')
    if (!participantIds.has(playerId)) {
      return { error: `<@${playerId}> is not part of match **${participants[0]?.matchId ?? 'unknown'}**.` }
    }
    if (orderedIds.includes(playerId)) {
      return { error: `<@${playerId}> appears multiple times in the result input.` }
    }
    orderedIds.push(playerId)
  }

  return { orderedIds }
}

export function parseModerationPlacements(
  gameMode: GameMode,
  placements: string,
  participants: ParticipantRow[],
):
  | { placementsByPlayer: Map<string, number> }
  | { error: string } {
  if (isTeamMode(gameMode) || gameMode === '1v1') {
    const resolvedTeam = resolveWinningTeamIndex(placements, participants)
    if ('error' in resolvedTeam) return resolvedTeam

    const winningTeamIndex = resolvedTeam.winningTeamIndex
    const placementsByPlayer = new Map<string, number>()

    for (const participant of participants) {
      const placement = participant.team === winningTeamIndex ? 1 : 2
      placementsByPlayer.set(participant.playerId, placement)
    }

    const hasWinner = [...placementsByPlayer.values()].includes(1)
    if (!hasWinner) return { error: 'Could not map Team A/Team B for this match. Participant team data is missing.' }

    return { placementsByPlayer }
  }

  const parsedOrder = parseOrderedParticipantIds(placements, participants)
  if ('error' in parsedOrder) return parsedOrder
  const orderedIds = parsedOrder.orderedIds

  const placementsByPlayer = new Map<string, number>()
  orderedIds.forEach((playerId, index) => {
    placementsByPlayer.set(playerId, index + 1)
  })

  const lastPlace = orderedIds.length + 1
  for (const participant of participants) {
    if (placementsByPlayer.has(participant.playerId)) continue
    placementsByPlayer.set(participant.playerId, lastPlace)
  }

  return { placementsByPlayer }
}
