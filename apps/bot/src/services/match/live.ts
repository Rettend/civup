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
      SELECT match_participants.playerId AS playerId, match_participants.matchId AS matchId
      FROM match_participants
      INNER JOIN matches ON match_participants.matchId = matches.id
      WHERE match_participants.playerId IN (${placeholders})
        AND matches.status IN ('drafting', 'active')
      ORDER BY matches.createdAt DESC
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
