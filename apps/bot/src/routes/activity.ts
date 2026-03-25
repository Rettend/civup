import type { GameMode } from '@civup/game'
import type { Hono } from 'hono'
import type { Env } from '../env.ts'
import type { LobbyState } from '../services/lobby/index.ts'
import type { getQueueState } from '../services/queue/index.ts'
import { createDb, matches, matchParticipants } from '@civup/db'
import { formatModeLabel, maxPlayerCount } from '@civup/game'
import { createDraftRoomAccessToken } from '@civup/utils'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { clearUserActivityTargets, getLobbyForUser, getMatchForChannel, getMatchForUser, getUserActivityTarget, storeUserActivityTarget, storeUserMatchMappings } from '../services/activity/index.ts'
import { filterQueueEntriesForLobby, getCurrentLobbiesForPlayer, getLobbiesByChannel, getLobbyById, getOpenLobbyForPlayer, normalizeLobbySlots } from '../services/lobby/index.ts'
import { getPlayerQueueMode, getPlayerQueueModeFromStates, getQueueStates } from '../services/queue/index.ts'
import { createStateStore } from '../services/state/store.ts'
import { rejectMismatchedActivityParam, requireAuthenticatedActivity } from './auth.ts'
import { buildOpenLobbySnapshot, buildOpenLobbySnapshotFromParts, getUniqueOpenLobbyForChannel } from './lobby/snapshot.ts'

export interface LobbyJoinEligibility {
  canJoin: boolean
  blockedReason: string | null
  pendingSlot: number | null
}

interface ActivityTargetOption {
  kind: 'lobby' | 'match'
  id: string
  lobbyId: string
  matchId: string | null
  channelId: string
  mode: GameMode
  status: 'open' | 'drafting' | 'active'
  participantCount: number
  targetSize: number
  isMember: boolean
  isHost: boolean
  updatedAt: number
}

type ActivityLaunchSelection
  = | {
    kind: 'lobby'
    option: ActivityTargetOption
    pendingJoin: boolean
    joinEligibility: LobbyJoinEligibility
    lobby: Awaited<ReturnType<typeof buildOpenLobbySnapshot>>
  }
  | {
    kind: 'match'
    option: ActivityTargetOption
    matchId: string
    steamLobbyLink: string | null
    roomAccessToken: string | null
  }

interface ActivityLaunchSnapshot {
  selection: ActivityLaunchSelection | null
  options: ActivityTargetOption[]
}

interface ChannelActivityTarget {
  option: ActivityTargetOption
  lobby: LobbyState
  queueEntries?: Awaited<ReturnType<typeof getQueueState>>['entries']
  slots?: (string | null)[]
}

interface ResolvedActivitySelection {
  target: ChannelActivityTarget
  pendingJoin: boolean
}

interface ActivityLaunchContext {
  targets: ChannelActivityTarget[]
  queueStates: Map<GameMode, Awaited<ReturnType<typeof getQueueState>>>
  lobbiesByMode: Map<GameMode, LobbyState[]>
}

