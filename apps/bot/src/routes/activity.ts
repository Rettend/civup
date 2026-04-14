import type { GameMode } from '@civup/game'
import type { Hono } from 'hono'
import type { Env } from '../env.ts'
import type { LeaderboardModeSnapshot } from '../services/leaderboard/snapshot.ts'
import type { LobbyState } from '../services/lobby/index.ts'
import type { getQueueState } from '../services/queue/index.ts'
import { createDb, matches, matchParticipants } from '@civup/db'
import { formatModeLabel, GAME_MODES, toBalanceLeaderboardMode } from '@civup/game'
import { createDraftRoomAccessToken } from '@civup/utils'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { clearUserActivityTargets, getLobbyForUser, getMatchForChannel, getMatchForUser, getUserActivityTarget, storeUserActivityTarget, storeUserMatchMappings } from '../services/activity/index.ts'
import { leaderboardModeSnapshotKey, normalizeLeaderboardModeSnapshot } from '../services/leaderboard/snapshot.ts'
import { filterQueueEntriesForLobby, getCurrentLobbiesForPlayer, getLobbiesByChannel, getLobbyById, getLobbyByMatch, getOpenLobbyForPlayer, normalizeLobbySlots } from '../services/lobby/index.ts'
import { findPersistedLiveMatchIdsForPlayers } from '../services/match/live.ts'
import { getPlayerQueueMode, getPlayerQueueModeFromStates, parseQueueState, queueKey } from '../services/queue/index.ts'
import { createStateStore, stateStoreMget } from '../services/state/store.ts'
import { rejectMismatchedActivityParam, requireAuthenticatedActivity } from './auth.ts'
import { buildOpenLobbySnapshot, buildOpenLobbySnapshotFromParts, getUniqueOpenLobbyForChannel, isQueueBackedOpenLobby } from './lobby/snapshot.ts'

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
  redDeath: boolean
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
  balanceSnapshot?: LeaderboardModeSnapshot | null
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
      if (mappedLobby?.status === 'open' && mappedLobby.memberPlayerIds.includes(userId)) {
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

    return c.json(await buildActivityLaunchSnapshot(c.env.DISCORD_TOKEN, c.env.CIVUP_SECRET, kv, channelId, userId, {
      db: c.env.DB,
    }))
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
    const result = await selectActivityTargetForUser(kv, channelId, auth.identity.userId, {
      kind,
      id,
      activitySecret: c.env.CIVUP_SECRET,
    })
    if (!result.ok) {
      return c.json({ error: result.error }, result.status)
    }

    return c.json({ ok: true })
  })
}

export async function selectActivityTargetForUser(
  kv: KVNamespace,
  channelId: string,
  userId: string,
  target: {
    kind: 'lobby' | 'match'
    id: string
    activitySecret?: string | undefined
  },
): Promise<{ ok: true } | { ok: false, error: string, status: 409 }> {
  if (target.kind === 'lobby') {
    const lobby = await getLobbyById(kv, target.id)
    if (!lobby || lobby.channelId !== channelId || lobby.status !== 'open') {
      await clearUserActivityTargets(kv, channelId, [userId])
      return { ok: false, error: 'That target is no longer available.', status: 409 }
    }

    await storeUserActivityTarget(kv, channelId, [userId], { kind: 'lobby', id: target.id })
    return { ok: true }
  }

  const lobby = await getLobbyByMatch(kv, target.id)
  if (!lobby || lobby.channelId !== channelId || (lobby.status !== 'drafting' && lobby.status !== 'active')) {
    await clearUserActivityTargets(kv, channelId, [userId])
    return { ok: false, error: 'That target is no longer available.', status: 409 }
  }

  await storeUserActivityTarget(kv, channelId, [userId], {
    kind: 'match',
    id: target.id,
    lobbyId: lobby.id,
    mode: lobby.mode,
    steamLobbyLink: lobby.steamLobbyLink,
    activitySecret: target.activitySecret,
  })
  return { ok: true }
}

export async function buildActivityLaunchSnapshot(
  token: string | undefined,
  activitySecret: string | undefined,
  kv: KVNamespace,
  channelId: string,
  userId: string,
  options?: {
    db?: D1Database | null
  },
): Promise<ActivityLaunchSnapshot> {
  const context = await loadActivityLaunchContext(token, kv, channelId, userId)
  const selection = await resolveActivityLaunchSelection(kv, channelId, userId, context.targets)
  return buildActivityLaunchSnapshotFromTargets(token, activitySecret, kv, userId, context, selection, options?.db)
}

