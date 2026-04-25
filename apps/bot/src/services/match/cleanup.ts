import type { Database } from '@civup/db'
import type { PruneMatchesOptions, PruneMatchesResult } from './types.ts'
import { matchBans, matches, matchParticipants } from '@civup/db'
import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm'
import { runSessionTerminalLifecycleCommand } from '../../session-runtime/session-do-client.ts'
import { clearLobbyById } from '../lobby/index.ts'
import { getLiveSessionLobbyProjections } from '../session/index.ts'
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
    if (!await runCleanupTerminalSessionCommand(db, options.sessionNamespace, match.id, 'cancel-session', now)) continue

    await clearLobbyById(kv, match.id)

    await db.delete(matchBans).where(eq(matchBans.matchId, match.id))
    await db.delete(matchParticipants).where(eq(matchParticipants.matchId, match.id))
    await db.delete(matches).where(eq(matches.id, match.id))

    removedMatchIds.push(match.id)
  }

  const liveMatchLobbies = (await getLiveSessionLobbyProjections(db)).flatMap(lobby => lobby.matchId
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

      const commandType = matchStatus === 'completed' ? 'mark-reported' : 'cancel-session'
      if (!await runCleanupTerminalSessionCommand(db, options.sessionNamespace, matchId, commandType, now)) continue
      await clearLobbyById(kv, lobby.id, lobby, { syncActivityOverview: false })
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

async function runCleanupTerminalSessionCommand(
  db: Database,
  sessionNamespace: DurableObjectNamespace | null | undefined,
  matchId: string,
  type: 'mark-reported' | 'cancel-session',
  at: number,
): Promise<boolean> {
  if (sessionNamespace) {
    try {
      await runSessionTerminalLifecycleCommand(sessionNamespace, matchId, { type, matchId, at })
      return true
    }
    catch (error) {
      console.warn('[cleanup] failed to update terminal session state', { matchId, type, error })
      return false
    }
  }

  await db.update(matches)
    .set({ status: type === 'mark-reported' ? 'completed' : 'cancelled', completedAt: at })
    .where(eq(matches.id, matchId))
  await db.delete(matchBans).where(eq(matchBans.matchId, matchId))
  return true
}
