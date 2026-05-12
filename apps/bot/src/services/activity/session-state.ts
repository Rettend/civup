import type { Database } from '@civup/db'
import type { GameMode } from '@civup/game'
import type { SessionConfig, SessionPhase, SessionRecord, SessionRoster } from '../../session-runtime/session-record.ts'
import type { LeaderboardModeSnapshot } from '../leaderboard/snapshot.ts'
import type { LobbyArrangeMarker } from '../lobby/types.ts'
import type { TournamentLobbySnapshot } from '../tournament/index.ts'
import { sessionDirectory, sessionDirectoryMembers } from '@civup/db'
import { GAME_MODES, startPlayerCountOptions, toBalanceLeaderboardMode } from '@civup/game'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { getServerDraftTimerDefaults } from '../config/index.ts'
import { getStoredLeaderboardModeSnapshot } from '../leaderboard/snapshot.ts'
import { buildTournamentLobbySnapshot } from '../tournament/index.ts'

export interface ActivityOverviewOptionSnapshot {
  kind: 'lobby' | 'match'
  id: string
  lobbyId: string
  matchId: string | null
  channelId: string
  mode: GameMode
  status: 'open' | 'drafting' | 'active' | 'completed'
  participantCount: number
  targetSize: number
  redDeath: boolean
  hostId: string
  memberPlayerIds: string[]
  updatedAt: number
}

export interface ActivityOverviewSnapshot {
  channelId: string
  options: ActivityOverviewOptionSnapshot[]
}

export interface LobbySnapshot {
  id: string
  revision: number
  mode: string
  hostId: string
  status: string
  steamLobbyLink: string | null
  minRole: SessionConfig['minRole']
  maxRole: SessionConfig['maxRole']
  lastArrange: LobbyArrangeMarker | null
  memberPlayerIds: string[]
  entries: ({
    playerId: string
    displayName: string
    avatarUrl?: string | null
    balanceRating?: {
      mu: number
      sigma: number
      gamesPlayed: number
    }
  } | null)[]
  minPlayers: number
  targetSize: number
  draftConfig: Omit<SessionConfig, 'minRole' | 'maxRole'>
  tournament?: TournamentLobbySnapshot | null
  serverDefaults: {
    banTimerSeconds: number | null
    pickTimerSeconds: number | null
  }
}

export interface ActivitySessionDirectoryEntry {
  sessionId: string
  phase: Extract<SessionPhase, 'open' | 'draft' | 'swap' | 'active' | 'reported'>
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
  createdAt: number
  updatedAt: number
  lastActivityAt: number
  closedAt: number | null
}

type ActivityDirectoryRow = typeof sessionDirectory.$inferSelect

const ACTIVITY_DIRECTORY_PHASES = ['open', 'draft', 'swap', 'active'] as const
const ACTIVITY_TARGET_PHASES = ['open', 'draft', 'swap', 'active', 'reported'] as const
const LIVE_ACTIVITY_OVERVIEW_STATUSES = new Set<ActivityOverviewOptionSnapshot['status']>(['open', 'drafting', 'active'])

export async function buildActivityOverviewSnapshotFromDirectory(
  db: Database,
  channelId: string,
): Promise<ActivityOverviewSnapshot | null> {
  const sessions = await getActivitySessionsByChannel(db, channelId)
  const options = sessions
    .flatMap(session => buildActivityOverviewOptions(session))
    .sort(compareActivityOverviewOptions)

  if (options.length === 0) return null
  return { channelId, options }
}

export function mergeActivityOverviewSnapshotForSessionUpdate(
  current: ActivityOverviewSnapshot | null,
  record: SessionRecord,
): ActivityOverviewSnapshot | null {
  const channelId = record.projectionState.channelId
  const options = [
    ...((current?.channelId === channelId ? current.options : [])
      .filter(option => option.lobbyId !== record.id && LIVE_ACTIVITY_OVERVIEW_STATUSES.has(option.status))),
    ...(isLiveActivityOverviewPhase(record.phase) ? buildActivityOverviewOptionsFromSessionRecord(record) : []),
  ].sort(compareActivityOverviewOptions)

  return options.length > 0 ? { channelId, options } : null
}

export async function getActivitySessionsByChannel(
  db: Database,
  channelId: string,
): Promise<ActivitySessionDirectoryEntry[]> {
  const rowsByPhase = await Promise.all(ACTIVITY_DIRECTORY_PHASES.map(phase => db.select().from(sessionDirectory).where(and(
    eq(sessionDirectory.channelId, channelId),
    eq(sessionDirectory.phase, phase),
  )).orderBy(desc(sessionDirectory.updatedAt))))

  const rows = rowsByPhase.flat().sort(compareActivityDirectoryRowsByUpdatedAtDesc)

  return rows.flatMap(parseActivitySessionDirectoryEntry)
}

function compareActivityDirectoryRowsByUpdatedAtDesc(left: ActivityDirectoryRow, right: ActivityDirectoryRow): number {
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
  return left.sessionId.localeCompare(right.sessionId)
}

