import type { DraftSeat, DraftTimerConfig, GameMode, QueueEntry, RoomConfig } from '@civup/game'
import { allLeaderIds, getDefaultFormat, isTeamMode } from '@civup/game'
import { nanoid } from 'nanoid'

// ── Types ───────────────────────────────────────────────────

export interface MatchCreationResult {
  matchId: string
  formatId: string
  seats: DraftSeat[]
}

export interface CreateDraftRoomOptions {
  partyHost?: string
  botHost?: string
  webhookSecret?: string
  timerConfig?: DraftTimerConfig
}

// ── Configuration ───────────────────────────────────────────

/** PartyKit server URL (local in dev, deployed in prod) */
const DEFAULT_PARTY_HOST = 'http://localhost:1999'
const DEFAULT_BOT_HOST = 'http://localhost:8787'
const ACTIVITY_MAPPING_TTL = 12 * 60 * 60

// ── Create a draft room via PartyKit HTTP API ───────────────

/** Creates a PartyKit draft room and returns the match config */
export async function createDraftRoom(
  mode: GameMode,
  entries: QueueEntry[],
  options: CreateDraftRoomOptions = {},
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
    timerConfig: options.timerConfig,
    webhookUrl: buildDraftWebhookUrl(options.botHost, options.partyHost),
    webhookSecret: options.webhookSecret,
  }

  // POST to PartyKit to create the room
  // Room name = matchId so activity can connect to the same room
  const normalizedHost = normalizeHost(options.partyHost, DEFAULT_PARTY_HOST)
  const url = `${normalizedHost}/parties/main/${matchId}`

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to create draft room: ${res.status} ${text}`)
  }

  return { matchId, formatId: format.id, seats }
}

function normalizeHost(host: string | undefined, fallback: string): string {
  const raw = (host && host.trim()) || fallback
  const withProtocol = raw.startsWith('http://') || raw.startsWith('https://')
    ? raw
    : `${isLocalHost(raw) ? 'http' : 'https'}://${raw}`
  return withProtocol.replace(/\/$/, '')
}

function buildDraftWebhookUrl(botHost: string | undefined, partyHost: string | undefined): string | undefined {
  if (!botHost && partyHost && !isLocalHost(partyHost)) {
    console.warn('BOT_HOST is not configured while PARTY_HOST is remote; draft-complete webhook is disabled for this match')
    return undefined
  }

  const normalizedBotHost = normalizeHost(botHost, DEFAULT_BOT_HOST)
  return `${normalizedBotHost}/api/webhooks/draft-complete`
}

function isLocalHost(host: string): boolean {
  const raw = host.trim().toLowerCase()
  return raw.includes('localhost') || raw.includes('127.0.0.1')
}

// ── Build seats with team assignment ────────────────────────

function buildSeats(mode: GameMode, entries: QueueEntry[]): DraftSeat[] {
  if (isTeamMode(mode)) {
    // Team modes: first half is Team A, second half is Team B
    const teamSize = mode === '2v2' ? 2 : 3
    const seats: DraftSeat[] = []

    for (let i = 0; i < teamSize; i++) {
      // Team A player
      const teamAEntry = entries[i]
      if (teamAEntry) {
        seats.push({
          playerId: teamAEntry.playerId,
          displayName: teamAEntry.displayName,
          avatarUrl: teamAEntry.avatarUrl ?? null,
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
          avatarUrl: teamBEntry.avatarUrl ?? null,
          team: 1,
        })
      }
    }

    return seats
  }

  if (mode === 'duel') {
    return entries.map((e, i) => ({
      playerId: e.playerId,
      displayName: e.displayName,
      avatarUrl: e.avatarUrl ?? null,
      team: i,
    }))
  }

  // FFA: no teams
  return entries.map(e => ({
    playerId: e.playerId,
    displayName: e.displayName,
    avatarUrl: e.avatarUrl ?? null,
  }))
}

/** Store match mapping for channel → matchId lookup */
export async function storeMatchMapping(
  kv: KVNamespace,
  channelId: string,
  matchId: string,
): Promise<void> {
  await Promise.all([
    kv.put(`activity:${channelId}`, matchId, { expirationTtl: ACTIVITY_MAPPING_TTL }),
    kv.put(`activity-match:${matchId}`, channelId, { expirationTtl: ACTIVITY_MAPPING_TTL }),
  ])
}

/** Store match mappings for participants (used when activity channel differs from queue channel) */
export async function storeUserMatchMappings(
  kv: KVNamespace,
  userIds: string[],
  matchId: string,
): Promise<void> {
  await Promise.all(userIds.map(userId => kv.put(`activity-user:${userId}`, matchId, { expirationTtl: ACTIVITY_MAPPING_TTL })))
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

/** Get channel ID by match ID (used by webhooks to post updates) */
export async function getChannelForMatch(
  kv: KVNamespace,
  matchId: string,
): Promise<string | null> {
  return kv.get(`activity-match:${matchId}`)
}

/** Remove activity mappings once draft lifecycle moves to in-game */
export async function clearActivityMappings(
  kv: KVNamespace,
  matchId: string,
  userIds: string[],
  channelId?: string,
): Promise<void> {
  const deletions = [
    kv.delete(`activity-match:${matchId}`),
    ...userIds.map(userId => kv.delete(`activity-user:${userId}`)),
  ]
  if (channelId) {
    deletions.push(kv.delete(`activity:${channelId}`))
  }
  await Promise.all(deletions)
}
