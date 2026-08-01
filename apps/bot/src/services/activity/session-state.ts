import type { Database } from '@civup/db'
import type { AppliedCivLobbySettings, CompetitiveTier, GameMode, LeaderboardMode } from '@civup/game'
import type { SessionConfig, SessionPhase, SessionRecord, SessionRoster } from '../../session-runtime/session-record.ts'
import type { LeaderboardModeSnapshot } from '../leaderboard/snapshot.ts'
import type { LobbyArrangeMarker } from '../lobby/types.ts'
import type { RankedRoleAssignments } from '../ranked/role-sync.ts'
import type { TournamentLobbySnapshot } from '../tournament/index.ts'
import type { StatsContext } from '../stats/context.ts'
import { matches, sessionDirectory, sessionDirectoryMembers } from '@civup/db'
import { GAME_MODES, normalizeAppliedCivLobbySettings, slotToTeamIndex, startPlayerCountOptions, toBalanceLeaderboardMode } from '@civup/game'
import {
  buildActivityAdjustedLeaderboard,
  getLeaderboardMinGames,
  getNextLeaderboardInactivityAdjustmentAt,
  LEADERBOARD_ACTIVITY_TOP_RANK_LIMIT,
} from '@civup/rating'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { getServerDraftTimerDefaults } from '../config/index.ts'
import { getStoredLeaderboardModeSnapshot } from '../leaderboard/snapshot.ts'
import { buildLobbyRankSnapshot } from '../lobby/rank.ts'
import { getCurrentRankAssignments } from '../ranked/role-sync.ts'
import { buildTournamentLobbySnapshot } from '../tournament/index.ts'
import { STALE_ACTIVE_MATCH_TIMEOUT_MS } from '../match/retention.ts'
import { createStatsContext } from '../stats/context.ts'
import { parseStoredSessionDirectoryConfig } from '../../session-runtime/session-record.ts'

const leaderboardRankCache = new WeakMap<LeaderboardModeSnapshot, {
  mode: LeaderboardMode
  evaluatedAt: number
  expiresAt: number | null
  rankByPlayerId: Map<string, number>
}>()

export interface ActivityOverviewOptionSnapshot {
  kind: 'lobby' | 'match'
  id: string
  lobbyId: string
  matchId: string | null
  channelId: string
  originGuildId: string
  mode: GameMode
  status: 'open' | 'closed' | 'drafting' | 'completed'
  reported?: boolean
  starting?: boolean
  participantCount: number
  targetSize: number
  redDeath: boolean
  civBlitz: boolean
  hostId: string
  memberPlayerIds: string[]
  players?: ActivityOverviewPlayerSnapshot[]
  updatedAt: number
}

export interface ActivityOverviewPlayerSnapshot {
  playerId: string
  displayName: string
  avatarUrl?: string | null
  team?: number | null
  sourceGuild?: { id: string, name?: string | null, iconUrl?: string | null }
}

export interface ActivityOverviewSnapshot {
  channelId: string
  options: ActivityOverviewOptionSnapshot[]
  supportedServers: ActivitySupportedServerSnapshot[]
}

export interface ActivitySupportedServerSnapshot {
  id: string
  name: string | null
  iconUrl: string | null
}

export interface LobbySnapshot {
  id: string
  originGuildId: string | null
  revision: number
  mode: string
  hostId: string
  status: string
  steamLobbyLink: string | null
  minRole: SessionConfig['minRole']
  maxRole: SessionConfig['maxRole']
  lobbyRank?: {
    tier: CompetitiveTier
    leaderPoolSize: number | null
  } | null
  lastArrange: LobbyArrangeMarker | null
  memberPlayerIds: string[]
  entries: ({
    playerId: string
    displayName: string
    avatarUrl?: string | null
    sourceGuild?: {
      id: string
      name?: string | null
      iconUrl?: string | null
    }
    balanceRating?: {
      mu: number
      sigma: number
      publicRating: number
      gamesPlayed: number
      wins?: number
      rank?: number | null
    }
    rankedRole?: {
      tier: CompetitiveTier
      sourceMode: LeaderboardMode | null
    } | null
  } | null)[]
  minPlayers: number
  targetSize: number
  draftConfig: Omit<SessionConfig, 'minRole' | 'maxRole'>
  gameSettings: AppliedCivLobbySettings
  tournament?: TournamentLobbySnapshot | null
  repeatDraft?: RepeatDraftSnapshot | null
  serverDefaults: {
    banTimerSeconds: number | null
    pickTimerSeconds: number | null
  }
}

