import type { SubstituteMatchPlayerInput, SubstituteMatchPlayerResult } from '../services/match/types.ts'
import type { RoomRecord } from './draft-room-domain.ts'
import type { ActiveSessionRecord } from './session-record.ts'
import type { Database } from '@civup/db'
import { eq, sql } from 'drizzle-orm'
import { matchBans, matches, matchParticipants, playerRatingEvents, players } from '@civup/db'
import {
  buildDraftPlayerSubstitution,
  buildMatchBanRowsFromDraftState,
  buildPlayerSubstitutionSummaries,
  buildSubstitutedParticipantRows,
} from '../services/match/moderation.ts'
import { getSeasonMutationError } from '../services/season/policy.ts'
import { runAtomicSeasonBatch, seasonSourceGuard } from '../services/season/report.ts'

export const ACTIVE_SUBSTITUTION_KEY = 'active-substitution'

export interface ActiveSubstitution {
  input: SubstituteMatchPlayerInput
  record: ActiveSessionRecord
  room: RoomRecord
  previousDraftData: string
  result: Exclude<SubstituteMatchPlayerResult, { error: string }>
  completed: boolean
}

export async function prepareActiveSubstitution(
  db: Database,
  record: ActiveSessionRecord,
  room: RoomRecord,
  input: SubstituteMatchPlayerInput,
): Promise<ActiveSubstitution | { error: string }> {
  const [match] = await db.select().from(matches).where(eq(matches.id, input.matchId))
  if (!match || match.status !== 'active')
    return { error: 'Only unreported, draft-complete matches can use an active substitution.' }
  const locked = await getSeasonMutationError(db, match, 'correction', Date.now(), null, true)
  if (locked) return { error: locked }
  const rows = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, match.id))
  if (rows.some(row => row.placement != null || row.ratingAfterMu != null))
    return { error: 'A result is already being saved. Finish reporting before substituting players.' }
  const update = buildDraftPlayerSubstitution(match.draftData, input)
  if ('error' in update) return update
  if (
    JSON.stringify(room.state.seats) !== JSON.stringify(update.previousState.seats) ||
    record.roster.participants.some(member => !room.state.seats.some(seat => seat.playerId === member.playerId))
  )
    return { error: 'The session roster and stored draft disagree. Owner review is required.' }
  const participants = buildSubstitutedParticipantRows(match.id, rows, update)
  if ('error' in participants) return participants
  const replacements = new Map(
    update.previousState.seats.map((seat, index) => [seat.playerId, update.nextState.seats[index]!]),
  )
  const hostId = update.removedPlayerIds.includes(record.hostId) ? input.subPlayer.playerId : record.hostId
  const nextRecord: ActiveSessionRecord = {
    ...record,
    hostId,
    version: record.version + 1,
    updatedAt: input.correctedAt,
    roster: {
      slots: record.roster.slots.map(id => (id == null ? null : (replacements.get(id)?.playerId ?? id))),
      participants: record.roster.participants.map(member => {
        const seat = replacements.get(member.playerId)!
        return {
          ...member,
          playerId: seat.playerId,
          displayName: seat.displayName,
          avatarUrl: seat.avatarUrl ?? null,
          partyIds: [],
        }
      }),
    },
  }
  return {
    input,
    record: nextRecord,
    room: { ...room, state: update.nextState, config: { ...room.config, hostId } },
    previousDraftData: match.draftData!,
    completed: false,
    result: {
      match: { ...match, draftData: update.nextDraftData },
      participants: participants.rows,
      previousStatus: 'active',
      recalculatedMatchIds: [],
      substitutions: buildPlayerSubstitutionSummaries(update, participants.rows),
    },
  }
}

export async function projectActiveSubstitution(db: Database, pending: ActiveSubstitution): Promise<void> {
  const { match, participants } = pending.result
  const [current] = await db.select().from(matches).where(eq(matches.id, match.id))
  if (!current || current.status !== 'active')
    throw new Error('The active substitution cannot overwrite a reported or cancelled match.')
  if (current.draftData === match.draftData) return
  const locked = await getSeasonMutationError(db, current, 'correction', Date.now(), null, true)
  if (locked) throw new Error(locked)
  await runAtomicSeasonBatch(db, [
    seasonSourceGuard(
      db,
      sql`EXISTS(SELECT 1 FROM ${matches} WHERE id = ${match.id} AND status = 'active' AND draft_data = ${pending.previousDraftData})
      AND NOT EXISTS(SELECT 1 FROM ${playerRatingEvents} WHERE match_id = ${match.id})
      AND NOT EXISTS(SELECT 1 FROM ${matchParticipants} WHERE match_id = ${match.id} AND (placement IS NOT NULL OR rating_after_mu IS NOT NULL))`,
    ),
    db
      .insert(players)
      .values({
        id: pending.input.subPlayer.playerId,
        displayName: pending.input.subPlayer.displayName,
        avatarUrl: pending.input.subPlayer.avatarUrl ?? null,
        createdAt: pending.input.correctedAt,
      })
      .onConflictDoNothing(),
    db.delete(matchParticipants).where(eq(matchParticipants.matchId, match.id)),
    ...participants.map(row => db.insert(matchParticipants).values(row)),
    db.delete(matchBans).where(eq(matchBans.matchId, match.id)),
    ...buildMatchBanRowsFromDraftState(pending.room.state).map(row => db.insert(matchBans).values(row)),
    db.update(matches).set({ draftData: match.draftData }).where(eq(matches.id, match.id)),
  ])
}