export function registerActivityRoutes(app: Hono<Env>) {
  app.get('/api/match/:channelId', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const channelId = c.req.param('channelId')
    const kv = createStateStore(c.env)
    const matchId = await getMatchForChannel(kv, channelId)

    if (!matchId) {
      return c.json({ error: 'No active match for this channel' }, 404)
    }

    return c.json({ matchId })
  })

  app.get('/api/match/user/:userId', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const mismatch = rejectMismatchedActivityParam(c, auth.identity.userId)
    if (mismatch) return mismatch

    const userId = auth.identity.userId
    const kv = createStateStore(c.env)
    const matchId = await getMatchForUser(kv, userId)

    if (matchId) {
      return c.json({ matchId })
    }

    const db = createDb(c.env.DB)
    const [active] = await db
      .select({
        matchId: matchParticipants.matchId,
      })
      .from(matchParticipants)
      .innerJoin(matches, eq(matchParticipants.matchId, matches.id))
      .where(and(
        eq(matchParticipants.playerId, userId),
        inArray(matches.status, ['drafting', 'active']),
      ))
      .orderBy(desc(matches.createdAt))
      .limit(1)

    if (!active?.matchId) {
      return c.json({ error: 'No active match for this user' }, 404)
    }

    await storeUserMatchMappings(kv, [userId], active.matchId)
    return c.json({ matchId: active.matchId })
  })

  app.get('/api/lobby/:channelId', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const channelId = c.req.param('channelId')
    const kv = createStateStore(c.env)

    const lobby = await getUniqueOpenLobbyForChannel(kv, channelId)
    if (lobby) {
      return c.json(await buildOpenLobbySnapshot(kv, lobby.mode, lobby))
    }

    return c.json({ error: 'No open lobby for this channel' }, 404)
  })

  app.get('/api/lobby/user/:userId', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const mismatch = rejectMismatchedActivityParam(c, auth.identity.userId)
    if (mismatch) return mismatch

    const userId = auth.identity.userId
    const kv = createStateStore(c.env)
    const mappedLobbyId = await getLobbyForUser(kv, userId)
    if (mappedLobbyId) {
      const mappedLobby = await getLobbyById(kv, mappedLobbyId)
      if (mappedLobby?.status === 'open') {
        return c.json(await buildOpenLobbySnapshot(kv, mappedLobby.mode, mappedLobby))
      }
    }

    const mode = await getPlayerQueueMode(kv, userId)
    if (!mode) {
      return c.json({ error: 'User is not in an open lobby queue' }, 404)
    }

    const lobby = await getOpenLobbyForPlayer(kv, userId, mode)
    if (!lobby || lobby.status !== 'open') {
      return c.json({ error: 'No open lobby for this user' }, 404)
    }

    return c.json(await buildOpenLobbySnapshot(kv, mode, lobby))
  })

  app.get('/api/activity/launch/:channelId/:userId', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const mismatch = rejectMismatchedActivityParam(c, auth.identity.userId)
    if (mismatch) return mismatch

    const channelId = c.req.param('channelId')
    const userId = auth.identity.userId
    const kv = createStateStore(c.env)

    return c.json(await buildActivityLaunchSnapshot(c.env.DISCORD_TOKEN, c.env.CIVUP_SECRET, kv, channelId, userId))
  })

  app.post('/api/activity/target', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    let body: unknown
    try {
      body = await c.req.json()
    }
    catch {
      return c.json({ error: 'Invalid JSON payload' }, 400)
    }

    if (!body || typeof body !== 'object') {
      return c.json({ error: 'Invalid request body' }, 400)
    }

    const { channelId, userId, kind, id } = body as {
      channelId?: unknown
      userId?: unknown
      kind?: unknown
      id?: unknown
    }

    if (typeof channelId !== 'string' || channelId.length === 0) {
      return c.json({ error: 'channelId is required' }, 400)
    }

    if (typeof userId !== 'string' || userId.length === 0) {
      return c.json({ error: 'userId is required' }, 400)
    }

    if (userId !== auth.identity.userId) {
      return c.json({ error: 'Authenticated activity user mismatch' }, 403)
    }

    if ((kind !== 'lobby' && kind !== 'match') || typeof id !== 'string' || id.length === 0) {
      return c.json({ error: 'A valid target kind and id are required' }, 400)
    }

    const kv = createStateStore(c.env)
    const actualUserId = auth.identity.userId
    const context = await loadActivityLaunchContext(c.env.DISCORD_TOKEN, kv, channelId, actualUserId)
    const target = context.targets.find(candidate => candidate.option.kind === kind && candidate.option.id === id)
    if (!target) {
      await clearUserActivityTargets(kv, channelId, [actualUserId])
      return c.json({ error: 'That target is no longer available.' }, 409)
    }

    await storeUserActivityTarget(kv, channelId, [actualUserId], kind === 'match'
      ? {
          kind: 'match',
          id,
          lobbyId: target.lobby.id,
          mode: target.option.mode,
          steamLobbyLink: target.lobby.steamLobbyLink,
          activitySecret: c.env.CIVUP_SECRET,
        }
      : { kind: 'lobby', id })
    return c.json({ ok: true })
  })
}

export async function buildActivityLaunchSnapshot(
  token: string | undefined,
  activitySecret: string | undefined,
  kv: KVNamespace,
  channelId: string,
  userId: string,
): Promise<ActivityLaunchSnapshot> {
  const context = await loadActivityLaunchContext(token, kv, channelId, userId)
  const selection = await resolveActivityLaunchSelection(kv, channelId, userId, context.targets)
  return buildActivityLaunchSnapshotFromTargets(token, activitySecret, kv, userId, context, selection)
}