export interface RepeatDraftSnapshot {
  kind: 'resume' | 'complete'
  matchId: string
}

export interface ActivitySessionDirectoryEntry {
  sessionId: string
  phase: SessionPhase
  mode: GameMode
  guildId: string | null
  channelId: string
  hostId: string
  messageId: string
  matchId: string | null
  steamLobbyLink: string | null
  version: number
  roster: SessionRoster
  config: SessionConfig
  gameSettings: AppliedCivLobbySettings
  createdAt: number
  updatedAt: number
  lastActivityAt: number
  closedAt: number | null
  draftStartDeadlineAt: number | null
}

type ActivityDirectoryRow = typeof sessionDirectory.$inferSelect

const ACTIVITY_DIRECTORY_PHASES = ['open', 'draft', 'swap', 'active'] as const
const ACTIVITY_TARGET_PHASES = ['open', 'draft', 'swap', 'active', 'reported'] as const
const LIVE_ACTIVITY_OVERVIEW_STATUSES = new Set<string>(['open', 'closed', 'drafting', 'completed', 'active'])

export async function buildActivityOverviewSnapshotFromDirectory(
  db: Database,
  channelId: string,
  options: { guildId?: string | null, guildIds?: readonly string[], sharedFeed?: boolean, supportedServers?: ActivitySupportedServerSnapshot[] } = {},
): Promise<ActivityOverviewSnapshot> {
  const sessions = options.sharedFeed
    ? await getActivitySessionsForFeed(db, { guildIds: options.guildIds })
    : await getActivitySessionsByChannel(db, channelId, options)
  const snapshotOptions = sessions
    .flatMap(session => buildActivityOverviewOptions(session))
    .sort(compareActivityOverviewOptions)

  return { channelId, options: snapshotOptions, supportedServers: options.supportedServers ?? [] }
}

export function mergeActivityOverviewSnapshotForSessionUpdate(
  current: ActivityOverviewSnapshot | null,
  record: SessionRecord,
): ActivityOverviewSnapshot | null {
  const channelId = current?.channelId ?? record.projectionState.channelId
  const options = [
    ...((current?.options ?? [])
      .filter(option => option.lobbyId !== record.id && LIVE_ACTIVITY_OVERVIEW_STATUSES.has(option.status))),
    ...(isLiveActivityOverviewPhase(record.phase) ? buildActivityOverviewOptionsFromSessionRecord(record) : []),
  ].sort(compareActivityOverviewOptions)

  return { channelId, options, supportedServers: current?.supportedServers ?? [] }
}

export async function getActivitySessionsByChannel(
  db: Database,
  channelId: string,
  options: { guildId?: string | null } = {},
): Promise<ActivitySessionDirectoryEntry[]> {
  const rowsByPhase = await Promise.all(ACTIVITY_DIRECTORY_PHASES.map((phase) => {
    const conditions = [eq(sessionDirectory.channelId, channelId), eq(sessionDirectory.phase, phase)]
    if (options.guildId) conditions.push(eq(sessionDirectory.guildId, options.guildId))
    return db.select().from(sessionDirectory).where(and(...conditions)).orderBy(desc(sessionDirectory.updatedAt))
  }))

  const rows = await filterDiscoverableDirectoryRows(db, rowsByPhase.flat().sort(compareActivityDirectoryRowsByUpdatedAtDesc))

  return rows.flatMap(parseActivitySessionDirectoryEntry)
}

