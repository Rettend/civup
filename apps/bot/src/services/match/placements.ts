import type { GameMode } from '@civup/game'
import type { ParticipantRow } from './types.ts'
import { isTeamMode } from '@civup/game'

function teamToken(teamIndex: number): string {
  return String.fromCharCode(65 + teamIndex)
}

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

export function parseOrderedTeamIndexes(
  placements: string,
  participants: ParticipantRow[],
): { orderedTeams: number[] } | { error: string } {
  const tokens = placements
    .split(/\r?\n|,/)
    .map(token => token.trim())
    .filter(token => token.length > 0)

  if (tokens.length === 0) {
    return { error: 'For multi-team results, provide the teams in placement order.' }
  }

  const teamIndexes = new Set(participants.flatMap(participant => participant.team == null ? [] : [participant.team]))
  const orderedTeams: number[] = []

  for (const token of tokens) {
    const upper = token.toUpperCase()
    const tokenMatch = upper.match(/^[A-Z]$/)
    if (tokenMatch) {
      const teamIndex = tokenMatch[0]!.charCodeAt(0) - 65
      if (!teamIndexes.has(teamIndex)) {
        return { error: `Team ${tokenMatch[0]} is not part of match **${participants[0]?.matchId ?? 'unknown'}**.` }
      }
      if (orderedTeams.includes(teamIndex)) {
        return { error: `Team ${tokenMatch[0]} appears multiple times in the result input.` }
      }
      orderedTeams.push(teamIndex)
      continue
    }

    const playerId = token.replace(/[<@!>]/g, '')
    const participant = participants.find(row => row.playerId === playerId)
    if (!participant) {
      return { error: `${token} is not part of match **${participants[0]?.matchId ?? 'unknown'}**.` }
    }
    if (participant.team == null) {
      return { error: `Could not map <@${playerId}> to a team for this match.` }
    }
    if (orderedTeams.includes(participant.team)) {
      return { error: `Team ${teamToken(participant.team)} appears multiple times in the result input.` }
    }
    orderedTeams.push(participant.team)
  }

  return { orderedTeams }
}

export function parseModerationPlacements(
  gameMode: GameMode,
  placements: string,
  participants: ParticipantRow[],
):
  | { placementsByPlayer: Map<string, number> }
  | { error: string } {
  if (isTeamMode(gameMode) || gameMode === '1v1') {
    const uniqueTeams = new Set(participants.flatMap(participant => participant.team == null ? [] : [participant.team]))
    if (uniqueTeams.size > 2) {
      const parsedTeams = parseOrderedTeamIndexes(placements, participants)
      if ('error' in parsedTeams) return parsedTeams

      const placementsByPlayer = new Map<string, number>()
      parsedTeams.orderedTeams.forEach((teamIndex, placementIndex) => {
        for (const participant of participants) {
          if (participant.team !== teamIndex) continue
          placementsByPlayer.set(participant.playerId, placementIndex + 1)
        }
      })

      const remainingTeams = [...uniqueTeams].filter(teamIndex => !parsedTeams.orderedTeams.includes(teamIndex))
      let nextPlacement = parsedTeams.orderedTeams.length + 1
      for (const teamIndex of remainingTeams) {
        for (const participant of participants) {
          if (participant.team !== teamIndex) continue
          placementsByPlayer.set(participant.playerId, nextPlacement)
        }
        nextPlacement += 1
      }

      return { placementsByPlayer }
    }

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
