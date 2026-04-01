import type { Database } from '@civup/db'
import type { PruneMatchesOptions, PruneMatchesResult } from './types.ts'
import { matchBans, matches, matchParticipants } from '@civup/db'
import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm'
import { clearActivityMappings, getChannelForMatch } from '../activity/index.ts'
import { clearLobbyById, clearLobbyByMatch, getCurrentLobbies } from '../lobby/index.ts'
import { STALE_ACTIVE_MATCH_TIMEOUT_MS, STALE_CANCELLED_MATCH_TIMEOUT_MS, STALE_DRAFTING_MATCH_TIMEOUT_MS } from './retention.ts'

export async function pruneAbandonedMatches(
  db: Database,
  kv: KVNamespace,
  options: PruneMatchesOptions = {},
): Promise<PruneMatchesResult> {
  const now = Date.now()
  const staleDraftingMs = options.staleDraftingMs ?? STALE_DRAFTING_MATCH_TIMEOUT_MS
  const staleActiveMs = options.staleActiveMs ?? STALE_ACTIVE_MATCH_TIMEOUT_MS
  const staleCancelledMs = options.staleCancelledMs ?? STALE_CANCELLED_MATCH_TIMEOUT_MS

  const staleMatches = await db
    .select({ id: matches.id })
    .from(matches)
    .where(or(
      and(eq(matches.status, 'drafting'), lt(matches.createdAt, now - staleDraftingMs)),
      and(eq(matches.status, 'active'), lt(matches.createdAt, now - staleActiveMs)),
      and(eq(matches.status, 'cancelled'), lt(matches.createdAt, now - staleCancelledMs)),
    ))

  const removedMatchIds: string[] = []
  const clearedLiveLobbyMatchIds: string[] = []

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

  const liveMatchLobbies = (await getCurrentLobbies(kv)).flatMap(lobby => lobby.matchId
    ? [{ lobby, matchId: lobby.matchId }]
    : [])
  const liveMatchIds = [...new Set(liveMatchLobbies.map(entry => entry.matchId))]

  if (liveMatchIds.length > 0) {
    const liveMatchRows = await db
      .select({ id: matches.id, status: matches.status })
      .from(matches)
      .where(inArray(matches.id, liveMatchIds))
    const liveStatusByMatchId = new Map(liveMatchRows.map(row => [row.id, row.status]))

    for (const { lobby, matchId } of liveMatchLobbies) {
      const matchStatus = liveStatusByMatchId.get(matchId)
      if (matchStatus === 'drafting' || matchStatus === 'active') continue

      await clearActivityMappings(kv, matchId, lobby.memberPlayerIds, lobby.channelId)
      await clearLobbyById(kv, lobby.id, lobby)
      clearedLiveLobbyMatchIds.push(matchId)
    }
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

  return { removedMatchIds, clearedLiveLobbyMatchIds }
}
