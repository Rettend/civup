import type { Database } from '@civup/db'
import type { MatchRow, ParticipantRow } from './types.ts'
import type { RuntimeInvariantViolation } from '@civup/utils'
import { matches, matchParticipants } from '@civup/db'
import { isTeamMode, parseGameMode } from '@civup/game'
import { enforceRuntimeInvariants } from '@civup/utils'
import { eq } from 'drizzle-orm'
import { getCompletedAtFromDraftData } from './draft-data.ts'

export interface MatchInvariantOptions {
  context?: Record<string, unknown>
  strict?: boolean
}

export function getMatchInvariantViolations(
  match: MatchRow,
  participants: ParticipantRow[],
  options: MatchInvariantOptions = {},
): RuntimeInvariantViolation[] {
  const violations: RuntimeInvariantViolation[] = []
  const push = (message: string, context?: Record<string, unknown>) => {
    violations.push({
      scope: 'match-invariant',
      message,
      context: {
        matchId: match.id,
        status: match.status,
        gameMode: match.gameMode,
        participantCount: participants.length,
        ...options.context,
        ...context,
      },
    })
  }

  const mode = parseGameMode(match.gameMode)
  if (!mode) {
    push('Match gameMode must be a supported normalized value.')
    return violations
  }

  if (participants.length < 2) {
    push('Matches must keep at least two participants.')
  }

  const uniquePlayerIds = new Set(participants.map(participant => participant.playerId))
  if (uniquePlayerIds.size !== participants.length) {
    push('Match participants must be unique by playerId.', {
      participantPlayerIds: participants.map(participant => participant.playerId),
    })
  }

  if (isTeamMode(mode) || mode === '1v1') {
    if (participants.some(participant => participant.team == null)) {
      push('Team-mode matches must keep a team assignment for every participant.')
    }
  }
  else if (participants.some(participant => participant.team != null)) {
    push('FFA matches must not keep team assignments.')
  }

  const draftCompletedAt = getCompletedAtFromDraftData(match.draftData)
  switch (match.status) {
    case 'drafting':
      if (match.completedAt != null) {
        push('Drafting matches must not have a completedAt timestamp.', {
          completedAt: match.completedAt,
        })
      }
      if (participants.some(participant => participant.civId != null || participant.placement != null)) {
        push('Drafting matches must not persist civs or placements yet.')
      }
      break

    case 'active':
      if (match.completedAt != null) {
        push('Active matches must not have a completedAt timestamp.', {
          completedAt: match.completedAt,
        })
      }
      if (draftCompletedAt == null) {
        push('Active matches must retain draft completion metadata in draftData.')
      }
      if (participants.some(participant => participant.civId == null)) {
        push('Active matches must keep a civ assignment for every participant.')
      }
      if (participants.some(participant => participant.placement != null)) {
        push('Active matches must not keep resolved placements yet.')
      }
      break

    case 'completed':
      if (match.completedAt == null) {
        push('Completed matches must keep a completedAt timestamp.')
      }
      if (draftCompletedAt == null) {
        push('Completed matches must retain draft completion metadata in draftData.')
      }
      if (participants.some(participant => participant.civId == null)) {
        push('Completed matches must keep a civ assignment for every participant.')
      }
      if (participants.some(participant => participant.placement == null)) {
        push('Completed matches must keep a placement for every participant.')
      }
      break

    case 'cancelled':
      if (participants.some(participant => participant.placement != null)) {
        push('Cancelled matches must not keep resolved placements.')
      }
      break

    default:
      push('Match status must stay within the supported lifecycle values.')
      break
  }

  return violations
}

export function assertMatchAggregateInvariants(
  match: MatchRow,
  participants: ParticipantRow[],
  options: MatchInvariantOptions = {},
): void {
  enforceRuntimeInvariants(getMatchInvariantViolations(match, participants, options), {
    strict: options.strict,
  })
}

export async function assertPersistedMatchInvariants(
  db: Database,
  matchId: string,
  options: MatchInvariantOptions = {},
): Promise<void> {
  const [match] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, matchId))
    .limit(1)

  if (!match) {
    enforceRuntimeInvariants([{
      scope: 'match-invariant',
      message: 'Persisted match was expected to exist after mutation.',
      context: {
        matchId,
        ...options.context,
      },
    }], {
      strict: options.strict,
    })
    return
  }

  const participants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, matchId))

  assertMatchAggregateInvariants(match, participants, options)
}
