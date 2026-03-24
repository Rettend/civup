import type { DraftSeat, DraftTimerConfig, GameMode, LeaderDataVersion, QueueEntry, RoomConfig } from '@civup/game'
import { getDraftFormat, isTeamMode, resolveLeaderPoolSize, sampleLeaderPool, slotToTeamIndex, teamSize } from '@civup/game'
import { api, CIVUP_INTERNAL_SECRET_HEADER, createDraftRoomAccessToken, isLocalHost, normalizeHost } from '@civup/utils'
import { nanoid } from 'nanoid'
import { getLobbiesByChannel } from '../lobby/index.ts'
import { channelIndexKey, draftRosterKey, idKey, matchKey, modeIndexKey } from '../lobby/keys.ts'
import { lobbySnapshotKey } from '../lobby/live-snapshot.ts'
import type { LobbyState } from '../lobby/types.ts'
import { stateStoreMdelete, stateStoreMput } from '../state/store.ts'

// ── Types ───────────────────────────────────────────────────

export interface MatchCreationResult {
  matchId: string
  formatId: string
  seats: DraftSeat[]
}

export interface CreateDraftRoomOptions {
  hostId: string
  leaderDataVersion?: LeaderDataVersion
  simultaneousPick?: boolean
  partyHost?: string
  botHost?: string
  webhookSecret?: string
  timerConfig?: DraftTimerConfig
  leaderPoolSize?: number | null
}

export interface ActivityTargetSelection {
  kind: 'lobby' | 'match'
  id: string
  selectedAt: number
  pendingJoin: boolean
}

export interface MatchActivityTargetSelection extends ActivityTargetSelection {
  kind: 'match'
  lobbyId: string | null
  mode: GameMode | null
  steamLobbyLink: string | null
  roomAccessToken: string | null
}

type StoredActivityTargetSelection = ActivityTargetSelection | MatchActivityTargetSelection

// ── Configuration ──────────────────────────────────────────

const DEFAULT_PARTY_HOST = 'http://localhost:1999'
const DEFAULT_BOT_HOST = 'http://localhost:8787'
const ACTIVITY_MAPPING_TTL = 48 * 60 * 60

function targetUserKey(userId: string, channelId: string): string {
  return `activity-target-user:${userId}:${channelId}`
}

// ── Create a draft room via PartyKit HTTP API ───────────

/** Creates a PartyKit draft room and returns the match config */
export async function createDraftRoom(
  mode: GameMode,
  entries: QueueEntry[],
  options: CreateDraftRoomOptions,
): Promise<MatchCreationResult> {
  const matchId = nanoid(12)
  const format = getDraftFormat(mode, { simultaneousPick: options.simultaneousPick })
  const seats: DraftSeat[] = buildSeats(mode, entries)
  const leaderPoolSize = resolveLeaderPoolSize(mode, seats.length, options.leaderPoolSize)
  const config: RoomConfig = {
    matchId,
    hostId: options.hostId,
    formatId: format.id,
    seats,
    civPool: sampleLeaderPool(leaderPoolSize),
    leaderDataVersion: options.leaderDataVersion ?? 'live',
    timerConfig: options.timerConfig,
    webhookUrl: buildDraftWebhookUrl(options.botHost, options.partyHost),
    webhookSecret: options.webhookSecret,
  }

  // Room name = matchId so activity can connect to the same room
  const normalizedHost = normalizeHost(options.partyHost, DEFAULT_PARTY_HOST)
  const url = `${normalizedHost}/parties/main/${matchId}`

  await api.post(url, config, {
    headers: options.webhookSecret
      ? { [CIVUP_INTERNAL_SECRET_HEADER]: options.webhookSecret }
      : undefined,
  })

  return { matchId, formatId: format.id, seats }
}

function buildDraftWebhookUrl(botHost: string | undefined, partyHost: string | undefined): string | undefined {
  if (!botHost && partyHost && !isLocalHost(partyHost)) {
    console.warn('BOT_HOST is not configured while PARTY_HOST is remote; draft-complete webhook is disabled for this match')
    return undefined
  }

  const normalizedBotHost = normalizeHost(botHost, DEFAULT_BOT_HOST)
  return `${normalizedBotHost}/api/webhooks/draft-complete`
}

// ── Build seats with team assignment ────────────────────────