export async function getActivitySessionsForFeed(
  db: Database,
  options: { guildIds?: readonly string[] } = {},
): Promise<ActivitySessionDirectoryEntry[]> {
  const guildIds = [...new Set(options.guildIds?.filter(Boolean) ?? [])]
  const rowsByPhase = await Promise.all(ACTIVITY_DIRECTORY_PHASES.map((phase) => {
    const conditions = [eq(sessionDirectory.phase, phase)]
    if (guildIds.length > 0) conditions.push(inArray(sessionDirectory.guildId, guildIds))
    return db.select().from(sessionDirectory).where(and(...conditions)).orderBy(desc(sessionDirectory.updatedAt))
  }))
  const rows = await filterDiscoverableDirectoryRows(db, rowsByPhase.flat().sort(compareActivityDirectoryRowsByUpdatedAtDesc))
  return rows.flatMap(parseActivitySessionDirectoryEntry)
}

function compareActivityDirectoryRowsByUpdatedAtDesc(left: ActivityDirectoryRow, right: ActivityDirectoryRow): number {
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
  return left.sessionId.localeCompare(right.sessionId)
}

function isLiveActivityOverviewPhase(phase: SessionRecord['phase']): boolean {
  return phase === 'open' || phase === 'draft' || phase === 'swap' || phase === 'active'
}

export async function getActivitySessionById(
  db: Database,
  sessionId: string,
): Promise<ActivitySessionDirectoryEntry | null> {
  const [row] = await db.select().from(sessionDirectory).where(and(
    eq(sessionDirectory.sessionId, sessionId),
    inArray(sessionDirectory.phase, [...ACTIVITY_TARGET_PHASES]),
  )).limit(1)

  if (!row) return null
  const [discoverable] = await filterDiscoverableDirectoryRows(db, [row])
  return discoverable ? parseActivitySessionDirectoryEntry(discoverable)[0] ?? null : null
}

export async function getActivitySessionByStableId(
  db: Database,
  sessionId: string,
): Promise<ActivitySessionDirectoryEntry | null> {
  const [row] = await db.select().from(sessionDirectory).where(eq(sessionDirectory.sessionId, sessionId)).limit(1)
  return row ? parseActivitySessionDirectoryEntry(row)[0] ?? null : null
}

export async function getOpenActivitySessionsForUser(
  db: Database,
  playerId: string,
): Promise<ActivitySessionDirectoryEntry[]> {
  const rows = await db.select({ session: sessionDirectory })
    .from(sessionDirectoryMembers)
    .innerJoin(sessionDirectory, eq(sessionDirectory.sessionId, sessionDirectoryMembers.sessionId))
    .where(and(
      eq(sessionDirectoryMembers.playerId, playerId),
      isNull(sessionDirectoryMembers.leftAt),
      inArray(sessionDirectory.phase, ['open', 'draft', 'swap', 'active']),
    ))
    .orderBy(desc(sessionDirectory.updatedAt))

  const discoverable = await filterDiscoverableDirectoryRows(db, rows.map(row => row.session))
  return discoverable.flatMap(parseActivitySessionDirectoryEntry)
}