function isLiveActivityOverviewPhase(phase: SessionRecord['phase']): boolean {
  return phase === 'open' || phase === 'draft' || phase === 'swap' || phase === 'active' || phase === 'reported'
}

export async function getActivitySessionById(
  db: Database,
  sessionId: string,
): Promise<ActivitySessionDirectoryEntry | null> {
  const [row] = await db.select().from(sessionDirectory).where(and(
    eq(sessionDirectory.sessionId, sessionId),
    inArray(sessionDirectory.phase, [...ACTIVITY_TARGET_PHASES]),
  )).limit(1)

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

  return rows.flatMap(row => parseActivitySessionDirectoryEntry(row.session))
}

export function buildActivityOverviewOptions(session: ActivitySessionDirectoryEntry): ActivityOverviewOptionSnapshot[] {
  const status = mapSessionPhaseToActivityStatus(session.phase)
  if (!status) return []
  const matchId = session.phase === 'open' ? null : session.matchId ?? session.sessionId
  const id = session.phase === 'open' ? session.sessionId : matchId ?? session.sessionId

  return [{
    kind: session.phase === 'open' ? 'lobby' : 'match',
    id,
    lobbyId: session.sessionId,
    matchId,
    channelId: session.channelId,
    mode: session.mode,
    status,
    participantCount: countFilledSlots(session.roster.slots),
    targetSize: session.roster.slots.length,
    redDeath: session.config.redDeath,
    hostId: session.hostId,
    memberPlayerIds: session.roster.participants.map(member => member.playerId),
    updatedAt: session.updatedAt,
  }]
}

export function buildActivityOverviewOptionsFromSessionRecord(record: SessionRecord): ActivityOverviewOptionSnapshot[] {
  const status = mapSessionPhaseToActivityStatus(record.phase)
  if (!status) return []

  const matchId = record.phase === 'open' ? null : record.matchId ?? record.id
  const id = record.phase === 'open' ? record.id : matchId ?? record.id
  return [{
    kind: record.phase === 'open' ? 'lobby' : 'match',
    id,
    lobbyId: record.id,
    matchId,
    channelId: record.projectionState.channelId,
    mode: record.mode,
    status,
    participantCount: countFilledSlots(record.roster.slots),
    targetSize: record.roster.slots.length,
    redDeath: record.config.redDeath,
    hostId: record.hostId,
    memberPlayerIds: record.roster.participants.map(member => member.playerId),
    updatedAt: record.updatedAt,
  }]
}

export async function buildLobbySnapshotFromSessionRecord(
  kv: KVNamespace,
  record: SessionRecord,
  balanceSnapshot?: LeaderboardModeSnapshot | null,
): Promise<LobbySnapshot> {
  return attachLobbyBalanceRatingsToSnapshot(
    kv,
    record.mode,
    await buildLobbySnapshotFromSessionParts(kv, {
      id: record.id,
      version: record.version,
      mode: record.mode,
      hostId: record.hostId,
      phase: record.phase,
      steamLobbyLink: record.projectionState.steamLobbyLink,
      minRole: record.config.minRole,
      maxRole: record.config.maxRole,
      lastArrange: record.lastArrange,
      roster: record.roster,
      config: record.config,
    }),
    balanceSnapshot,
  )
}

export async function buildLobbySnapshotFromDirectoryEntry(
  kv: KVNamespace,
  session: ActivitySessionDirectoryEntry,
  balanceSnapshot?: LeaderboardModeSnapshot | null,
): Promise<LobbySnapshot> {
  return attachLobbyBalanceRatingsToSnapshot(
    kv,
    session.mode,
    await buildLobbySnapshotFromSessionParts(kv, {
      id: session.sessionId,
      version: session.version,
      mode: session.mode,
      hostId: session.hostId,
      phase: session.phase,
      steamLobbyLink: session.steamLobbyLink,
      minRole: session.config.minRole,
      maxRole: session.config.maxRole,
      lastArrange: null,
      roster: session.roster,
      config: session.config,
    }),
    balanceSnapshot,
  )
}

