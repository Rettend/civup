import type { DraftSeat, DraftTimerConfig, GameMode, LeaderDataVersion, QueueEntry, RoomConfig } from '@civup/game'
import type { LobbyState } from '../lobby/types.ts'
import { allFactionIds, getDraftFormat, isTeamMode, normalizeMapVoteEnabled, requiresRedDeathDuplicateFactions, resolveLeaderPoolSize, sampleLeaderPool, slotToTeamIndex, teamCount, teamSize } from '@civup/game'
import { api, CIVUP_INTERNAL_SECRET_HEADER, createDraftRoomAccessToken, normalizeHost } from '@civup/utils'
import { nanoid } from 'nanoid'
import { getCurrentLobbiesForPlayer, getLobbiesByChannel, getLobbyById, getLobbyByMatch, getOpenLobbyForPlayer } from '../lobby/index.ts'
import { channelIndexKey, idKey, matchKey, modeIndexKey } from '../lobby/keys.ts'
import { lobbySnapshotKey } from '../lobby/live-snapshot.ts'
import { stateStoreMdelete, stateStoreMget, stateStoreMput } from '../state/store.ts'
import { syncActivityOverviewSnapshot } from './live-state.ts'

// ── Types ───────────────────────────────────────────────────

export interface MatchCreationResult {
  matchId: string
  formatId: string
  seats: DraftSeat[]
}