export function buildActivityOverviewOptions(session: ActivitySessionDirectoryEntry): ActivityOverviewOptionSnapshot[] {
  if (!session.guildId) return []
  const status = mapSessionPhaseToActivityStatus(session.phase, session.config.closed === true)
  if (!status) return []
  const matchId = session.phase === 'open' ? null : session.matchId
  if (session.phase !== 'open' && !matchId && !(session.phase === 'draft' && session.draftStartDeadlineAt && session.draftStartDeadlineAt > Date.now())) return []
  const id = session.phase === 'open' ? session.sessionId : matchId ?? session.sessionId

  return [{
    kind: session.phase === 'open' ? 'lobby' : 'match',
    id,
    lobbyId: session.sessionId,
    matchId,
    channelId: session.channelId,
    originGuildId: session.guildId,
    mode: session.mode,
    status,
    reported: session.phase === 'reported',
    starting: session.phase === 'draft' && session.draftStartDeadlineAt != null && session.draftStartDeadlineAt > Date.now(),
    participantCount: countFilledSlots(session.roster.slots),
    targetSize: session.roster.slots.length,
    redDeath: session.config.redDeath,
    civBlitz: session.config.civBlitz,
    hostId: session.hostId,
    memberPlayerIds: session.roster.participants.map(member => member.playerId),
    players: buildActivityOverviewPlayers(session.mode, session.roster),
    updatedAt: session.updatedAt,
  }]
}

export function buildActivityOverviewOptionsFromSessionRecord(record: SessionRecord): ActivityOverviewOptionSnapshot[] {
  if (!record.guildId) return []
  const status = mapSessionPhaseToActivityStatus(record.phase, record.config.closed === true)
  if (!status) return []

  const matchId = record.phase === 'open' ? null : record.matchId ?? record.id
  const id = record.phase === 'open' ? record.id : matchId ?? record.id
  return [{
    kind: record.phase === 'open' ? 'lobby' : 'match',
    id,
    lobbyId: record.id,
    matchId,
    channelId: record.projectionState.channelId,
    originGuildId: record.guildId,
    mode: record.mode,
    status,
    reported: record.phase === 'reported',
    starting: record.phase === 'draft' && record.draftStartSync != null,
    participantCount: countFilledSlots(record.roster.slots),
    targetSize: record.roster.slots.length,
    redDeath: record.config.redDeath,
    civBlitz: record.config.civBlitz,
    hostId: record.hostId,
    memberPlayerIds: record.roster.participants.map(member => member.playerId),
    players: buildActivityOverviewPlayers(record.mode, record.roster),
    updatedAt: record.updatedAt,
  }]
}

function buildActivityOverviewPlayers(mode: GameMode, roster: SessionRoster): ActivityOverviewPlayerSnapshot[] {
  const memberByPlayerId = new Map(roster.participants.map(member => [member.playerId, member]))
  const players: ActivityOverviewPlayerSnapshot[] = []
  const seen = new Set<string>()

  for (let slotIndex = 0; slotIndex < roster.slots.length; slotIndex += 1) {
    const playerId = roster.slots[slotIndex]
    if (!playerId || seen.has(playerId)) continue
    const member = memberByPlayerId.get(playerId)
    seen.add(playerId)
    players.push({
      playerId,
      displayName: member?.displayName ?? playerId,
      avatarUrl: member?.avatarUrl ?? null,
      ...(member?.sourceGuild ? { sourceGuild: member.sourceGuild } : {}),
      team: slotToTeamIndex(mode, slotIndex, roster.slots.length),
    })
  }

  for (const member of roster.participants) {
    if (seen.has(member.playerId)) continue
    seen.add(member.playerId)
    players.push({
      playerId: member.playerId,
      displayName: member.displayName ?? member.playerId,
      avatarUrl: member.avatarUrl ?? null,
      ...(member.sourceGuild ? { sourceGuild: member.sourceGuild } : {}),
      team: null,
    })
  }

  return players
}

