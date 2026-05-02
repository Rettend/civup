import type { Database } from '@civup/db'
import type { PruneMatchesOptions, PruneMatchesResult } from './types.ts'
import { matchBans, matches, matchParticipants } from '@civup/db'
import { and, eq, inArray, lt, or } from 'drizzle-orm'
import { runSessionTerminalLifecycleCommand } from '../../session-runtime/session-do-client.ts'
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
    if (!await runCleanupTerminalSessionCommand(db, options, match.id, 'cancel-session', now)) continue

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
      if (!await runCleanupTerminalSessionCommand(db, options, matchId, commandType, now)) continue
      clearedLiveLobbyMatchIds.push(matchId)
    }
  }

  return { removedMatchIds, clearedLiveLobbyMatchIds }
}

async function runCleanupTerminalSessionCommand(
  db: Database,
  options: PruneMatchesOptions,
  matchId: string,
  type: 'mark-reported' | 'cancel-session',
  at: number,
): Promise<boolean> {
  const { sessionNamespace } = options
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

  if (!options.allowDirectTerminalWriteForTests) {
    console.warn('[cleanup] skipping terminal cleanup without SessionDO binding', { matchId, type })
    return false
  }

  await db.update(matches)
    .set({ status: type === 'mark-reported' ? 'completed' : 'cancelled', completedAt: at })
    .where(eq(matches.id, matchId))
  await db.delete(matchBans).where(eq(matchBans.matchId, matchId))
  return true
}