async function buildActivityLaunchSnapshotFromTargets(
  token: string | undefined,
  activitySecret: string | undefined,
  kv: KVNamespace,
  userId: string,
  context: ActivityLaunchContext,
  selection: ResolvedActivitySelection | null,
  db: D1Database | null | undefined,
): Promise<ActivityLaunchSnapshot> {
  return {
    selection: selection ? await serializeActivityLaunchSelection(token, activitySecret, kv, userId, context, selection, db) : null,
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
      const currentMembershipSelection = pickCurrentActivityMembershipSelection(targets)
      if (
        currentMembershipSelection
        && currentMembershipSelection.target.option.kind === 'lobby'
        && isDifferentActivityTarget(currentMembershipSelection.target.option, storedSelection.option)
      ) {
        const storedIsCurrentMemberTarget = storedSelection.option.isHost || storedSelection.option.isMember
        if (storedSelection.option.kind === 'lobby' && !storedIsCurrentMemberTarget) {
          await clearUserActivityTargets(kv, channelId, [userId])
          return currentMembershipSelection
        }
      }

      return {
        target: storedSelection,
        pendingJoin: storedTarget.kind === 'lobby' && storedTarget.pendingJoin,
      }
    }

    const promotedSelection = await promoteLobbySelectionToMatchTarget(
      storedTarget,
      targets,
    )
    if (promotedSelection) return promotedSelection

    const fallbackSelection = pickDefaultActivityLaunchSelection(targets)
    await clearUserActivityTargets(kv, channelId, [userId])
    if (fallbackSelection) return fallbackSelection

    return null
  }

  return pickDefaultActivityLaunchSelection(targets)
}

async function promoteLobbySelectionToMatchTarget(
  storedTarget: Awaited<ReturnType<typeof getUserActivityTarget>>,
  targets: ChannelActivityTarget[],
): Promise<ResolvedActivitySelection | null> {
  if (!storedTarget || storedTarget.kind !== 'lobby') return null

  const promotedTarget = targets.find(target => target.option.kind === 'match' && target.option.lobbyId === storedTarget.id) ?? null
  if (!promotedTarget) return null

  return {
    target: promotedTarget,
    pendingJoin: false,
  }
}