export async function buildLobbySnapshotFromSessionRecord(
  kv: KVNamespace,
  record: SessionRecord,
  balanceSnapshot?: LeaderboardModeSnapshot | null,
  rankAssignments?: RankedRoleAssignments | null,
  options: { legacyGuildId?: string | null, lobbyRankAssignments?: RankedRoleAssignments | null } = {},
): Promise<LobbySnapshot> {
  return attachLobbyBalanceRatingsToSnapshot(
    kv,
    record.mode,
    await buildLobbySnapshotFromSessionParts(kv, {
      id: record.id,
      version: record.version,
      mode: record.mode,
      guildId: record.guildId,
      hostId: record.hostId,
      phase: record.phase,
      steamLobbyLink: record.projectionState.steamLobbyLink,
      minRole: record.config.minRole,
      maxRole: record.config.maxRole,
      lastArrange: record.lastArrange,
      roster: record.roster,
      config: record.config,
      gameSettings: record.gameSettings,
    }, rankAssignments, options),
    balanceSnapshot,
    createOptionalStatsContext(record.guildId, options.legacyGuildId),
  )
}

export async function buildLobbySnapshotFromDirectoryEntry(
  kv: KVNamespace,
  session: ActivitySessionDirectoryEntry,
  balanceSnapshot?: LeaderboardModeSnapshot | null,
  rankAssignments?: RankedRoleAssignments | null,
  options: { legacyGuildId?: string | null, lobbyRankAssignments?: RankedRoleAssignments | null } = {},
): Promise<LobbySnapshot> {
  return attachLobbyBalanceRatingsToSnapshot(
    kv,
    session.mode,
    await buildLobbySnapshotFromSessionParts(kv, {
      id: session.sessionId,
      version: session.version,
      mode: session.mode,
      guildId: session.guildId,
      hostId: session.hostId,
      phase: session.phase,
      steamLobbyLink: session.steamLobbyLink,
      minRole: session.config.minRole,
      maxRole: session.config.maxRole,
      lastArrange: null,
      roster: session.roster,
      config: session.config,
      gameSettings: session.gameSettings,
    }, rankAssignments, options),
    balanceSnapshot,
    createOptionalStatsContext(session.guildId, options.legacyGuildId),
  )
}

export async function attachLobbyBalanceRatingsToSnapshot(
  kv: KVNamespace,
  mode: GameMode,
  snapshot: LobbySnapshot,
  balanceSnapshot?: LeaderboardModeSnapshot | null,
  statsContext?: StatsContext | null,
): Promise<LobbySnapshot> {
  const leaderboardMode = toBalanceLeaderboardMode(mode, { redDeath: snapshot.draftConfig.redDeath, civBlitz: snapshot.draftConfig.civBlitz })
  if (!leaderboardMode) return snapshot

  const leaderboardSnapshot = balanceSnapshot === undefined
    ? statsContext ? await getStoredLeaderboardModeSnapshot(kv, statsContext, leaderboardMode) : null
    : balanceSnapshot
  if (!leaderboardSnapshot) return snapshot

  const rankByPlayerId = getLeaderboardRankByPlayer(leaderboardSnapshot, leaderboardMode)
  const balanceRatingByPlayerId = new Map(leaderboardSnapshot.rows.map(row => [
    row.playerId,
    {
      mu: row.mu,
      sigma: row.sigma,
      publicRating: row.publicRating,
      gamesPlayed: row.gamesPlayed,
      wins: row.wins,
      rank: rankByPlayerId.get(row.playerId) ?? null,
    },
  ]))

  let hasAttachedRatings = false
  const entries = snapshot.entries.map((entry) => {
    if (!entry) return null

    const balanceRating = balanceRatingByPlayerId.get(entry.playerId)
    if (!balanceRating) return entry

    hasAttachedRatings = true
    return {
      ...entry,
      balanceRating,
    }
  })

  if (!hasAttachedRatings) return snapshot
  return {
    ...snapshot,
    entries,
  }
}

function createOptionalStatsContext(guildId: string | null, primaryGuildId: string | null | undefined): StatsContext | null {
  if (!guildId || !primaryGuildId) return null
  try {
    return createStatsContext(guildId, primaryGuildId)
  }
  catch {
    return null
  }
}

