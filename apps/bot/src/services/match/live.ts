import type { LobbyState } from '../lobby/types.ts'
import { clearActivityMappings } from '../activity/index.ts'
import { clearLobbyById } from '../lobby/index.ts'

function canQueryLiveMatches(db: D1Database | null | undefined): boolean {
  return db != null && typeof (db as { prepare?: unknown }).prepare === 'function'
}

export async function findPersistedLiveMatchIdsForPlayers(
  db: D1Database | null | undefined,
  playerIds: string[],
): Promise<Map<string, string> | null> {
  const uniquePlayerIds = [...new Set(playerIds.filter(playerId => playerId.length > 0))]
  if (uniquePlayerIds.length === 0) return new Map()
  if (!db || !canQueryLiveMatches(db)) return null

  const placeholders = uniquePlayerIds.map(() => '?').join(', ')

  try {
    const response = await db.prepare(`
      SELECT match_participants.player_id AS playerId, match_participants.match_id AS matchId
      FROM match_participants
      INNER JOIN matches ON match_participants.match_id = matches.id
      WHERE match_participants.player_id IN (${placeholders})
        AND matches.status IN ('drafting', 'active')
      ORDER BY matches.created_at DESC
    `)
      .bind(...uniquePlayerIds)
      .all<{ playerId?: unknown, matchId?: unknown }>()

    const liveMatchIdByPlayerId = new Map<string, string>()
    for (const row of response.results ?? []) {
      if (typeof row.playerId !== 'string' || typeof row.matchId !== 'string') continue
      if (!liveMatchIdByPlayerId.has(row.playerId)) {
        liveMatchIdByPlayerId.set(row.playerId, row.matchId)
      }
    }

    return liveMatchIdByPlayerId
  }
  catch (error) {
    console.error('Failed to verify live matches from D1:', error)
    return null
  }
}

export async function findPersistedLiveMatchIds(
  db: D1Database | null | undefined,
  matchIds: string[],
): Promise<Set<string> | null> {
  const uniqueMatchIds = [...new Set(matchIds.filter(matchId => matchId.length > 0))]
  if (uniqueMatchIds.length === 0) return new Set()
  if (!db || !canQueryLiveMatches(db)) return null

  const placeholders = uniqueMatchIds.map(() => '?').join(', ')

  try {
    const response = await db.prepare(`
      SELECT id
      FROM matches
      WHERE id IN (${placeholders})
        AND status IN ('drafting', 'active')
    `)
      .bind(...uniqueMatchIds)
      .all<{ id?: unknown }>()

    const liveMatchIds = new Set<string>()
    for (const row of response.results ?? []) {
      if (typeof row.id !== 'string') continue
      liveMatchIds.add(row.id)
    }

    return liveMatchIds
  }
  catch (error) {
    console.error('Failed to verify live match ids from D1:', error)
    return null
  }
}

export async function filterPersistedLiveLobbies(
  db: D1Database | null | undefined,
  lobbies: LobbyState[],
): Promise<{ lobbies: LobbyState[], staleLobbyIds: Set<string> } | null> {
  const liveLobbies = lobbies.filter((lobby): lobby is LobbyState & { matchId: string } => (
    (lobby.status === 'drafting' || lobby.status === 'active')
    && typeof lobby.matchId === 'string'
    && lobby.matchId.length > 0
  ))
  if (liveLobbies.length === 0) {
    return {
      lobbies,
      staleLobbyIds: new Set(),
    }
  }

  const persistedLiveMatchIds = await findPersistedLiveMatchIds(db, liveLobbies.map(lobby => lobby.matchId))
  if (persistedLiveMatchIds == null) return null

  const staleLobbyIds = new Set<string>()
  for (const lobby of liveLobbies) {
    if (persistedLiveMatchIds.has(lobby.matchId)) continue
    staleLobbyIds.add(lobby.id)
  }

  return {
    lobbies: staleLobbyIds.size === 0
      ? lobbies
      : lobbies.filter(lobby => !staleLobbyIds.has(lobby.id)),
    staleLobbyIds,
  }
}

export async function clearStalePersistedLiveLobbies(
  db: D1Database | null | undefined,
  kv: KVNamespace,
  lobbies: LobbyState[],
): Promise<Set<string> | null> {
  const filtered = await filterPersistedLiveLobbies(db, lobbies)
  if (filtered == null) return null

  const staleLiveLobbies = lobbies.filter((lobby) => filtered.staleLobbyIds.has(lobby.id))
  const clearedLobbyIds = new Set<string>()
  for (const lobby of staleLiveLobbies) {
    if (!lobby.matchId) continue

    await clearActivityMappings(kv, lobby.matchId, lobby.memberPlayerIds, lobby.channelId)
    await clearLobbyById(kv, lobby.id, lobby)
    clearedLobbyIds.add(lobby.id)
  }

  return clearedLobbyIds
}
