import type { GameMode } from '@civup/game'
import type { Hono } from 'hono'
import type { Env } from '../env.ts'
import type { ActivityTargetSelection } from '../services/activity/launch-target.ts'
import type { ActivitySessionDirectoryEntry, LobbySnapshot } from '../services/activity/session-state.ts'
import type { LeaderboardModeSnapshot } from '../services/leaderboard/snapshot.ts'
import type { LobbyState } from '../services/lobby/index.ts'
import type { RankedRoleAssignments } from '../services/ranked/role-sync.ts'
import type { SessionRecord } from '../session-runtime/session-record.ts'
import type { buildOpenLobbySnapshot } from './lobby/snapshot.ts'
import { createDb, matches, matchParticipants } from '@civup/db'
import { formatModeLabel, toBalanceLeaderboardMode } from '@civup/game'
import { createSessionAccessToken, getApprovedDiscordGuildIds, resolveApprovedDiscordGuildConfiguration } from '@civup/utils'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { getBrowserAccessState, normalizePublicOrigin } from '../services/activity/browser-access.ts'
import { clearActivityFollowTargetSelection, clearActivityLaunchTargetSelection, readActivityFollowTargetSelection, readActivityLaunchTargetSelection, storeActivityFollowTargetSelection } from '../services/activity/launch-target.ts'
import { attachTournamentLobbySnapshot, buildActivityOverviewOptions, buildActivityOverviewOptionsFromSessionRecord, buildLobbySnapshotFromDirectoryEntry, buildLobbySnapshotFromSessionRecord, getActivitySessionById, getActivitySessionByStableId, getActivitySessionsByChannel, getActivitySessionsForFeed, getOpenActivitySessionsForUser } from '../services/activity/session-state.ts'
import { getKvStore, kvMget } from '../services/kv/batch.ts'
import { leaderboardModeSnapshotKey, normalizeLeaderboardModeSnapshot } from '../services/leaderboard/snapshot.ts'
import { findPersistedBlockingDraftMatchIdsForPlayers } from '../services/match/live.ts'
import { cacheCurrentRankAssignments, currentRankAssignmentsKey, getCachedCurrentRankAssignments, normalizeRankedRoleAssignments } from '../services/ranked/role-sync.ts'
import { getCurrentSessionLobbyProjectionsForPlayer } from '../services/session/index.ts'
import { getSessionRecord, getSessionRepeatDraftAvailability } from '../session-runtime/session-do-client.ts'
import { rejectMismatchedActivityParam, requireAuthenticatedActivity } from './auth.ts'

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
  status: 'open' | 'closed' | 'drafting' | 'completed'
  reported?: boolean
  participantCount: number
  targetSize: number
  redDeath: boolean
  civBlitz: boolean
  isMember: boolean
  isHost: boolean
  players?: {
    playerId: string
    displayName: string
    avatarUrl?: string | null
  }[]
  updatedAt: number
}

type ActivityLaunchSelection
  = | {
    kind: 'lobby'
    option: ActivityTargetOption
    pendingJoin: boolean
    joinEligibility: LobbyJoinEligibility
    lobby: LobbySnapshot
  }
  | {
    kind: 'match'
    option: ActivityTargetOption
    matchId: string
    steamLobbyLink: string | null
    sessionAccessToken: string | null
    lobbyId: string | null
    mode: GameMode | null
  }

interface ActivityLaunchSnapshot {
  selection: ActivityLaunchSelection | null
  options: ActivityTargetOption[]
}

interface ChannelActivityTarget {
  option: ActivityTargetOption
  session: ActivitySessionDirectoryEntry
  balanceSnapshot?: LeaderboardModeSnapshot | null
  rankAssignments?: RankedRoleAssignments | null
}

interface ResolvedActivitySelection {
  target: ChannelActivityTarget
  pendingJoin: boolean
}

interface ActivityLaunchContext {
  targets: ChannelActivityTarget[]
}

interface ActivityLaunchState {
  balanceSnapshots: Map<string, LeaderboardModeSnapshot>
  rankAssignmentsByGuildId: Map<string, RankedRoleAssignments>
}

interface ActivityRuntimeOptions {
  db?: D1Database | null
  sessionNamespace?: DurableObjectNamespace | null
  activityNamespace?: DurableObjectNamespace | null
  internalSecret?: string | null
  guildIds?: readonly string[]
  legacyGuildId?: string | null
}