export function getLeaderboardRankByPlayer(
  snapshot: LeaderboardModeSnapshot,
  mode: LeaderboardMode,
  now = Date.now(),
): Map<string, number> {
  const cached = leaderboardRankCache.get(snapshot)
  if (
    cached?.mode === mode
    && now >= cached.evaluatedAt
    && (cached.expiresAt == null || now < cached.expiresAt)
  ) return cached.rankByPlayerId

  const ranked = buildActivityAdjustedLeaderboard(snapshot.rows, getLeaderboardMinGames(mode), now)
  const rankByPlayerId = new Map(ranked.map(row => [row.playerId, row.rank]))
  const nextAdjustments = ranked
    .filter(row => row.rawRank <= LEADERBOARD_ACTIVITY_TOP_RANK_LIMIT)
    .map(row => getNextLeaderboardInactivityAdjustmentAt(row.lastPlayedAt, now))
    .filter((expiresAt): expiresAt is number => expiresAt != null)
  const expiresAt = nextAdjustments.length > 0 ? Math.min(...nextAdjustments) : null

  leaderboardRankCache.set(snapshot, { mode, evaluatedAt: now, expiresAt, rankByPlayerId })
  return rankByPlayerId
}

export async function attachTournamentLobbySnapshot(db: Database, snapshot: LobbySnapshot): Promise<LobbySnapshot> {
  const tournament = await buildTournamentLobbySnapshot(db, snapshot.id, snapshot.memberPlayerIds)
  if (!tournament && snapshot.tournament == null) return snapshot
  return { ...snapshot, tournament }
}

function parseActivitySessionDirectoryEntry(row: ActivityDirectoryRow): ActivitySessionDirectoryEntry[] {
  if (!isActivitySessionPhase(row.phase) || !isGameMode(row.mode)) return []
  const roster = parseSessionRoster(row.rosterJson)
  const storedConfig = parseStoredSessionDirectoryConfig(row.configJson, row.mode)
  if (!roster || !storedConfig) return []

  return [{
    sessionId: row.sessionId,
    phase: row.phase,
    mode: row.mode,
    guildId: row.guildId,
    channelId: row.channelId,
    hostId: row.hostId,
    messageId: row.messageId,
    matchId: row.matchId,
    steamLobbyLink: row.steamLobbyLink,
    version: row.version,
    roster,
    config: storedConfig.config,
    gameSettings: storedConfig.gameSettings,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastActivityAt: row.lastActivityAt,
    closedAt: row.closedAt,
    draftStartDeadlineAt: row.draftStartDeadlineAt,
  }]
}

async function filterDiscoverableDirectoryRows(db: Database, rows: ActivityDirectoryRow[], now = Date.now()): Promise<ActivityDirectoryRow[]> {
  const matchIds = [...new Set(rows.flatMap(row => row.matchId ? [row.matchId] : []))]
  const matchRows = matchIds.length > 0
    ? await db.select({
        id: matches.id,
        status: matches.status,
        createdAt: matches.createdAt,
        draftCompletedAt: matches.draftCompletedAt,
      }).from(matches).where(inArray(matches.id, matchIds))
    : []
  const matchById = new Map(matchRows.map(row => [row.id, row]))
  const staleActiveCutoff = now - STALE_ACTIVE_MATCH_TIMEOUT_MS

  return rows.filter((row) => {
    if (row.phase === 'open') return true
    if (!row.matchId) return row.phase === 'draft' && row.draftStartDeadlineAt != null && row.draftStartDeadlineAt > now
    const match = matchById.get(row.matchId)
    if (!match) return row.phase === 'draft' && row.draftStartDeadlineAt != null && row.draftStartDeadlineAt > now
    if (match.status === 'completed' || match.status === 'cancelled') return false
    if (row.phase === 'draft') return match.status === 'drafting' || match.status === 'active'
    if (match.status !== 'active') return false
    return (match.draftCompletedAt ?? match.createdAt) >= staleActiveCutoff
  })
}