async function buildActivityLaunchSnapshotFromTargets(
  token: string | undefined,
  activitySecret: string | undefined,
  kv: KVNamespace,
  userId: string,
  context: ActivityLaunchContext,
  selection: ResolvedActivitySelection | null,
): Promise<ActivityLaunchSnapshot> {
  return {
    selection: selection ? await serializeActivityLaunchSelection(token, activitySecret, kv, userId, context, selection) : null,
    options: context.targets.map(target => target.option),
  }
}

async function resolveActivityLaunchSelection(
  kv: KVNamespace,
  channelId: string,
  userId: string,
  targets: ChannelActivityTarget[],
): Promise<ResolvedActivitySelection | null> {
  const storedTarget = await getUserActivityTarget(kv, channelId, userId)
  if (storedTarget) {
    const storedSelection = targets.find(target => target.option.kind === storedTarget.kind && target.option.id === storedTarget.id) ?? null
    if (storedSelection) {
      return {
        target: storedSelection,
        pendingJoin: storedTarget.kind === 'lobby' && storedTarget.pendingJoin,
      }
    }

    const fallbackSelection = pickDefaultActivityLaunchSelection(targets)
    await clearUserActivityTargets(kv, channelId, [userId])
    if (fallbackSelection) return fallbackSelection

    return null
  }

  return pickDefaultActivityLaunchSelection(targets)
}

async function serializeActivityLaunchSelection(
  token: string | undefined,
  activitySecret: string | undefined,
  kv: KVNamespace,
  userId: string,
  context: ActivityLaunchContext,
  selection: ResolvedActivitySelection,
): Promise<ActivityLaunchSelection> {
  if (selection.target.option.kind === 'lobby') {
    const lobby = await buildOpenLobbySnapshotFromParts(
      kv,
      selection.target.lobby.mode,
      selection.target.lobby,
      selection.target.queueEntries ?? [],
      selection.target.slots ?? selection.target.lobby.slots,
    )
    return {
      kind: 'lobby',
      option: selection.target.option,
      pendingJoin: selection.pendingJoin,
      joinEligibility: await resolveLobbyJoinEligibility(token, kv, userId, selection.target.lobby, lobby, {
        existingQueueMode: getPlayerQueueModeFromStates(context.queueStates.values(), userId),
      }),
      lobby,
    }
  }

  return {
    kind: 'match',
    option: selection.target.option,
    matchId: selection.target.option.id,
    steamLobbyLink: selection.target.lobby.steamLobbyLink,
    roomAccessToken: await issueDraftRoomAccessToken(activitySecret, userId, selection.target.option.id, selection.target.option.channelId),
  }
}

export async function resolveLobbyJoinEligibility(
  token: string | undefined,
  kv: KVNamespace,
  userId: string,
  lobby: LobbyState,
  lobbySnapshot: Awaited<ReturnType<typeof buildOpenLobbySnapshot>>,
  options?: {
    existingQueueMode?: GameMode | null
  },
): Promise<LobbyJoinEligibility> {
  if (lobby.status !== 'open') {
    return {
      canJoin: false,
      blockedReason: 'This lobby is no longer open.',
      pendingSlot: null,
    }
  }

  if (lobby.memberPlayerIds.includes(userId) || lobbySnapshot.entries.some(entry => entry?.playerId === userId)) {
    return {
      canJoin: true,
      blockedReason: null,
      pendingSlot: null,
    }
  }

  const otherCurrentLobbies = await getCurrentLobbiesForPlayer(kv, userId, {
    excludeLobbyIds: [lobby.id],
  })
  const blockingLobby = otherCurrentLobbies.find(candidate => candidate.status !== 'open') ?? otherCurrentLobbies[0] ?? null
  if (blockingLobby) {
    return {
      canJoin: false,
      blockedReason: blockingLobby.status === 'open'
        ? blockingLobby.mode === lobby.mode
          ? 'You are already in another open lobby.'
          : `You're already in a ${formatModeLabel(blockingLobby.mode)} lobby.`
        : 'You are already in a live match.',
      pendingSlot: null,
    }
  }

  const existingQueueMode = options?.existingQueueMode !== undefined
    ? options.existingQueueMode
    : await getPlayerQueueMode(kv, userId)
  if (existingQueueMode) {
    return {
      canJoin: false,
      blockedReason: `You're already in a ${formatModeLabel(existingQueueMode)} lobby.`,
      pendingSlot: null,
    }
  }

  const pendingSlot = lobbySnapshot.entries.findIndex(entry => entry == null)
  if (pendingSlot < 0) {
    return {
      canJoin: false,
      blockedReason: 'This lobby is full.',
      pendingSlot: null,
    }
  }

  return {
    canJoin: true,
    blockedReason: null,
    pendingSlot,
  }
}