export function registerActivityRoutes(app: Hono<Env>) {
<<<<<<< New base: feat: save file analyzer
  app.get('/api/activity/session/:sessionId', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response
    const configError = await getBrowserContextConfigurationError(c.env, auth.identity.guildId)
    if (configError) return c.json({ error: configError }, 503)

    const sessionId = c.req.param('sessionId')
    const db = createDb(c.env.DB)
    const directory = await getActivitySessionByStableId(db, sessionId)
    if (!directory) return c.json({ error: 'Session not found' }, 404)

    const record = await resolveAuthoritativeSessionRecord(c.env.SessionDO, directory).catch(() => null)
    const session = record ? buildDirectoryEntryFromRecord(record) : directory
    if (!isApprovedActivitySession(c.env, session)) {
      return c.json({ error: 'Session is not from an approved matchmaking server' }, 403)
    }

    if (session.phase === 'cancelled') {
      return c.json({
        status: 'ended',
        sessionId: session.sessionId,
        matchId: session.matchId,
        phase: 'cancelled',
      })
    }

    const kv = getKvStore(c.env)
    const launchState = await loadActivityLaunchState(kv, [session])
    const option = record
      ? buildActivityOverviewOptionsFromSessionRecord(record)[0]
      : buildActivityOverviewOptions(session)[0]
    if (!option) return c.json({ error: 'Session is unavailable' }, 404)
    const isMember = option.memberPlayerIds.includes(auth.identity.userId)
    const isHost = option.hostId === auth.identity.userId
    const target: ChannelActivityTarget = {
      session,
      balanceSnapshot: resolveSessionBalanceSnapshot(launchState.balanceSnapshots, session),
      rankAssignments: resolveSessionRankAssignments(launchState.rankAssignmentsByGuildId, session),
      option: {
        ...option,
        isMember,
        isHost,
      },
    }
    const selection = await serializeActivityLaunchSelection(
      c.env.DISCORD_TOKEN,
      c.env.CIVUP_SECRET,
      kv,
      auth.identity.userId,
      { targets: [target] },
      { target, pendingJoin: false },
      c.env.DB,
      c.env.SessionDO,
      c.env.ALLOWED_DISCORD_GUILD_ID,
    )

    return c.json({
      status: 'available',
      sessionId: session.sessionId,
      matchId: session.matchId,
      phase: session.phase,
      selection,
    })
  })

  app.get('/api/activity/channel/:channelId', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response
    const configError = await getBrowserContextConfigurationError(c.env, auth.identity.guildId)
    if (configError) return c.json({ error: configError }, 503)

    const channelId = c.req.param('channelId')
    const context = await loadActivityLaunchContext(
      getKvStore(c.env),
      channelId,
      auth.identity.userId,
      c.env.DB,
      getApprovedDiscordGuildIds(c.env),
    )
    return c.json({
      status: 'available',
      channelId,
      snapshot: {
        selection: null,
        options: context.targets.map(target => target.option),
      },
    })
  })