async function buildLobbySnapshotFromSessionParts(
  kv: KVNamespace,
  session: {
    id: string
    version: number
    mode: GameMode
    guildId: string | null
    hostId: string
    phase: SessionPhase
    steamLobbyLink: string | null
    minRole: SessionConfig['minRole']
    maxRole: SessionConfig['maxRole']
    lastArrange: LobbyArrangeMarker | null
    roster: SessionRoster
    config: SessionConfig
    gameSettings: AppliedCivLobbySettings
  },
  rankAssignments?: RankedRoleAssignments | null,
  options: { legacyGuildId?: string | null, lobbyRankAssignments?: RankedRoleAssignments | null } = {},
): Promise<LobbySnapshot> {
  const serverDefaults = await getServerDraftTimerDefaults(kv, { guildId: session.guildId, legacyGuildId: options.legacyGuildId })
  const resolvedRankAssignments = rankAssignments === undefined && session.guildId && !session.config.redDeath && !session.config.civBlitz
    ? await getCurrentRankAssignments(kv, session.guildId)
    : rankAssignments ?? null
  const memberByPlayerId = new Map(session.roster.participants.map(member => [member.playerId, member]))
  const memberPlayerIds = session.roster.participants.map(member => member.playerId)
  const entries = session.roster.slots.map((playerId) => {
    if (!playerId) return null
    const member = memberByPlayerId.get(playerId)
    if (!member) return null
    const rankedRole = resolvedRankAssignments?.byPlayerId[playerId] ?? null
    return {
      playerId,
      displayName: member.displayName ?? playerId,
      avatarUrl: member.avatarUrl ?? null,
      ...(member.sourceGuild ? { sourceGuild: member.sourceGuild } : {}),
      rankedRole: rankedRole
        ? { tier: rankedRole.tier, sourceMode: rankedRole.sourceMode }
        : null,
    }
  })
  const targetSize = session.roster.slots.length
  const slottedPlayerIds = session.roster.slots.filter((playerId): playerId is string => playerId != null)
  const lobbyRank = await buildLobbyRankSnapshot(kv, session.guildId, slottedPlayerIds, {
    mode: session.mode,
    playerCount: slottedPlayerIds.length,
    leaderDataVersion: session.config.leaderDataVersion,
    redDeath: session.config.redDeath,
    civBlitz: session.config.civBlitz,
    assignments: options.lobbyRankAssignments === undefined ? resolvedRankAssignments : options.lobbyRankAssignments,
  })

  return {
    id: session.id,
    originGuildId: session.guildId,
    revision: session.version,
    mode: session.mode,
    hostId: session.hostId,
    status: mapSessionPhaseToLobbySnapshotStatus(session.phase),
    steamLobbyLink: session.steamLobbyLink,
    minRole: session.minRole,
    maxRole: session.maxRole,
    lobbyRank,
    lastArrange: session.lastArrange,
    memberPlayerIds,
    entries,
    minPlayers: startPlayerCountOptions(session.mode, targetSize, { redDeath: session.config.redDeath, permanentAlly: session.config.permanentAlly })[0] ?? targetSize,
    targetSize,
    draftConfig: {
      banTimerSeconds: session.config.banTimerSeconds,
      pickTimerSeconds: session.config.pickTimerSeconds,
      leaderPoolSize: session.config.leaderPoolSize,
      leaderDataVersion: session.config.leaderDataVersion,
      mapVoteEnabled: session.config.mapVoteEnabled,
      teamFormationEnabled: session.config.teamFormationEnabled === true,
      blindBans: session.config.blindBans,
      blindPicks: session.config.blindPicks,
      simultaneousPick: session.config.simultaneousPick,
      permanentAlly: session.config.permanentAlly,
      redDeath: session.config.redDeath,
      dealOptionsSize: session.config.dealOptionsSize,
      civBlitz: session.config.civBlitz,
      civBlitzOptionCount: session.config.civBlitzOptionCount,
      civBlitzExcludeBbgExpanded: session.config.civBlitzExcludeBbgExpanded,
      randomDraft: session.config.randomDraft,
      hiddenDraft: session.config.hiddenDraft,
      duplicateFactions: session.config.duplicateFactions,
      closed: session.config.closed === true,
    },
    gameSettings: normalizeAppliedCivLobbySettings(session.gameSettings),
    serverDefaults,
  }
}