function buildSeats(mode: GameMode, entries: QueueEntry[]): DraftSeat[] {
  if (isTeamMode(mode)) {
    // Team modes: first slot of each team is the captain (A1, B1, A2, B2...)
    const teamSlotCount = teamSize(mode) ?? 0
    const seats: DraftSeat[] = []

    for (let i = 0; i < teamSlotCount; i++) {
      const teamAEntry = entries[i]
      if (teamAEntry) {
        seats.push({
          playerId: teamAEntry.playerId,
          displayName: teamAEntry.displayName,
          avatarUrl: teamAEntry.avatarUrl ?? null,
          team: 0,
        })
      }

      const teamBEntry = entries[teamSlotCount + i]
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

  if (mode === '1v1') {
    return entries.map((e, i) => ({
      playerId: e.playerId,
      displayName: e.displayName,
      avatarUrl: e.avatarUrl ?? null,
      team: slotToTeamIndex(mode, i) ?? undefined,
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
  await stateStoreMput(kv, [
    {
      key: `activity-match:${matchId}`,
      value: channelId,
      expirationTtl: ACTIVITY_MAPPING_TTL,
    },
  ])
}

/** Store match mappings for participants (used when activity channel differs from queue channel) */
export async function storeUserMatchMappings(
  kv: KVNamespace,
  userIds: string[],
  matchId: string,
): Promise<void> {
  await stateStoreMput(
    kv,
    userIds.map(userId => ({
      key: `activity-user:${userId}`,
      value: matchId,
      expirationTtl: ACTIVITY_MAPPING_TTL,
    })),
  )
}

/** Store the currently selected activity target for one channel. */
export async function storeUserActivityTarget(
  kv: KVNamespace,
  channelId: string,
  userIds: string[],
  target:
    | ({ kind: 'lobby', id: string, pendingJoin?: boolean })
    | {
      kind: 'match'
      id: string
      lobbyId?: string | null
      mode?: GameMode | null
      steamLobbyLink?: string | null
      activitySecret?: string | undefined
    },
): Promise<void> {
  const selectedAt = Date.now()
  const pendingJoin = target.kind === 'lobby' && target.pendingJoin === true
  const entries = await Promise.all(
    userIds.map(async (userId) => ({
      key: targetUserKey(userId, channelId),
      value: JSON.stringify(await serializeActivityTargetSelection(channelId, userId, target, selectedAt, pendingJoin)),
      expirationTtl: ACTIVITY_MAPPING_TTL,
    })),
  )
  await stateStoreMput(
    kv,
    entries,
  )
}

export async function storeUserLobbyState(
  kv: KVNamespace,
  channelId: string,
  userIds: string[],
  lobbyId: string,
  options?: {
    pendingJoin?: boolean
  },
): Promise<void> {
  if (userIds.length === 0) return

  const selectedAt = Date.now()
  const pendingJoin = options?.pendingJoin === true
  const target = { kind: 'lobby' as const, id: lobbyId, pendingJoin }
  const targetEntries = await Promise.all(
    userIds.map(async (userId) => ({
      key: targetUserKey(userId, channelId),
      value: JSON.stringify(await serializeActivityTargetSelection(channelId, userId, target, selectedAt, pendingJoin)),
      expirationTtl: ACTIVITY_MAPPING_TTL,
    })),
  )

  await stateStoreMput(kv, [
    ...userIds.map(userId => ({
      key: `activity-lobby-user:${userId}`,
      value: lobbyId,
      expirationTtl: ACTIVITY_MAPPING_TTL,
    })),
    ...targetEntries,
  ])
}

export async function storeMatchActivityState(
  kv: KVNamespace,
  channelId: string,
  userIds: string[],
  target: {
    matchId: string
    lobbyId?: string | null
    mode?: GameMode | null
    steamLobbyLink?: string | null
    activitySecret?: string | undefined
  },
): Promise<void> {
  const selectedAt = Date.now()
  const targetEntries = await Promise.all(
    userIds.map(async (userId) => ({
      key: targetUserKey(userId, channelId),
      value: JSON.stringify(await serializeActivityTargetSelection(channelId, userId, {
        kind: 'match',
        id: target.matchId,
        lobbyId: target.lobbyId,
        mode: target.mode,
        steamLobbyLink: target.steamLobbyLink,
        activitySecret: target.activitySecret,
      }, selectedAt, false)),
      expirationTtl: ACTIVITY_MAPPING_TTL,
    })),
  )

  await stateStoreMput(kv, [
    {
      key: `activity-match:${target.matchId}`,
      value: channelId,
      expirationTtl: ACTIVITY_MAPPING_TTL,
    },
    ...userIds.map(userId => ({
      key: `activity-user:${userId}`,
      value: target.matchId,
      expirationTtl: ACTIVITY_MAPPING_TTL,
    })),
    ...targetEntries,
  ])
}

/** Get the currently selected activity target for one channel/user pair. */
export async function getUserActivityTarget(
  kv: KVNamespace,
  channelId: string,
  userId: string,
): Promise<ActivityTargetSelection | null> {
  const raw = await kv.get(targetUserKey(userId, channelId), 'json')
  return parseActivityTargetSelection(raw)
}

/** Remove channel-scoped activity target selections for users. */
export async function clearUserActivityTargets(
  kv: KVNamespace,
  channelId: string,
  userIds: string[],
): Promise<void> {
  if (userIds.length === 0) return
  await stateStoreMdelete(kv, userIds.map(userId => targetUserKey(userId, channelId)))
}

/** Store open-lobby mappings for users so activity can reopen the correct lobby. */
export async function storeUserLobbyMappings(
  kv: KVNamespace,
  userIds: string[],
  lobbyId: string,
): Promise<void> {
  await stateStoreMput(
    kv,
    userIds.map(userId => ({
      key: `activity-lobby-user:${userId}`,
      value: lobbyId,
      expirationTtl: ACTIVITY_MAPPING_TTL,
    })),
  )
}

/** Get open-lobby ID for a user if one was recently selected. */
export async function getLobbyForUser(
  kv: KVNamespace,
  userId: string,
): Promise<string | null> {
  return kv.get(`activity-lobby-user:${userId}`)
}

/** Get a unique active match ID for a channel when only one exists. */
export async function getMatchForChannel(
  kv: KVNamespace,
  channelId: string,
): Promise<string | null> {
  const matchIds = new Set<string>()

  const lobbies = await getLobbiesByChannel(kv, channelId)
  for (const lobby of lobbies) {
    if (!lobby.matchId) continue
    if (lobby.status !== 'drafting' && lobby.status !== 'active') continue
    matchIds.add(lobby.matchId)
    if (matchIds.size > 1) return null
  }

  return [...matchIds][0] ?? null
}

/** Get match ID for a user (fallback when channel mapping is unavailable) */
export async function getMatchForUser(
  kv: KVNamespace,
  userId: string,
): Promise<string | null> {
  const key = `activity-user:${userId}`
  const matchId = await kv.get(key)
  if (!matchId) return null

  const activeChannelId = await kv.get(`activity-match:${matchId}`)
  if (activeChannelId) {
    return matchId
  }

  await kv.delete(key)
  return null
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
  const keys = [`activity-match:${matchId}`]
  for (const userId of userIds) {
    keys.push(`activity-user:${userId}`)
    if (channelId) keys.push(targetUserKey(userId, channelId))
  }
  await stateStoreMdelete(kv, keys)
}

/** Remove open-lobby mappings once a lobby is cancelled or started. */
export async function clearLobbyMappings(
  kv: KVNamespace,
  userIds: string[],
  channelId?: string,
): Promise<void> {
  if (userIds.length === 0) return
  const keys = userIds.map(userId => `activity-lobby-user:${userId}`)
  if (channelId) {
    keys.push(...userIds.map(userId => targetUserKey(userId, channelId)))
  }
  await stateStoreMdelete(kv, keys)
}

export async function clearLobbyAndActivityMappings(
  kv: KVNamespace,
  lobby: Pick<LobbyState, 'id' | 'mode' | 'channelId' | 'matchId' | 'memberPlayerIds'>,
): Promise<void> {
  const keys = [
    idKey(lobby.id),
    lobbySnapshotKey(lobby.id),
    draftRosterKey(lobby.id),
    modeIndexKey(lobby.mode, lobby.id),
    channelIndexKey(lobby.channelId, lobby.id),
    ...lobby.memberPlayerIds.map(userId => `activity-lobby-user:${userId}`),
    ...lobby.memberPlayerIds.map(userId => targetUserKey(userId, lobby.channelId)),
  ]
  if (lobby.matchId) keys.push(matchKey(lobby.matchId))
  await stateStoreMdelete(kv, keys)
}

/** Remove only the user -> open-lobby mapping while keeping the current channel target. */
export async function clearUserLobbyMappings(
  kv: KVNamespace,
  userIds: string[],
): Promise<void> {
  if (userIds.length === 0) return
  await stateStoreMdelete(kv, userIds.map(userId => `activity-lobby-user:${userId}`))
}

export async function clearLobbyMappingsIfMatchingLobby(
  kv: KVNamespace,
  userIds: string[],
  lobbyId: string,
  channelId: string,
): Promise<void> {
  if (userIds.length === 0) return

  const [mappedLobbyIds, targets] = await Promise.all([
    Promise.all(userIds.map(userId => getLobbyForUser(kv, userId))),
    Promise.all(userIds.map(userId => getUserActivityTarget(kv, channelId, userId))),
  ])

  const keys = new Set<string>()
  for (let index = 0; index < userIds.length; index++) {
    const userId = userIds[index]
    if (!userId) continue

    if (mappedLobbyIds[index] === lobbyId) {
      keys.add(`activity-lobby-user:${userId}`)
    }

    const target = targets[index]
    if (target?.kind === 'lobby' && target.id === lobbyId) {
      keys.add(targetUserKey(userId, channelId))
    }
  }

  if (keys.size === 0) return
  await stateStoreMdelete(kv, [...keys])
}

function parseActivityTargetSelection(raw: unknown): StoredActivityTargetSelection | null {
  if (!raw || typeof raw !== 'object') return null

  const parsed = raw as {
    kind?: unknown
    id?: unknown
    selectedAt?: unknown
    pendingJoin?: unknown
    lobbyId?: unknown
    mode?: unknown
    steamLobbyLink?: unknown
    roomAccessToken?: unknown
  }

  if (parsed.kind !== 'lobby' && parsed.kind !== 'match') return null
  if (typeof parsed.id !== 'string' || parsed.id.length === 0) return null
  if (typeof parsed.selectedAt !== 'number' || !Number.isFinite(parsed.selectedAt)) return null

  if (parsed.kind === 'match') {
    return {
      kind: 'match',
      id: parsed.id,
      selectedAt: parsed.selectedAt,
      pendingJoin: false,
      lobbyId: typeof parsed.lobbyId === 'string' && parsed.lobbyId.length > 0 ? parsed.lobbyId : null,
      mode: typeof parsed.mode === 'string' && parsed.mode.length > 0 ? parsed.mode as GameMode : null,
      steamLobbyLink: typeof parsed.steamLobbyLink === 'string' && parsed.steamLobbyLink.length > 0 ? parsed.steamLobbyLink : null,
      roomAccessToken: typeof parsed.roomAccessToken === 'string' && parsed.roomAccessToken.length > 0 ? parsed.roomAccessToken : null,
    }
  }

  return {
    kind: parsed.kind,
    id: parsed.id,
    selectedAt: parsed.selectedAt,
    pendingJoin: parsed.pendingJoin === true,
  }
}

async function serializeActivityTargetSelection(
  channelId: string,
  userId: string,
  target:
    | ({ kind: 'lobby', id: string, pendingJoin?: boolean })
    | {
      kind: 'match'
      id: string
      lobbyId?: string | null
      mode?: GameMode | null
      steamLobbyLink?: string | null
      activitySecret?: string | undefined
    },
  selectedAt: number,
  pendingJoin: boolean,
): Promise<StoredActivityTargetSelection> {
  if (target.kind === 'match') {
    return {
      kind: 'match',
      id: target.id,
      selectedAt,
      pendingJoin: false,
      lobbyId: target.lobbyId ?? null,
      mode: target.mode ?? null,
      steamLobbyLink: target.steamLobbyLink ?? null,
      roomAccessToken: await buildDraftRoomAccessToken(target.activitySecret, userId, target.id, channelId),
    }
  }

  return {
    kind: 'lobby',
    id: target.id,
    selectedAt,
    pendingJoin,
  }
}

async function buildDraftRoomAccessToken(
  activitySecret: string | undefined,
  userId: string,
  matchId: string,
  channelId: string,
): Promise<string | null> {
  const secret = activitySecret?.trim() ?? ''
  if (secret.length === 0) return null
  return createDraftRoomAccessToken(secret, {
    userId,
    roomId: matchId,
    channelId,
  })
}