export interface CreateDraftRoomOptions {
  hostId: string
  leaderDataVersion?: LeaderDataVersion
  blindBans?: boolean
  simultaneousPick?: boolean
  redDeath?: boolean
  mapVoteEnabled?: boolean
  randomDraft?: boolean
  duplicateFactions?: boolean
  botHost?: string
  webhookSecret?: string
  timerConfig?: DraftTimerConfig
  leaderPoolSize?: number | null
  dealOptionsSize?: number | null
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

const DEFAULT_BOT_HOST = 'http://localhost:8787'
const ACTIVITY_MAPPING_TTL = 48 * 60 * 60

export function activityLobbyUserKey(userId: string): string {
  return `activity-lobby-user:${userId}`
}

export function activityUserKey(userId: string): string {
  return `activity-user:${userId}`
}

export function activityMatchKey(matchId: string): string {
  return `activity-match:${matchId}`
}

function targetUserKey(userId: string, channelId: string): string {
  return `activity-target-user:${userId}:${channelId}`
}

function targetSelectionPrefix(kind: StoredActivityTargetSelection['kind'], channelId: string, targetId: string): string {
  return `activity-target-${kind}:${channelId}:${targetId}:`
}

function targetSelectionKey(kind: StoredActivityTargetSelection['kind'], channelId: string, targetId: string, userId: string): string {
  return `${targetSelectionPrefix(kind, channelId, targetId)}${userId}`
}

function parseTargetSelectionUserId(key: string, prefix: string): string | null {
  if (!key.startsWith(prefix)) return null
  const userId = key.slice(prefix.length)
  return userId.length > 0 ? userId : null
}

function reverseTargetSelectionKey(
  channelId: string,
  userId: string,
  target: StoredActivityTargetSelection,
): string {
  return targetSelectionKey(target.kind, channelId, target.id, userId)
}

async function getUserActivityTargets(
  kv: KVNamespace,
  channelId: string,
  userIds: string[],
): Promise<(StoredActivityTargetSelection | null)[]> {
  if (userIds.length === 0) return []

  const rawTargets = await stateStoreMget(
    kv,
    userIds.map(userId => ({ key: targetUserKey(userId, channelId), type: 'json' })),
  )
  return rawTargets.map(raw => parseActivityTargetSelection(raw))
}

async function buildUserActivityTargetEntries(
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
  selectedAt: number,
  pendingJoin: boolean,
): Promise<{ key: string, value: string, expirationTtl: number }[]> {
  const serializedTargets = await Promise.all(userIds.map(
    userId => serializeActivityTargetSelection(channelId, userId, target, selectedAt, pendingJoin),
  ))

  const entries: { key: string, value: string, expirationTtl: number }[] = []

  for (let index = 0; index < userIds.length; index++) {
    const userId = userIds[index]
    const serializedTarget = serializedTargets[index]
    if (!userId || !serializedTarget) continue

    entries.push({
      key: targetUserKey(userId, channelId),
      value: JSON.stringify(serializedTarget),
      expirationTtl: ACTIVITY_MAPPING_TTL,
    })

    entries.push({
      key: reverseTargetSelectionKey(channelId, userId, serializedTarget),
      value: String(selectedAt),
      expirationTtl: ACTIVITY_MAPPING_TTL,
    })
  }

  return entries
}

async function getExistingTargetCleanupKeys(
  kv: KVNamespace,
  channelId: string,
  userIds: string[],
  options?: {
    clearLobbyMappings?: boolean
    clearMatchMappings?: boolean
  },
): Promise<string[]> {
  if (userIds.length === 0) return []

  const currentTargets = await getUserActivityTargets(kv, channelId, userIds)
  const keys = new Set<string>()
  for (let index = 0; index < userIds.length; index++) {
    const userId = userIds[index]
    const currentTarget = currentTargets[index]
    if (!userId || !currentTarget) continue
    keys.add(reverseTargetSelectionKey(channelId, userId, currentTarget))
  }

  if (options?.clearLobbyMappings === true) {
    for (const userId of userIds) {
      if (!userId) continue
      keys.add(activityLobbyUserKey(userId))
    }
  }

  if (options?.clearMatchMappings === true) {
    for (const userId of userIds) {
      if (!userId) continue
      keys.add(activityUserKey(userId))
    }
  }

  return [...keys]
}

async function getUserIdsTargetingTarget(
  kv: KVNamespace,
  kind: StoredActivityTargetSelection['kind'],
  channelId: string,
  targetId: string,
): Promise<string[]> {
  const prefix = targetSelectionPrefix(kind, channelId, targetId)
  const listed = await kv.list({ prefix })
  return listed.keys
    .map(entry => parseTargetSelectionUserId(entry.name, prefix))
    .filter((userId): userId is string => userId != null)
}

// ── Create a draft room via PartyKit HTTP API ───────────

/** Creates a PartyKit draft room and returns the match config */
export async function createDraftRoom(
  mode: GameMode,
  entries: QueueEntry[],
  options: CreateDraftRoomOptions,
): Promise<MatchCreationResult> {
  const matchId = nanoid(12)
  const seats: DraftSeat[] = buildSeats(mode, entries)
  const redDeathMode = options.redDeath === true
  const simultaneousPick = mode === 'ffa' && !redDeathMode && options.simultaneousPick === true
  const randomDraft = options.randomDraft === true
  // Duplicate picks are a general draft-engine capability; only Red Death forces them on.
  const duplicateFactions = redDeathMode
    ? (requiresRedDeathDuplicateFactions(mode) || options.duplicateFactions === true)
    : (options.duplicateFactions === true)
  const mapVoteEnabled = normalizeMapVoteEnabled(mode, options.mapVoteEnabled === true, { redDeath: redDeathMode })
  const format = getDraftFormat(mode, { simultaneousPick, randomDraft, redDeath: redDeathMode, blindBans: options.blindBans, seatCount: seats.length })
  const civPool = redDeathMode
    ? [...allFactionIds]
    : sampleLeaderPool(resolveLeaderPoolSize(mode, seats.length, options.leaderPoolSize))
  const config: RoomConfig = {
    matchId,
    hostId: options.hostId,
    formatId: format.id,
    seats,
    civPool,
    dealOptionsSize: redDeathMode ? options.dealOptionsSize ?? undefined : undefined,
    randomDraft,
    duplicateFactions,
    mapVoteEnabled,
    leaderDataVersion: options.leaderDataVersion ?? 'live',
    timerConfig: options.timerConfig,
    webhookUrl: buildDraftWebhookUrl(options.botHost),
    webhookSecret: options.webhookSecret,
  }

  // Room name = matchId so activity and bot commands hit the same runtime.
  const normalizedHost = normalizeHost(options.botHost, DEFAULT_BOT_HOST)
  const url = `${normalizedHost}/parties/main/${matchId}`

  await api.post(url, config, {
    headers: options.webhookSecret
      ? { [CIVUP_INTERNAL_SECRET_HEADER]: options.webhookSecret }
      : undefined,
  })

  return { matchId, formatId: format.id, seats }
}

function buildDraftWebhookUrl(botHost: string | undefined): string {
  const normalizedBotHost = normalizeHost(botHost, DEFAULT_BOT_HOST)
  return `${normalizedBotHost}/api/webhooks/draft-complete`
}

// ── Build seats with team assignment ────────────────────────

function buildSeats(mode: GameMode, entries: QueueEntry[]): DraftSeat[] {
  if (isTeamMode(mode)) {
    const playersPerTeam = teamSize(mode, entries.length) ?? 0
    const teams = teamCount(mode, entries.length)
    const seats: DraftSeat[] = []

    for (let position = 0; position < playersPerTeam; position++) {
      for (let team = 0; team < teams; team++) {
        const entry = entries[team * playersPerTeam + position]
        if (!entry) continue
        seats.push({
          playerId: entry.playerId,
          displayName: entry.displayName,
          avatarUrl: entry.avatarUrl ?? null,
          team,
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
      team: slotToTeamIndex(mode, i, entries.length) ?? undefined,
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
      key: activityMatchKey(matchId),
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
      key: activityUserKey(userId),
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
  const cleanupKeys = await getExistingTargetCleanupKeys(kv, channelId, userIds, {
    clearLobbyMappings: target.kind === 'match',
    clearMatchMappings: target.kind === 'lobby',
  })
  if (cleanupKeys.length > 0) {
    await stateStoreMdelete(kv, cleanupKeys)
  }
  await stateStoreMput(kv, await buildUserActivityTargetEntries(channelId, userIds, target, selectedAt, pendingJoin))
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
  const cleanupKeys = await getExistingTargetCleanupKeys(kv, channelId, userIds, {
    clearMatchMappings: true,
  })
  const targetEntries = await buildUserActivityTargetEntries(channelId, userIds, target, selectedAt, pendingJoin)

  if (cleanupKeys.length > 0) {
    await stateStoreMdelete(kv, cleanupKeys)
  }

  await stateStoreMput(kv, [
    ...userIds.map(userId => ({
      key: activityLobbyUserKey(userId),
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
  const cleanupKeys = await getExistingTargetCleanupKeys(kv, channelId, userIds, {
    clearLobbyMappings: true,
  })
  const targetEntries = await buildUserActivityTargetEntries(channelId, userIds, {
    kind: 'match',
    id: target.matchId,
    lobbyId: target.lobbyId,
    mode: target.mode,
    steamLobbyLink: target.steamLobbyLink,
    activitySecret: target.activitySecret,
  }, selectedAt, false)

  if (cleanupKeys.length > 0) {
    await stateStoreMdelete(kv, cleanupKeys)
  }

  await stateStoreMput(kv, [
    {
      key: activityMatchKey(target.matchId),
      value: channelId,
      expirationTtl: ACTIVITY_MAPPING_TTL,
    },
    ...userIds.map(userId => ({
      key: activityUserKey(userId),
      value: target.matchId,
      expirationTtl: ACTIVITY_MAPPING_TTL,
    })),
    ...targetEntries,
  ])
}

export async function handoffLobbySpectatorsToMatchActivity(
  kv: KVNamespace,
  channelId: string,
  lobbyId: string,
  memberUserIds: string[],
  target: {
    matchId: string
    lobbyId?: string | null
    mode?: GameMode | null
    steamLobbyLink?: string | null
    activitySecret?: string | undefined
  },
): Promise<string[]> {
  const prefix = targetSelectionPrefix('lobby', channelId, lobbyId)
  const listed = await kv.list({ prefix })
  const memberUserIdSet = new Set(memberUserIds)
  const candidateUserIds = listed.keys
    .map(entry => parseTargetSelectionUserId(entry.name, prefix))
    .filter((userId): userId is string => userId != null && !memberUserIdSet.has(userId))

  if (candidateUserIds.length === 0) return []

  const targets = await getUserActivityTargets(kv, channelId, candidateUserIds)
  const spectatorUserIds = candidateUserIds.filter((userId, index) => {
    const selection = targets[index]
    return selection?.kind === 'lobby' && selection.id === lobbyId
  })
  if (spectatorUserIds.length === 0) return []

  await storeMatchActivityState(kv, channelId, spectatorUserIds, target)
  return spectatorUserIds
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
  const keys = new Set(userIds.map(userId => targetUserKey(userId, channelId)))
  const targets = await getUserActivityTargets(kv, channelId, userIds)
  for (let index = 0; index < userIds.length; index++) {
    const userId = userIds[index]
    const target = targets[index]
    if (!userId || !target) continue
    keys.add(reverseTargetSelectionKey(channelId, userId, target))
  }
  await stateStoreMdelete(kv, [...keys])
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
      key: activityLobbyUserKey(userId),
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
  const realLobby = await getOpenLobbyForPlayer(kv, userId)
  if (realLobby) {
    await storeUserLobbyMappings(kv, [userId], realLobby.id)
    return realLobby.id
  }

  await clearUserLobbyMappings(kv, [userId])
  return null
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
  const key = activityUserKey(userId)
  const mappedMatchId = await kv.get(key)
  if (mappedMatchId) {
    const mappedLobby = await getLobbyByMatch(kv, mappedMatchId)
    if (mappedLobby && isCurrentMatchLobby(mappedLobby) && mappedLobby.memberPlayerIds.includes(userId)) {
      await Promise.all([
        storeUserMatchMappings(kv, [userId], mappedMatchId),
        storeMatchMapping(kv, mappedLobby.channelId, mappedMatchId),
      ])
      return mappedMatchId
    }

    await stateStoreMdelete(kv, [key])
  }

  const liveLobby = (await getCurrentLobbiesForPlayer(kv, userId))
    .filter((candidate): candidate is LobbyState & { matchId: string } => isCurrentMatchLobby(candidate))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null
  if (!liveLobby?.matchId) return null

  await Promise.all([
    storeUserMatchMappings(kv, [userId], liveLobby.matchId),
    storeMatchMapping(kv, liveLobby.channelId, liveLobby.matchId),
  ])
  return liveLobby.matchId
}

/** Get channel ID by match ID (used by webhooks to post updates) */
export async function getChannelForMatch(
  kv: KVNamespace,
  matchId: string,
): Promise<string | null> {
  const key = activityMatchKey(matchId)
  const mappedChannelId = await kv.get(key)
  const lobby = await getLobbyByMatch(kv, matchId)
  if (lobby) {
    if (mappedChannelId !== lobby.channelId) {
      await storeMatchMapping(kv, lobby.channelId, matchId)
    }
    return lobby.channelId
  }

  if (!mappedChannelId) return null

  await stateStoreMdelete(kv, [key])
  return mappedChannelId
}

/** Remove activity mappings once draft lifecycle moves to in-game */
export async function clearActivityMappings(
  kv: KVNamespace,
  matchId: string,
  userIds: string[],
  channelId?: string,
): Promise<void> {
  const effectiveChannelId = channelId ?? await getChannelForMatch(kv, matchId) ?? undefined
  const targetedUserIds = effectiveChannelId
    ? await getUserIdsTargetingTarget(kv, 'match', effectiveChannelId, matchId)
    : []
  const allUserIds = [...new Set([...userIds, ...targetedUserIds])]
  const keys = new Set<string>([activityMatchKey(matchId)])
  if (allUserIds.length > 0) {
    const currentMatchIds = await Promise.all(allUserIds.map(userId => kv.get(activityUserKey(userId))))
    for (let index = 0; index < allUserIds.length; index++) {
      const userId = allUserIds[index]
      if (!userId || currentMatchIds[index] !== matchId) continue
      keys.add(activityUserKey(userId))
    }
  }
  if (effectiveChannelId) {
    const currentTargets = await getUserActivityTargets(kv, effectiveChannelId, allUserIds)
    for (let index = 0; index < allUserIds.length; index++) {
      const userId = allUserIds[index]
      const target = currentTargets[index]
      if (!userId || target?.kind !== 'match' || target.id !== matchId) continue
      keys.add(targetUserKey(userId, effectiveChannelId))
    }
    for (const userId of targetedUserIds) {
      keys.add(targetSelectionKey('match', effectiveChannelId, matchId, userId))
    }
  }

  await stateStoreMdelete(kv, [...keys])
}

/** Remove open-lobby mappings once a lobby is cancelled or started.
 * When lobbyId is provided, only delete mappings that still point at that lobby.
 */
export async function clearLobbyMappings(
  kv: KVNamespace,
  userIds: string[],
  channelId?: string,
  lobbyId?: string,
): Promise<void> {
  if (userIds.length === 0) return
  const targetedUserIds = channelId && lobbyId
    ? await getUserIdsTargetingTarget(kv, 'lobby', channelId, lobbyId)
    : []
  const allUserIds = [...new Set([...userIds, ...targetedUserIds])]
  const keys = new Set<string>()

  if (!lobbyId) {
    for (const userId of userIds) {
      if (!userId) continue
      keys.add(activityLobbyUserKey(userId))
    }

    if (channelId) {
      const targets = await getUserActivityTargets(kv, channelId, userIds)
      for (let index = 0; index < userIds.length; index++) {
        const userId = userIds[index]
        if (!userId) continue
        keys.add(targetUserKey(userId, channelId))
        const target = targets[index]
        if (!target) continue
        keys.add(reverseTargetSelectionKey(channelId, userId, target))
      }
    }

    await stateStoreMdelete(kv, [...keys])
    return
  }

  const [mappedLobbyIds, targets] = await Promise.all([
    Promise.all(allUserIds.map(userId => kv.get(activityLobbyUserKey(userId)))),
    channelId ? getUserActivityTargets(kv, channelId, allUserIds) : Promise.resolve([]),
  ])

  for (let index = 0; index < allUserIds.length; index++) {
    const userId = allUserIds[index]
    if (!userId) continue

    if (mappedLobbyIds[index] === lobbyId) {
      keys.add(activityLobbyUserKey(userId))
    }

    if (!channelId) continue
    const target = targets[index]
    if (target?.kind === 'lobby' && target.id === lobbyId) {
      keys.add(targetUserKey(userId, channelId))
      keys.add(targetSelectionKey('lobby', channelId, lobbyId, userId))
    }
  }

  if (channelId) {
    for (const userId of targetedUserIds) {
      keys.add(targetSelectionKey('lobby', channelId, lobbyId, userId))
    }
  }

  if (keys.size === 0) return
  await stateStoreMdelete(kv, [...keys])
}

export async function clearLobbyAndActivityMappings(
  kv: KVNamespace,
  lobby: Pick<LobbyState, 'id' | 'mode' | 'channelId' | 'matchId' | 'memberPlayerIds'>,
): Promise<void> {
  const spectatorUserIds = await getUserIdsTargetingTarget(kv, 'lobby', lobby.channelId, lobby.id)
  const targetedMatchUserIds = lobby.matchId
    ? await getUserIdsTargetingTarget(kv, 'match', lobby.channelId, lobby.matchId)
    : []
  const allUserIds = [...new Set([
    ...lobby.memberPlayerIds,
    ...spectatorUserIds,
    ...targetedMatchUserIds,
  ])]
  const keys = [
    idKey(lobby.id),
    lobbySnapshotKey(lobby.id),
    modeIndexKey(lobby.mode, lobby.id),
    channelIndexKey(lobby.channelId, lobby.id),
    ...allUserIds.map(userId => activityLobbyUserKey(userId)),
    ...allUserIds.map(userId => targetUserKey(userId, lobby.channelId)),
    ...spectatorUserIds.map(userId => targetSelectionKey('lobby', lobby.channelId, lobby.id, userId)),
  ]
  if (lobby.matchId) {
    keys.push(matchKey(lobby.matchId))
    keys.push(activityMatchKey(lobby.matchId))
    keys.push(...allUserIds.map(userId => activityUserKey(userId)))
    keys.push(...targetedMatchUserIds.map(userId => targetSelectionKey('match', lobby.channelId, lobby.matchId!, userId)))
  }
  await stateStoreMdelete(kv, keys)
  await syncActivityOverviewSnapshot(kv, lobby.channelId)
}

/** Remove only the user -> open-lobby mapping while keeping the current channel target. */
export async function clearUserLobbyMappings(
  kv: KVNamespace,
  userIds: string[],
): Promise<void> {
  if (userIds.length === 0) return
  await stateStoreMdelete(kv, userIds.map(userId => activityLobbyUserKey(userId)))
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

function isCurrentMatchLobby(
  lobby: Pick<LobbyState, 'status' | 'matchId'>,
): lobby is Pick<LobbyState, 'status'> & { matchId: string } {
  return (lobby.status === 'drafting' || lobby.status === 'active')
    && typeof lobby.matchId === 'string'
    && lobby.matchId.length > 0
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