export async function attachLobbyBalanceRatingsToSnapshot(
  kv: KVNamespace,
  mode: GameMode,
  snapshot: LobbySnapshot,
  balanceSnapshot?: LeaderboardModeSnapshot | null,
): Promise<LobbySnapshot> {
  const leaderboardMode = toBalanceLeaderboardMode(mode, { redDeath: snapshot.draftConfig.redDeath })
  if (!leaderboardMode) return snapshot

  const leaderboardSnapshot = balanceSnapshot === undefined
    ? await getStoredLeaderboardModeSnapshot(kv, leaderboardMode)
    : balanceSnapshot
  if (!leaderboardSnapshot) return snapshot

  const balanceRatingByPlayerId = new Map(leaderboardSnapshot.rows.map(row => [
    row.playerId,
    {
      mu: row.mu,
      sigma: row.sigma,
      gamesPlayed: row.gamesPlayed,
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

export async function attachTournamentLobbySnapshot(db: Database, snapshot: LobbySnapshot): Promise<LobbySnapshot> {
  const tournament = await buildTournamentLobbySnapshot(db, snapshot.id, snapshot.memberPlayerIds)
  if (!tournament && snapshot.tournament == null) return snapshot
  return { ...snapshot, tournament }
}

function parseActivitySessionDirectoryEntry(row: ActivityDirectoryRow): ActivitySessionDirectoryEntry[] {
  if (!isActivitySessionPhase(row.phase) || !isGameMode(row.mode)) return []
  const roster = parseSessionRoster(row.rosterJson)
  const config = parseSessionConfig(row.configJson, row.mode)
  if (!roster || !config) return []

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
    config,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastActivityAt: row.lastActivityAt,
    closedAt: row.closedAt,
  }]
}

async function buildLobbySnapshotFromSessionParts(
  kv: KVNamespace,
  session: {
    id: string
    version: number
    mode: GameMode
    hostId: string
    phase: SessionPhase
    steamLobbyLink: string | null
    minRole: SessionConfig['minRole']
    maxRole: SessionConfig['maxRole']
    lastArrange: LobbyArrangeMarker | null
    roster: SessionRoster
    config: SessionConfig
  },
): Promise<LobbySnapshot> {
  const serverDefaults = await getServerDraftTimerDefaults(kv)
  const memberByPlayerId = new Map(session.roster.participants.map(member => [member.playerId, member]))
  const memberPlayerIds = session.roster.participants.map(member => member.playerId)
  const entries = session.roster.slots.map((playerId) => {
    if (!playerId) return null
    const member = memberByPlayerId.get(playerId)
    if (!member) return null
    return {
      playerId,
      displayName: member.displayName ?? playerId,
      avatarUrl: member.avatarUrl ?? null,
    }
  })
  const targetSize = session.roster.slots.length

  return {
    id: session.id,
    revision: session.version,
    mode: session.mode,
    hostId: session.hostId,
    status: mapSessionPhaseToLobbySnapshotStatus(session.phase),
    steamLobbyLink: session.steamLobbyLink,
    minRole: session.minRole,
    maxRole: session.maxRole,
    lastArrange: session.lastArrange,
    memberPlayerIds,
    entries,
    minPlayers: startPlayerCountOptions(session.mode, targetSize, { redDeath: session.config.redDeath })[0] ?? targetSize,
    targetSize,
    draftConfig: {
      banTimerSeconds: session.config.banTimerSeconds,
      pickTimerSeconds: session.config.pickTimerSeconds,
      leaderPoolSize: session.config.leaderPoolSize,
      leaderDataVersion: session.config.leaderDataVersion,
      mapVoteEnabled: session.config.mapVoteEnabled,
      blindBans: session.config.blindBans,
      simultaneousPick: session.config.simultaneousPick,
      permanentAlly: session.config.permanentAlly,
      redDeath: session.config.redDeath,
      dealOptionsSize: session.config.dealOptionsSize,
      randomDraft: session.config.randomDraft,
      hiddenDraft: session.config.hiddenDraft,
      duplicateFactions: session.config.duplicateFactions,
    },
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

function parseSessionConfig(raw: string, mode: GameMode): SessionConfig | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SessionConfig>
    if (!parsed || typeof parsed !== 'object') return null
    return {
      banTimerSeconds: typeof parsed.banTimerSeconds === 'number' ? parsed.banTimerSeconds : null,
      pickTimerSeconds: typeof parsed.pickTimerSeconds === 'number' ? parsed.pickTimerSeconds : null,
      leaderPoolSize: typeof parsed.leaderPoolSize === 'number' ? parsed.leaderPoolSize : null,
      leaderDataVersion: parsed.leaderDataVersion === 'beta' ? 'beta' : 'live',
      mapVoteEnabled: parsed.mapVoteEnabled === true,
      blindBans: parsed.blindBans === true,
      simultaneousPick: parsed.simultaneousPick === true,
      permanentAlly: mode === 'ffa' && parsed.redDeath !== true ? parsed.permanentAlly !== false : false,
      redDeath: parsed.redDeath === true,
      dealOptionsSize: typeof parsed.dealOptionsSize === 'number' ? parsed.dealOptionsSize : null,
      randomDraft: parsed.randomDraft === true,
      hiddenDraft: parsed.hiddenDraft === true,
      duplicateFactions: parsed.duplicateFactions === true,
      minRole: parsed.minRole ?? null,
      maxRole: parsed.maxRole ?? null,
    }
  }
  catch {
    return null
  }
}

export function compareActivityOverviewOptions(left: ActivityOverviewOptionSnapshot, right: ActivityOverviewOptionSnapshot): number {
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
  if (left.mode !== right.mode) return left.mode.localeCompare(right.mode)
  return left.id.localeCompare(right.id)
}

function mapSessionPhaseToActivityStatus(phase: SessionPhase): ActivityOverviewOptionSnapshot['status'] | null {
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
  return value === 'open' || value === 'draft' || value === 'swap' || value === 'active' || value === 'reported'
}

function isGameMode(value: unknown): value is GameMode {
  return typeof value === 'string' && GAME_MODES.includes(value as GameMode)
}