||||||| Common ancestor
=======
  app.get('/api/activity/session/:sessionId', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response
    const configError = await getBrowserContextConfigurationError(c.env)
    if (configError) return c.json({ error: configError }, 503)

    const sessionId = c.req.param('sessionId')
    const db = createDb(c.env.DB)
    const directory = await getActivitySessionByStableId(db, sessionId)
    if (!directory) return c.json({ error: 'Session not found' }, 404)

    const record = await resolveAuthoritativeSessionRecord(c.env.SessionDO, directory).catch(() => null)
    const session = record ? buildDirectoryEntryFromRecord(record) : directory
    if (session.guildId !== c.env.ALLOWED_DISCORD_GUILD_ID?.trim()) {
      return c.json({ error: 'Session is not in the configured Discord server' }, 403)
    }

    if (session.phase === 'cancelled') {
      return c.json({
        status: 'ended',
        sessionId: session.sessionId,
        matchId: session.matchId,
        phase: 'cancelled',
      })
    }

    const kv = getKvStore(c.env)
    const launchState = await loadActivityLaunchState(kv, [session])
    const option = record
      ? buildActivityOverviewOptionsFromSessionRecord(record)[0]
      : buildActivityOverviewOptions(session)[0]
    if (!option) return c.json({ error: 'Session is unavailable' }, 404)
    const target: ChannelActivityTarget = {
      session,
      balanceSnapshot: resolveSessionBalanceSnapshot(launchState.balanceSnapshots, session),
      rankAssignments: resolveSessionRankAssignments(launchState.rankAssignmentsByGuildId, session),
      option: {
        ...option,
        isMember: option.memberPlayerIds.includes(auth.identity.userId),
        isHost: option.hostId === auth.identity.userId,
      },
    }
    const selection = await serializeActivityLaunchSelection(
      c.env.DISCORD_TOKEN,
      c.env.CIVUP_SECRET,
      kv,
      auth.identity.userId,
      { targets: [target] },
      { target, pendingJoin: false },
      c.env.DB,
      c.env.SessionDO,
    )

    return c.json({
      status: 'available',
      sessionId: session.sessionId,
      matchId: session.matchId,
      phase: session.phase,
      selection,
    })
  })

  app.get('/api/activity/channel/:channelId', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response
    const configError = await getBrowserContextConfigurationError(c.env)
    if (configError) return c.json({ error: configError }, 503)

    const channelId = c.req.param('channelId')
    const context = await loadActivityLaunchContext(
      getKvStore(c.env),
      channelId,
      auth.identity.userId,
      c.env.DB,
      c.env.SessionDO,
      c.env.ALLOWED_DISCORD_GUILD_ID,
    )
    return c.json({
      status: 'available',
      channelId,
      snapshot: {
        selection: null,
        options: context.targets.map(target => target.option),
      },
    })
  })

