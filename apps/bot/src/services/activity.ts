import type { DraftSeat, GameMode, QueueEntry, RoomConfig } from '@civup/game'
import { allLeaderIds, getDefaultFormat, isTeamMode } from '@civup/game'
import { nanoid } from 'nanoid'

// ── Types ───────────────────────────────────────────────────

export interface MatchCreationResult {
  matchId: string
  formatId: string
  seats: DraftSeat[]
}

// ── Configuration ───────────────────────────────────────────

/** PartyKit server URL (local in dev, deployed in prod) */
const DEFAULT_PARTY_HOST = 'http://localhost:1999'

// ── Create a draft room via PartyKit HTTP API ───────────────

/** Creates a PartyKit draft room and returns the match config */
export async function createDraftRoom(
  mode: GameMode,
  entries: QueueEntry[],
  partyHost?: string,
): Promise<MatchCreationResult> {
  const matchId = nanoid(12)
  const format = getDefaultFormat(mode)

  // Build seats from queue entries
  const seats: DraftSeat[] = buildSeats(mode, entries)

  const config: RoomConfig = {
    matchId,
    formatId: format.id,
    seats,
    civPool: allLeaderIds,
  }

  // POST to PartyKit to create the room
  // Room name = matchId so activity can connect to the same room
  const normalizedHost = normalizePartyHost(partyHost)
  const url = `${normalizedHost}/parties/main/${matchId}`
  console.log(`[activity] creating room match=${matchId} mode=${mode} host=${normalizedHost}`)

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })

  if (!res.ok) {
    const text = await res.text()
    console.error(`[activity] create room failed status=${res.status} body=${text}`)
    throw new Error(`Failed to create draft room: ${res.status} ${text}`)
  }

  console.log(`[activity] room created match=${matchId}`)

  return { matchId, formatId: format.id, seats }
}

function normalizePartyHost(host?: string): string {
  const raw = (host && host.trim()) || DEFAULT_PARTY_HOST
  const withProtocol = raw.startsWith('http://') || raw.startsWith('https://')
    ? raw
    : `https://${raw}`
  return withProtocol.replace(/\/$/, '')
}

// ── Build seats with team assignment ────────────────────────

function buildSeats(mode: GameMode, entries: QueueEntry[]): DraftSeat[] {
  if (isTeamMode(mode)) {
    // Team modes: alternate team assignment
    // Team 0 (A): indices 0, 2, 4, ...
    // Team 1 (B): indices 1, 3, 5, ...
    const teamSize = mode === '2v2' ? 2 : 3
    const seats: DraftSeat[] = []

    for (let i = 0; i < teamSize; i++) {
      // Team A player
      const teamAEntry = entries[i]
      if (teamAEntry) {
        seats.push({
          playerId: teamAEntry.playerId,
          displayName: teamAEntry.displayName,
          team: 0,
        })
      }
    }

    for (let i = 0; i < teamSize; i++) {
      // Team B player
      const teamBEntry = entries[teamSize + i]
      if (teamBEntry) {
        seats.push({
          playerId: teamBEntry.playerId,
          displayName: teamBEntry.displayName,
          team: 1,
        })
      }
    }

    return seats
  }

  // FFA and Duel: no teams
  return entries.map(e => ({
    playerId: e.playerId,
    displayName: e.displayName,
  }))
}

/** Store match mapping for channel → matchId lookup */
export async function storeMatchMapping(
  kv: KVNamespace,
  channelId: string,
  matchId: string,
): Promise<void> {
  // TTL of 4 hours — drafts shouldn't take that long
  await kv.put(`activity:${channelId}`, matchId, { expirationTtl: 4 * 60 * 60 })
}

/** Store match mappings for participants (used when activity channel differs from queue channel) */
export async function storeUserMatchMappings(
  kv: KVNamespace,
  userIds: string[],
  matchId: string,
): Promise<void> {
  const ttl = 4 * 60 * 60
  await Promise.all(userIds.map(userId => kv.put(`activity-user:${userId}`, matchId, { expirationTtl: ttl })))
}

/** Get match ID for a channel (used by activity to find its room) */
export async function getMatchForChannel(
  kv: KVNamespace,
  channelId: string,
): Promise<string | null> {
  return kv.get(`activity:${channelId}`)
}

/** Get match ID for a user (fallback when channel mapping is unavailable) */
export async function getMatchForUser(
  kv: KVNamespace,
  userId: string,
): Promise<string | null> {
  return kv.get(`activity-user:${userId}`)
}
