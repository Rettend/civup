import type { LobbyState } from '../lobby/types.ts'

const BLOCKING_DRAFT_MATCH_SQL = "(matches.status = 'drafting' OR (matches.status = 'active' AND json_extract(matches.draft_data, '$.completedAt') IS NULL))"
const REPORTABLE_MATCH_SQL = "(matches.status = 'active' AND json_extract(matches.draft_data, '$.completedAt') IS NOT NULL)"

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

export async function findPersistedBlockingDraftMatchIdsForPlayers(
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
        AND ${BLOCKING_DRAFT_MATCH_SQL}
      ORDER BY matches.created_at DESC
    `)
      .bind(...uniquePlayerIds)
      .all<{ playerId?: unknown, matchId?: unknown }>()

    const blockingMatchIdByPlayerId = new Map<string, string>()
    for (const row of response.results ?? []) {
      if (typeof row.playerId !== 'string' || typeof row.matchId !== 'string') continue
      if (!blockingMatchIdByPlayerId.has(row.playerId)) {
        blockingMatchIdByPlayerId.set(row.playerId, row.matchId)
      }
    }

    return blockingMatchIdByPlayerId
  }
  catch (error) {
    console.error('Failed to verify blocking draft matches from D1:', error)
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

export async function findPersistedReportableMatchIdsForPlayers(
  db: D1Database | null | undefined,
  playerIds: string[],
): Promise<Map<string, string[]> | null> {
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
        AND ${REPORTABLE_MATCH_SQL}
      ORDER BY matches.created_at DESC
    `)
      .bind(...uniquePlayerIds)
      .all<{ playerId?: unknown, matchId?: unknown }>()

    const reportableMatchIdsByPlayerId = new Map<string, string[]>()
    for (const row of response.results ?? []) {
      if (typeof row.playerId !== 'string' || typeof row.matchId !== 'string') continue
      const existing = reportableMatchIdsByPlayerId.get(row.playerId)
      if (existing) {
        existing.push(row.matchId)
        continue
      }

      reportableMatchIdsByPlayerId.set(row.playerId, [row.matchId])
    }

    return reportableMatchIdsByPlayerId
  }
  catch (error) {
    console.error('Failed to verify reportable matches from D1:', error)
    return null
  }
}

export async function findPersistedTerminalMatchIds(
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
        AND status NOT IN ('drafting', 'active')
    `)
      .bind(...uniqueMatchIds)
      .all<{ id?: unknown }>()

    const terminalMatchIds = new Set<string>()
    for (const row of response.results ?? []) {
      if (typeof row.id !== 'string') continue
      terminalMatchIds.add(row.id)
    }

    return terminalMatchIds
  }
  catch (error) {
    console.error('Failed to verify terminal match ids from D1:', error)
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

  const staleLiveLobbies = lobbies.filter((lobby): lobby is LobbyState & { matchId: string } => (
    filtered.staleLobbyIds.has(lobby.id)
    && typeof lobby.matchId === 'string'
    && lobby.matchId.length > 0
  ))
  if (staleLiveLobbies.length === 0) return new Set()

  const terminalMatchIds = await findPersistedTerminalMatchIds(db, staleLiveLobbies.map(lobby => lobby.matchId))
  if (terminalMatchIds == null) return null

  const clearedLobbyIds = new Set<string>()
  for (const lobby of staleLiveLobbies) {
    if (!terminalMatchIds.has(lobby.matchId)) continue
    clearedLobbyIds.add(lobby.id)
  }

  return clearedLobbyIds
}