function parseSessionRoster(raw: string): SessionRoster | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SessionRoster>
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.participants) || !Array.isArray(parsed.slots)) return null
    const participants = parsed.participants.flatMap((candidate) => {
      if (!candidate || typeof candidate !== 'object') return []
      const member = candidate as Partial<SessionRoster['participants'][number]>
      if (typeof member.playerId !== 'string' || member.playerId.length === 0) return []
      return [{
        playerId: member.playerId,
        displayName: typeof member.displayName === 'string' ? member.displayName : null,
        avatarUrl: typeof member.avatarUrl === 'string' ? member.avatarUrl : null,
        ...(parseSourceGuild(member.sourceGuild) ? { sourceGuild: parseSourceGuild(member.sourceGuild)! } : {}),
        joinedAt: typeof member.joinedAt === 'number' ? member.joinedAt : 0,
        ...(Array.isArray(member.partyIds) ? { partyIds: member.partyIds.filter((partyId): partyId is string => typeof partyId === 'string') } : {}),
        slotIndex: typeof member.slotIndex === 'number' ? member.slotIndex : null,
      }]
    })
    return {
      participants,
      slots: parsed.slots.map(slot => typeof slot === 'string' ? slot : null),
    }
  }
  catch {
    return null
  }
}

function parseSourceGuild(value: unknown): NonNullable<SessionRoster['participants'][number]['sourceGuild']> | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as { id?: unknown, name?: unknown, iconUrl?: unknown }
  if (typeof candidate.id !== 'string' || !/^\d{17,20}$/.test(candidate.id)) return null
  return {
    id: candidate.id,
    ...(typeof candidate.name === 'string' && candidate.name.trim() ? { name: candidate.name.trim() } : {}),
    ...(typeof candidate.iconUrl === 'string' && candidate.iconUrl.startsWith('https://') ? { iconUrl: candidate.iconUrl } : {}),
  }
}

export function compareActivityOverviewOptions(left: ActivityOverviewOptionSnapshot, right: ActivityOverviewOptionSnapshot): number {
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
  if (left.mode !== right.mode) return left.mode.localeCompare(right.mode)
  return left.id.localeCompare(right.id)
}

function mapSessionPhaseToActivityStatus(phase: SessionPhase, closed: boolean): ActivityOverviewOptionSnapshot['status'] | null {
  switch (phase) {
    case 'open':
      return closed ? 'closed' : 'open'
    case 'draft':
      return 'drafting'
    case 'swap':
      return 'completed'
    case 'active':
      return 'completed'
    case 'reported':
      return 'completed'
    case 'cancelled':
      return null
  }
}

function mapSessionPhaseToLobbySnapshotStatus(phase: SessionPhase): string {
  switch (phase) {
    case 'open':
      return 'open'
    case 'draft':
      return 'drafting'
    case 'swap':
      return 'active'
    case 'active':
      return 'active'
    case 'reported':
      return 'completed'
    case 'cancelled':
      return 'cancelled'
  }
}

function countFilledSlots(slots: readonly (string | null)[]): number {
  let count = 0
  for (const slot of slots) {
    if (slot != null) count += 1
  }
  return count
}

function isActivitySessionPhase(value: string): value is ActivitySessionDirectoryEntry['phase'] {
  return value === 'open' || value === 'draft' || value === 'swap' || value === 'active' || value === 'reported' || value === 'cancelled'
}

function isGameMode(value: unknown): value is GameMode {
  return typeof value === 'string' && GAME_MODES.includes(value as GameMode)
}