async function serializeActivityLaunchSelection(
  token: string | undefined,
  activitySecret: string | undefined,
  kv: KVNamespace,
  userId: string,
  context: ActivityLaunchContext,
  selection: ResolvedActivitySelection,
  db: D1Database | null | undefined,
): Promise<ActivityLaunchSelection> {
  if (selection.target.option.kind === 'lobby') {
    const lobby = await buildOpenLobbySnapshotFromParts(
      kv,
      selection.target.lobby.mode,
      selection.target.lobby,
      selection.target.queueEntries ?? [],
      selection.target.slots ?? selection.target.lobby.slots,
      selection.target.balanceSnapshot,
    )
    return {
      kind: 'lobby',
      option: selection.target.option,
      pendingJoin: selection.pendingJoin,
      joinEligibility: await resolveLobbyJoinEligibility(token, kv, userId, selection.target.lobby, lobby, {
        db,
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
    db?: D1Database | null
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
  const persistedLiveMatchIds = await findPersistedLiveMatchIdsForPlayers(options?.db, [userId])
  const hasLiveMatch = persistedLiveMatchIds == null
    ? otherCurrentLobbies.some(candidate => candidate.status !== 'open')
    : persistedLiveMatchIds.has(userId)
  if (hasLiveMatch) {
    return {
      canJoin: false,
      blockedReason: 'You are already in a live match.',
      pendingSlot: null,
    }
  }

  const blockingLobby = otherCurrentLobbies.find(candidate => candidate.status === 'open') ?? null
  if (blockingLobby) {
    if (blockingLobby.status === 'open') {
      const hasOtherMembers = blockingLobby.memberPlayerIds.some(playerId => playerId !== userId)
      if (!(blockingLobby.hostId === userId && hasOtherMembers)) {
        const pendingSlot = lobbySnapshot.entries.findIndex(entry => entry == null)
        if (pendingSlot >= 0) {
          return {
            canJoin: true,
            blockedReason: null,
            pendingSlot,
          }
        }
      }
    }

    return {
      canJoin: false,
      blockedReason: blockingLobby.status === 'open'
        ? blockingLobby.hostId === userId && blockingLobby.memberPlayerIds.some(playerId => playerId !== userId)
          ? 'You are hosting another open lobby with other players. Cancel it first.'
          : blockingLobby.mode === lobby.mode
            ? 'You are already in another open lobby.'
            : `You're already in a ${formatModeLabel(blockingLobby.mode, blockingLobby.mode, { redDeath: blockingLobby.draftConfig.redDeath })} lobby.`
        : 'You are already in a live match.',
      pendingSlot: null,
    }
  }

  const existingQueueMode = options?.existingQueueMode !== undefined
    ? options.existingQueueMode
    : await getPlayerQueueMode(kv, userId, { fallbackToQueueScan: false })
  if (existingQueueMode && existingQueueMode !== lobby.mode) {
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
  const channelLobbies = await getLobbiesByChannel(kv, channelId)
  const { queueStates, balanceSnapshots } = await loadActivityLaunchState(kv, channelLobbies)
  const targets: ChannelActivityTarget[] = []
  const lobbiesByMode = new Map<GameMode, LobbyState[]>()

  for (const lobby of channelLobbies) {
    const mode = lobby.mode
    const existing = lobbiesByMode.get(mode)
    if (existing) existing.push(lobby)
    else lobbiesByMode.set(mode, [lobby])

    if (lobby.status === 'open') {
      const queue = queueStates.get(mode)
      if (!queue) continue

      const lobbyQueueEntries = filterQueueEntriesForLobby(lobby, queue.entries)
      if (!isQueueBackedOpenLobby(lobby, lobbyQueueEntries)) continue
      const slots = normalizeLobbySlots(mode, lobby.slots, lobbyQueueEntries)
      targets.push({
        lobby,
        queueEntries: lobbyQueueEntries,
        slots,
        balanceSnapshot: resolveLobbyBalanceSnapshot(balanceSnapshots, lobby),
        option: {
          kind: 'lobby',
          id: lobby.id,
          lobbyId: lobby.id,
          matchId: null,
          channelId,
          mode,
          status: 'open',
          participantCount: countFilledSlots(slots),
          targetSize: slots.length,
          redDeath: lobby.draftConfig.redDeath,
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
          targetSize: lobby.slots.length,
          redDeath: lobby.draftConfig.redDeath,
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

async function loadActivityLaunchState(
  kv: KVNamespace,
  channelLobbies: LobbyState[],
): Promise<{
  queueStates: Map<GameMode, Awaited<ReturnType<typeof getQueueState>>>
  balanceSnapshots: Map<string, LeaderboardModeSnapshot>
}> {
  const requestedBalanceModes = [...new Set(
    channelLobbies
      .filter(lobby => lobby.status === 'open')
      .map(lobby => toBalanceLeaderboardMode(lobby.mode, { redDeath: lobby.draftConfig.redDeath }))
      .filter((mode): mode is NonNullable<ReturnType<typeof toBalanceLeaderboardMode>> => mode != null),
  )]

  const rawState = await stateStoreMget(kv, [
    ...GAME_MODES.map(mode => ({ key: queueKey(mode), type: 'json' as const })),
    ...requestedBalanceModes.map(mode => ({ key: leaderboardModeSnapshotKey(mode), type: 'json' as const })),
  ])

  const queueStates = new Map<GameMode, Awaited<ReturnType<typeof getQueueState>>>()
  for (let index = 0; index < GAME_MODES.length; index++) {
    const mode = GAME_MODES[index]
    if (!mode) continue
    queueStates.set(mode, parseQueueState(mode, rawState[index]))
  }

  const balanceSnapshots = new Map<string, LeaderboardModeSnapshot>()
  for (let index = 0; index < requestedBalanceModes.length; index++) {
    const mode = requestedBalanceModes[index]
    if (!mode) continue
    const snapshot = normalizeLeaderboardModeSnapshot(mode, rawState[GAME_MODES.length + index])
    if (!snapshot) continue
    balanceSnapshots.set(mode, snapshot)
  }

  return {
    queueStates,
    balanceSnapshots,
  }
}

function resolveLobbyBalanceSnapshot(
  balanceSnapshots: ReadonlyMap<string, LeaderboardModeSnapshot>,
  lobby: LobbyState,
): LeaderboardModeSnapshot | null {
  const mode = toBalanceLeaderboardMode(lobby.mode, { redDeath: lobby.draftConfig.redDeath })
  if (!mode) return null
  return balanceSnapshots.get(mode) ?? null
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
  const preferredTarget = pickCurrentActivityMembershipTarget(targets)
    ?? null
  if (!preferredTarget) return null

  return {
    target: preferredTarget,
    pendingJoin: false,
  }
}

function pickCurrentActivityMembershipSelection(targets: ChannelActivityTarget[]): ResolvedActivitySelection | null {
  const preferredTarget = pickCurrentActivityMembershipTarget(targets)
  if (!preferredTarget) return null

  return {
    target: preferredTarget,
    pendingJoin: false,
  }
}

function pickCurrentActivityMembershipTarget(targets: ChannelActivityTarget[]): ChannelActivityTarget | null {
  return targets.find(target => (target.option.isHost || target.option.isMember) && target.option.kind === 'match')
    ?? targets.find(target => target.option.isHost || target.option.isMember)
    ?? null
}

function isDifferentActivityTarget(left: ActivityTargetOption, right: ActivityTargetOption): boolean {
  return left.kind !== right.kind || left.id !== right.id
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