async function loadActivityLaunchContext(
  token: string | undefined,
  kv: KVNamespace,
  channelId: string,
  userId: string,
): Promise<ActivityLaunchContext> {
  const queueStates = await getQueueStates(kv)
  const targets: ChannelActivityTarget[] = []

  const lobbiesByMode = new Map<GameMode, LobbyState[]>()
  const channelLobbies = await getLobbiesByChannel(kv, channelId)
  for (const lobby of channelLobbies) {
    const mode = lobby.mode
    const existing = lobbiesByMode.get(mode)
    if (existing) existing.push(lobby)
    else lobbiesByMode.set(mode, [lobby])

    if (lobby.status === 'open') {
      const queue = queueStates.get(mode)
      if (!queue) continue

      const lobbyQueueEntries = filterQueueEntriesForLobby(lobby, queue.entries)
      const slots = normalizeLobbySlots(mode, lobby.slots, lobbyQueueEntries)
      targets.push({
        lobby,
        queueEntries: lobbyQueueEntries,
        slots,
        option: {
          kind: 'lobby',
          id: lobby.id,
          lobbyId: lobby.id,
          matchId: null,
          channelId,
          mode,
          status: 'open',
          participantCount: countFilledSlots(slots),
          targetSize: maxPlayerCount(mode),
          isMember: lobby.memberPlayerIds.includes(userId),
          isHost: lobby.hostId === userId,
          updatedAt: lobby.updatedAt,
        },
      })
      continue
    }

    if ((lobby.status === 'drafting' || lobby.status === 'active') && lobby.matchId) {
      targets.push({
        lobby,
        option: {
          kind: 'match',
          id: lobby.matchId,
          lobbyId: lobby.id,
          matchId: lobby.matchId,
          channelId,
          mode,
          status: lobby.status,
          participantCount: countFilledSlots(lobby.slots),
          targetSize: maxPlayerCount(mode),
          isMember: lobby.memberPlayerIds.includes(userId),
          isHost: lobby.hostId === userId,
          updatedAt: lobby.updatedAt,
        },
      })
    }
  }

  return {
    targets: targets.sort(compareActivityTargets),
    queueStates,
    lobbiesByMode,
  }
}

function countFilledSlots(slots: (string | null)[]): number {
  let count = 0
  for (const slot of slots) {
    if (slot != null) count += 1
  }
  return count
}

function compareActivityTargets(left: ChannelActivityTarget, right: ChannelActivityTarget): number {
  const leftPriority = activityTargetPriority(left.option)
  const rightPriority = activityTargetPriority(right.option)
  if (leftPriority !== rightPriority) return leftPriority - rightPriority

  if (left.option.updatedAt !== right.option.updatedAt) return right.option.updatedAt - left.option.updatedAt
  if (left.option.mode !== right.option.mode) return left.option.mode.localeCompare(right.option.mode)
  return left.option.id.localeCompare(right.option.id)
}

function activityTargetPriority(option: ActivityTargetOption): number {
  if (option.isHost) return 0
  if (option.isMember) return 1
  if (option.kind === 'lobby') return 2
  return option.status === 'drafting' ? 3 : 4
}

function pickDefaultActivityLaunchSelection(targets: ChannelActivityTarget[]): ResolvedActivitySelection | null {
  const preferredTarget = targets.find(target => (target.option.isHost || target.option.isMember) && target.option.kind === 'match')
    ?? targets.find(target => target.option.isHost || target.option.isMember)
    ?? targets.find(target => target.option.kind === 'match')
  if (!preferredTarget) return null

  return {
    target: preferredTarget,
    pendingJoin: false,
  }
}

async function issueDraftRoomAccessToken(
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
