import type { Database } from '@civup/db'
import type { PruneMatchesOptions, PruneMatchesResult } from './types.ts'
import { matchBans, matches, matchParticipants } from '@civup/db'
import { and, eq, isNull, lt, or } from 'drizzle-orm'
import { clearActivityMappings, getChannelForMatch } from '../activity/index.ts'
import { clearLobbyByMatch } from '../lobby/index.ts'

export async function pruneAbandonedMatches(
  db: Database,
  kv: KVNamespace,
  options: PruneMatchesOptions = {},
): Promise<PruneMatchesResult> {
  const now = Date.now()
  const staleDraftingMs = options.staleDraftingMs ?? 12 * 60 * 60 * 1000
  const staleActiveMs = options.staleActiveMs ?? 36 * 60 * 60 * 1000
  const staleCancelledMs = options.staleCancelledMs ?? 6 * 60 * 60 * 1000

  const staleMatches = await db
    .select({ id: matches.id })
    .from(matches)
    .where(or(
      and(eq(matches.status, 'drafting'), lt(matches.createdAt, now - staleDraftingMs)),
      and(eq(matches.status, 'active'), lt(matches.createdAt, now - staleActiveMs)),
      and(eq(matches.status, 'cancelled'), lt(matches.createdAt, now - staleCancelledMs)),
    ))

  const removedMatchIds: string[] = []

  for (const match of staleMatches) {
    const participants = await db
      .select({ playerId: matchParticipants.playerId })
      .from(matchParticipants)
      .where(eq(matchParticipants.matchId, match.id))

    const channelId = await getChannelForMatch(kv, match.id)
    await clearActivityMappings(
      kv,
      match.id,
      participants.map(participant => participant.playerId),
      channelId ?? undefined,
    )

    await clearLobbyByMatch(kv, match.id)
    await db.delete(matchBans).where(eq(matchBans.matchId, match.id))
    await db.delete(matchParticipants).where(eq(matchParticipants.matchId, match.id))
    await db.delete(matches).where(eq(matches.id, match.id))

    removedMatchIds.push(match.id)
  }

  const completedBanRows = await db
    .select({ matchId: matchBans.matchId })
    .from(matchBans)
    .innerJoin(matches, eq(matchBans.matchId, matches.id))
    .where(eq(matches.status, 'completed'))

  const completedBanMatchIds = [...new Set(completedBanRows.map(row => row.matchId))]
  for (const matchId of completedBanMatchIds) {
    await db.delete(matchBans).where(eq(matchBans.matchId, matchId))
  }

  const orphanParticipantRows = await db
    .select({ matchId: matchParticipants.matchId })
    .from(matchParticipants)
    .leftJoin(matches, eq(matchParticipants.matchId, matches.id))
    .where(isNull(matches.id))

  const orphanParticipantMatchIds = [...new Set(orphanParticipantRows.map(row => row.matchId))]
  for (const matchId of orphanParticipantMatchIds) {
    await db.delete(matchParticipants).where(eq(matchParticipants.matchId, matchId))
  }

  const orphanBanRows = await db
    .select({ matchId: matchBans.matchId })
    .from(matchBans)
    .leftJoin(matches, eq(matchBans.matchId, matches.id))
    .where(isNull(matches.id))

  const orphanBanMatchIds = [...new Set(orphanBanRows.map(row => row.matchId))]
  for (const matchId of orphanBanMatchIds) {
    await db.delete(matchBans).where(eq(matchBans.matchId, matchId))
  }

  return { removedMatchIds }
}