>>>>>>> Current commit: feat: external browser draft WIP
  app.get('/api/match/:channelId', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const channelId = c.req.param('channelId')
    const channelSessions = (await getActivitySessionsByChannel(createDb(c.env.DB), channelId))
      .filter(session => isApprovedActivitySession(c.env, session))
    const liveMatchIds = [...new Set(channelSessions.flatMap(session => (
      (session.phase === 'draft' || session.phase === 'swap' || session.phase === 'active')
        ? [session.matchId ?? session.sessionId]
        : []
    )))]
    const matchId = liveMatchIds.length === 1 ? liveMatchIds[0] : null

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

    if (active?.matchId) {
      return c.json({ matchId: active.matchId })
    }

    const liveMatchId = (await getOpenActivitySessionsForUser(db, userId))
      .find(session => session.phase === 'draft' || session.phase === 'swap')
      ?.sessionId ?? null
    if (liveMatchId) return c.json({ matchId: liveMatchId })

    return c.json({ error: 'No active match for this user' }, 404)
  })

  app.get('/api/lobby/:channelId', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const channelId = c.req.param('channelId')
    const kv = getKvStore(c.env)
    const db = createDb(c.env.DB)
    const sessions = (await getActivitySessionsByChannel(db, channelId))
      .filter(session => session.phase === 'open' && isApprovedActivitySession(c.env, session))

    if (sessions.length === 1) {
      const session = sessions[0]!
      const record = await resolveAuthoritativeSessionRecord(c.env.SessionDO, session)
      const snapshot = record
        ? await buildLobbySnapshotFromSessionRecord(kv, record, undefined, undefined, { legacyGuildId: c.env.ALLOWED_DISCORD_GUILD_ID })
        : await buildLobbySnapshotFromDirectoryEntry(kv, session, undefined, undefined, { legacyGuildId: c.env.ALLOWED_DISCORD_GUILD_ID })
      const lobby = await attachRepeatDraftSnapshot(await attachTournamentLobbySnapshot(db, snapshot), c.env.SessionDO, session.sessionId)
      return c.json(lobby)
    }

    return c.json({ error: 'No open lobby for this channel' }, 404)
  })

  app.get('/api/lobby/user/:userId', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const mismatch = rejectMismatchedActivityParam(c, auth.identity.userId)
    if (mismatch) return mismatch

    const userId = auth.identity.userId
    const kv = getKvStore(c.env)
    const db = createDb(c.env.DB)
    const session = (await getOpenActivitySessionsForUser(db, userId))
      .find(candidate => candidate.phase === 'open' && isApprovedActivitySession(c.env, candidate)) ?? null
    if (session) {
      const record = await resolveAuthoritativeSessionRecord(c.env.SessionDO, session)
      const snapshot = record
        ? await buildLobbySnapshotFromSessionRecord(kv, record, undefined, undefined, { legacyGuildId: c.env.ALLOWED_DISCORD_GUILD_ID })
        : await buildLobbySnapshotFromDirectoryEntry(kv, session, undefined, undefined, { legacyGuildId: c.env.ALLOWED_DISCORD_GUILD_ID })
      const lobby = await attachRepeatDraftSnapshot(await attachTournamentLobbySnapshot(db, snapshot), c.env.SessionDO, session.sessionId)
      return c.json(lobby)
    }

    return c.json({ error: 'No open lobby for this user' }, 404)
  })

  app.get('/api/activity/launch/:channelId/:userId', async (c) => {
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const mismatch = rejectMismatchedActivityParam(c, auth.identity.userId)
    if (mismatch) return mismatch

    const channelId = c.req.param('channelId')
    const userId = auth.identity.userId
    const kv = getKvStore(c.env)

    return c.json(await buildActivityLaunchSnapshot(c.env.DISCORD_TOKEN, c.env.CIVUP_SECRET, kv, channelId, userId, {
      db: c.env.DB,
      sessionNamespace: c.env.SessionDO,
      activityNamespace: c.env.Activity,
      internalSecret: c.env.CIVUP_SECRET,
      guildIds: getApprovedDiscordGuildIds(c.env),
      legacyGuildId: c.env.ALLOWED_DISCORD_GUILD_ID,
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

    const kv = getKvStore(c.env)
    const result = await selectActivityTargetForUser(c.env.DISCORD_TOKEN, c.env.CIVUP_SECRET, kv, channelId, auth.identity.userId, {
      kind,
      id,
    }, {
      db: c.env.DB,
      sessionNamespace: c.env.SessionDO,
      activityNamespace: c.env.Activity,
      internalSecret: c.env.CIVUP_SECRET,
      guildIds: getApprovedDiscordGuildIds(c.env),
      legacyGuildId: c.env.ALLOWED_DISCORD_GUILD_ID,
    })
    if (!result.ok) {
      return c.json({ error: result.error }, result.status)
    }

    return c.json({ ok: true, snapshot: result.snapshot })
  })
}

export async function selectActivityTargetForUser(
  token: string | undefined,
  activitySecret: string | undefined,
  kv: KVNamespace,
  channelId: string,
  userId: string,
  target: {
    kind: 'lobby' | 'match'
    id: string
  },
  options?: ActivityRuntimeOptions,
): Promise<{ ok: true, snapshot: ActivityLaunchSnapshot } | { ok: false, error: string, status: 409 }> {
  const context = await loadActivityLaunchContext(kv, channelId, userId, options?.db, options?.guildIds)
  const selection = pickActivityLaunchSelectionForTarget(context.targets, target)
  if (!selection) return { ok: false, error: 'That target is no longer available.', status: 409 }

  await storeActivityFollowTargetSelection(options?.activityNamespace, options?.internalSecret ?? undefined, channelId, userId, target)

  const snapshot = await buildActivityLaunchSnapshotFromTargets(token, activitySecret, kv, userId, context, selection, options?.db, options?.sessionNamespace, options?.legacyGuildId)
  return { ok: true, snapshot }
}

export async function buildActivityLaunchSnapshot(
  token: string | undefined,
  activitySecret: string | undefined,
  kv: KVNamespace,
  channelId: string,
  userId: string,
  options?: {
    db?: D1Database | null
    sessionNamespace?: DurableObjectNamespace | null
    activityNamespace?: DurableObjectNamespace | null
    internalSecret?: string | null
    guildIds?: readonly string[]
    legacyGuildId?: string | null
  },
): Promise<ActivityLaunchSnapshot> {
  const context = await loadActivityLaunchContext(kv, channelId, userId, options?.db, options?.guildIds)
  const launchTarget = await readActivityLaunchTargetSelection(options?.activityNamespace, options?.internalSecret ?? undefined, channelId, userId)
  if (launchTarget?.kind === 'overview') {
    await clearActivityLaunchTargetSelection(options?.activityNamespace, options?.internalSecret ?? undefined, channelId, userId)
    await clearActivityFollowTargetSelection(options?.activityNamespace, options?.internalSecret ?? undefined, channelId, userId)
    return buildActivityLaunchSnapshotFromTargets(token, activitySecret, kv, userId, context, null, options?.db, options?.sessionNamespace, options?.legacyGuildId)
  }
  await addRequestedReportedActivityTarget(context, launchTarget, userId, options?.db)
  const requestedSelection = pickActivityLaunchSelectionForTarget(context.targets, launchTarget)
  if (launchTarget && requestedSelection) {
    await clearActivityLaunchTargetSelection(options?.activityNamespace, options?.internalSecret ?? undefined, channelId, userId)
    await storeActivityFollowTargetSelection(options?.activityNamespace, options?.internalSecret ?? undefined, channelId, userId, launchTarget)
  }
  const followTarget = requestedSelection
    ? null
    : await readActivityFollowTargetSelection(options?.activityNamespace, options?.internalSecret ?? undefined, channelId, userId)
  const followedSelection = pickActivityLaunchSelectionForTarget(context.targets, followTarget)
  if (followTarget && !followedSelection) {
    await clearActivityFollowTargetSelection(options?.activityNamespace, options?.internalSecret ?? undefined, channelId, userId)
  }
  const selection = requestedSelection
    ?? followedSelection
    ?? pickDefaultActivityLaunchSelection(context.targets)
  return buildActivityLaunchSnapshotFromTargets(token, activitySecret, kv, userId, context, selection, options?.db, options?.sessionNamespace, options?.legacyGuildId)
}

async function addRequestedReportedActivityTarget(
  context: ActivityLaunchContext,
  launchTarget: ActivityTargetSelection | null,
  userId: string,
  d1: D1Database | null | undefined,
): Promise<void> {
  if (!d1 || launchTarget?.kind !== 'match') return
  if (context.targets.some(candidate => candidate.option.kind === 'match' && candidate.option.id === launchTarget.id)) return

  const session = await getActivitySessionById(createDb(d1), launchTarget.id)
  if (session?.phase !== 'reported') return

  const option = buildActivityOverviewOptions(session)[0]
  if (!option) return

  context.targets.unshift({
    session,
    option: {
      ...option,
      isMember: option.memberPlayerIds.includes(userId),
      isHost: option.hostId === userId,
    },
  })
}

async function buildActivityLaunchSnapshotFromTargets(
  token: string | undefined,
  activitySecret: string | undefined,
  kv: KVNamespace,
  userId: string,
  context: ActivityLaunchContext,
  selection: ResolvedActivitySelection | null,
  db: D1Database | null | undefined,
  sessionNamespace: DurableObjectNamespace | null | undefined,
  legacyGuildId: string | null | undefined,
): Promise<ActivityLaunchSnapshot> {
  const serializedSelection = selection
    ? await serializeActivityLaunchSelection(token, activitySecret, kv, userId, context, selection, db, sessionNamespace, legacyGuildId)
    : null
  return {
    selection: serializedSelection,
    options: context.targets
      .filter(target => target.session.phase !== 'reported')
      .map(target => serializedSelection && target.option.id === serializedSelection.option.id ? serializedSelection.option : target.option),
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
  sessionNamespace: DurableObjectNamespace | null | undefined,
  legacyGuildId: string | null | undefined,
): Promise<ActivityLaunchSelection> {
  if (selection.target.option.kind === 'lobby') {
    const record = await resolveAuthoritativeSessionRecord(sessionNamespace, selection.target.session)
    const session = record ? buildDirectoryEntryFromRecord(record) : selection.target.session
    const authoritativeOption = record ? buildActivityOverviewOptionsFromSessionRecord(record)[0] : null
    const option = authoritativeOption
      ? {
          ...authoritativeOption,
          isMember: authoritativeOption.memberPlayerIds.includes(userId),
          isHost: authoritativeOption.hostId === userId,
        }
      : selection.target.option
    const lobbySnapshot = record
      ? await buildLobbySnapshotFromSessionRecord(kv, record, selection.target.balanceSnapshot, selection.target.rankAssignments, { legacyGuildId })
      : await buildLobbySnapshotFromDirectoryEntry(kv, selection.target.session, selection.target.balanceSnapshot, selection.target.rankAssignments, { legacyGuildId })
    const tournamentLobby = db ? await attachTournamentLobbySnapshot(createDb(db), lobbySnapshot) : lobbySnapshot
    const lobby = await attachRepeatDraftSnapshot(tournamentLobby, sessionNamespace, selection.target.session.sessionId)
    return {
      kind: 'lobby',
      option,
      pendingJoin: selection.pendingJoin,
      joinEligibility: await resolveSessionJoinEligibility(kv, userId, session, lobby, context.targets, db),
      lobby,
    }
  }

  return {
    kind: 'match',
    option: selection.target.option,
    matchId: selection.target.option.id,
    steamLobbyLink: selection.target.session.steamLobbyLink,
    sessionAccessToken: await issueSessionAccessToken(activitySecret, userId, selection.target.session.sessionId, selection.target.option.channelId),
    lobbyId: selection.target.session.sessionId,
    mode: selection.target.session.mode,
  }
}

async function attachRepeatDraftSnapshot(
  snapshot: LobbySnapshot,
  sessionNamespace: DurableObjectNamespace | null | undefined,
  sessionId: string,
): Promise<LobbySnapshot> {
  const repeatDraft = await getSessionRepeatDraftAvailability(sessionNamespace, sessionId).catch((error) => {
    console.warn('[activity] failed to attach repeat draft snapshot', { sessionId }, error)
    return null
  })
  return repeatDraft ? { ...snapshot, repeatDraft } : snapshot
}

export async function resolveLobbyJoinEligibility(
  token: string | undefined,
  kv: KVNamespace,
  userId: string,
  lobby: LobbyState,
  lobbySnapshot: Awaited<ReturnType<typeof buildOpenLobbySnapshot>>,
  options?: {
    db?: D1Database | null
  },
): Promise<LobbyJoinEligibility> {
  void token
  void kv
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

  if (lobby.draftConfig.closed === true) {
    return {
      canJoin: false,
      blockedReason: 'This lobby is closed.',
      pendingSlot: null,
    }
  }

  const otherCurrentLobbies = options?.db
    ? await getCurrentLobbyProjectionsForJoin(options.db, userId, lobby.id)
    : []
  const blockingDraftMatchIds = await findPersistedBlockingDraftMatchIdsForPlayers(options?.db, [userId])
  const hasLiveMatch = otherCurrentLobbies.some(candidate => candidate.status !== 'open')
    || blockingDraftMatchIds?.has(userId) === true
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
            : `You're already in a ${formatModeLabel(blockingLobby.mode, blockingLobby.mode, { redDeath: blockingLobby.draftConfig.redDeath, civBlitz: blockingLobby.draftConfig.civBlitz })} lobby.`
        : 'You are already in a live match.',
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

async function getCurrentLobbyProjectionsForJoin(
  db: D1Database,
  userId: string,
  excludedLobbyId: string,
) {
  try {
    return await getCurrentSessionLobbyProjectionsForPlayer(createDb(db), userId, { excludeLobbyIds: [excludedLobbyId] })
  }
  catch {
    return []
  }
}

async function resolveSessionJoinEligibility(
  kv: KVNamespace,
  userId: string,
  session: ActivitySessionDirectoryEntry,
  lobbySnapshot: LobbySnapshot,
  targets: readonly ChannelActivityTarget[],
  db: D1Database | null | undefined,
): Promise<LobbyJoinEligibility> {
  const memberIds = session.roster.participants.map(member => member.playerId)
  if (memberIds.includes(userId) || lobbySnapshot.entries.some(entry => entry?.playerId === userId)) {
    return {
      canJoin: true,
      blockedReason: null,
      pendingSlot: null,
    }
  }

  if (session.phase !== 'open') {
    return {
      canJoin: false,
      blockedReason: 'This lobby is no longer open.',
      pendingSlot: null,
    }
  }

  if (session.config.closed === true) {
    return {
      canJoin: false,
      blockedReason: 'This lobby is closed.',
      pendingSlot: null,
    }
  }

  const liveSessions = db ? await getOpenActivitySessionsForUser(createDb(db), userId) : []
  const blockingDraft = liveSessions.find(candidate => candidate.sessionId !== session.sessionId && (candidate.phase === 'draft' || candidate.phase === 'swap'))
  if (blockingDraft || targets.some(target => target.option.kind === 'match' && target.session.phase !== 'active' && target.option.id !== session.sessionId && (target.option.isHost || target.option.isMember))) {
    return {
      canJoin: false,
      blockedReason: 'You are already in a live match.',
      pendingSlot: null,
    }
  }

  const blockingLobby = liveSessions.find(candidate => candidate.sessionId !== session.sessionId && candidate.phase === 'open') ?? null
  if (blockingLobby) {
    const hasOtherMembers = blockingLobby.roster.participants.some(member => member.playerId !== userId)
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

    return {
      canJoin: false,
      blockedReason: blockingLobby.hostId === userId && blockingLobby.roster.participants.some(member => member.playerId !== userId)
        ? 'You are hosting another open lobby with other players. Cancel it first.'
        : blockingLobby.mode === session.mode
          ? 'You are already in another open lobby.'
          : `You're already in a ${formatModeLabel(blockingLobby.mode, blockingLobby.mode, { redDeath: blockingLobby.config.redDeath, civBlitz: blockingLobby.config.civBlitz })} lobby.`,
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

async function resolveAuthoritativeSessionRecord(
  namespace: DurableObjectNamespace | null | undefined,
  session: ActivitySessionDirectoryEntry,
): Promise<SessionRecord | null> {
  if (!namespace) return null
  const record = await getSessionRecord(namespace, session.sessionId)
  if (!record) return null
  if (record.id !== session.sessionId) return null
  return record
}

async function loadActivityLaunchContext(
  kv: KVNamespace,
  channelId: string,
  userId: string,
  db: D1Database | null | undefined,
  guildIds: readonly string[] = [],
): Promise<ActivityLaunchContext> {
  if (!db) return { targets: [] }

  const channelSessions = await getActivitySessionsForFeed(createDb(db), { guildIds })
  const launchState = await loadActivityLaunchState(kv, channelSessions)
  const targets: ChannelActivityTarget[] = []

  for (const session of channelSessions) {
    const option = buildActivityOverviewOptions(session)[0]
    if (!option) continue
    const isMember = option.memberPlayerIds.includes(userId)
    const isHost = option.hostId === userId

    targets.push({
      session,
      balanceSnapshot: resolveSessionBalanceSnapshot(launchState.balanceSnapshots, session),
      rankAssignments: resolveSessionRankAssignments(launchState.rankAssignmentsByGuildId, session),
      option: {
        ...option,
        isMember,
        isHost,
      },
    })
  }

  return {
    targets: targets.sort(compareActivityTargets),
  }
}

function isApprovedActivitySession(env: Env['Bindings'], session: Pick<ActivitySessionDirectoryEntry, 'guildId'>): boolean {
  const config = resolveApprovedDiscordGuildConfiguration(env)
  return config.ok && session.guildId != null && config.guildIds.includes(session.guildId)
}

async function getBrowserContextConfigurationError(env: Env['Bindings'], guildId: string | null): Promise<string | null> {
  const state = await getBrowserAccessState(env.KV, { guildId, legacyGuildId: env.ALLOWED_DISCORD_GUILD_ID })
  if (!state.enabled) return 'Browser access is disabled'
  if (!normalizePublicOrigin(env.ACTIVITY_PUBLIC_ORIGIN) || !resolveApprovedDiscordGuildConfiguration(env).ok) return 'Browser access is not configured'
  return null
}

function buildDirectoryEntryFromRecord(record: SessionRecord): ActivitySessionDirectoryEntry {
  return {
    sessionId: record.id,
    phase: record.phase,
    mode: record.mode,
    guildId: record.guildId,
    channelId: record.projectionState.channelId,
    hostId: record.hostId,
    messageId: record.projectionState.messageId,
    matchId: record.matchId,
    steamLobbyLink: record.projectionState.steamLobbyLink,
    version: record.version,
    roster: record.roster,
    config: record.config,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastActivityAt: record.lastActivityAt,
    closedAt: record.closedAt,
  }
}

async function loadActivityLaunchState(
  kv: KVNamespace,
  channelSessions: ActivitySessionDirectoryEntry[],
): Promise<ActivityLaunchState> {
  const requestedBalanceModes = [...new Set(
    channelSessions
      .filter(session => session.phase === 'open')
      .map(session => toBalanceLeaderboardMode(session.mode, { redDeath: session.config.redDeath, civBlitz: session.config.civBlitz }))
      .filter((mode): mode is NonNullable<ReturnType<typeof toBalanceLeaderboardMode>> => mode != null),
  )]
  const requestedGuildIds = [...new Set(channelSessions
    .filter(session => session.phase === 'open')
    .filter(session => !session.config.redDeath)
    .map(session => session.guildId)
    .filter((guildId): guildId is string => typeof guildId === 'string' && guildId.length > 0))]
  const rankAssignmentsByGuildId = new Map<string, RankedRoleAssignments>()
  const uncachedGuildIds = requestedGuildIds.filter((guildId) => {
    const cached = getCachedCurrentRankAssignments(kv, guildId)
    if (!cached) return true
    rankAssignmentsByGuildId.set(guildId, cached)
    return false
  })

  if (requestedBalanceModes.length === 0 && uncachedGuildIds.length === 0) {
    return { balanceSnapshots: new Map(), rankAssignmentsByGuildId }
  }

  const rawState = await kvMget(kv, [
    ...requestedBalanceModes.map(mode => ({ key: leaderboardModeSnapshotKey(mode), type: 'json' as const })),
    ...uncachedGuildIds.map(guildId => ({ key: currentRankAssignmentsKey(guildId), type: 'json' as const })),
  ])

  const balanceSnapshots = new Map<string, LeaderboardModeSnapshot>()
  for (let index = 0; index < requestedBalanceModes.length; index++) {
    const mode = requestedBalanceModes[index]
    if (!mode) continue
    const snapshot = normalizeLeaderboardModeSnapshot(mode, rawState[index])
    if (!snapshot) continue
    balanceSnapshots.set(mode, snapshot)
  }

  const assignmentsOffset = requestedBalanceModes.length
  for (let index = 0; index < uncachedGuildIds.length; index++) {
    const guildId = uncachedGuildIds[index]
    if (!guildId) continue

    const assignments = normalizeRankedRoleAssignments(rawState[assignmentsOffset + index])
    cacheCurrentRankAssignments(kv, guildId, assignments)
    rankAssignmentsByGuildId.set(guildId, assignments)
  }

  return { balanceSnapshots, rankAssignmentsByGuildId }
}

function resolveSessionBalanceSnapshot(
  balanceSnapshots: ReadonlyMap<string, LeaderboardModeSnapshot>,
  session: ActivitySessionDirectoryEntry,
): LeaderboardModeSnapshot | null {
  const mode = toBalanceLeaderboardMode(session.mode, { redDeath: session.config.redDeath, civBlitz: session.config.civBlitz })
  if (!mode) return null
  return balanceSnapshots.get(mode) ?? null
}

function resolveSessionRankAssignments(
  rankAssignmentsByGuildId: ReadonlyMap<string, RankedRoleAssignments>,
  session: ActivitySessionDirectoryEntry,
): RankedRoleAssignments | null {
  return session.guildId ? rankAssignmentsByGuildId.get(session.guildId) ?? null : null
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

function pickActivityLaunchSelectionForTarget(targets: ChannelActivityTarget[], requestedTarget: ActivityTargetSelection | null): ResolvedActivitySelection | null {
  if (!requestedTarget) return null
  const target = targets.find(candidate => candidate.option.kind === requestedTarget.kind && candidate.option.id === requestedTarget.id)
    ?? findLifecycleSuccessorTarget(targets, requestedTarget)
    ?? null
  return target ? { target, pendingJoin: false } : null
}

function findLifecycleSuccessorTarget(targets: ChannelActivityTarget[], requestedTarget: ActivityTargetSelection): ChannelActivityTarget | null {
  if (requestedTarget.kind === 'lobby') {
    return targets.find(candidate => candidate.option.kind === 'match' && candidate.option.lobbyId === requestedTarget.id) ?? null
  }

  return targets.find(candidate => candidate.option.kind === 'lobby' && (candidate.option.id === requestedTarget.id || candidate.option.lobbyId === requestedTarget.id || candidate.option.matchId === requestedTarget.id)) ?? null
}

function pickCurrentActivityMembershipTarget(targets: ChannelActivityTarget[]): ChannelActivityTarget | null {
  return targets.find(target => (target.option.isHost || target.option.isMember) && target.option.kind === 'match' && (target.session.phase === 'draft' || target.session.phase === 'swap'))
    ?? targets.find(target => (target.option.isHost || target.option.isMember) && target.option.kind === 'lobby')
    ?? null
}

async function issueSessionAccessToken(
  activitySecret: string | undefined,
  userId: string,
  sessionId: string,
  channelId: string,
): Promise<string | null> {
  const secret = activitySecret?.trim() ?? ''
  if (secret.length === 0) return null
  return createSessionAccessToken(secret, {
    userId,
    sessionId,
    channelId,
  })
}
