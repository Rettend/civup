import type { AppliedCivLobbySettings, CompetitiveTier, GameMode, QueueEntry, SourceGuildIdentity } from '@civup/game'
import type { LobbyArrangeMarker, LobbyDraftConfig, LobbyState } from '../services/lobby/types.ts'
import type { DraftLifecyclePayload } from './draft-lifecycle-events.ts'
import { normalizeAppliedCivLobbySettings } from '@civup/game'

export type SessionId = string
export type SessionPhase = 'open' | 'draft' | 'swap' | 'active' | 'reported' | 'cancelled'

export interface SessionConfig extends LobbyDraftConfig {
  minRole: CompetitiveTier | null
  maxRole: CompetitiveTier | null
}

export interface SessionRosterMember {
  playerId: string
  displayName: string | null
  avatarUrl: string | null
  sourceGuild?: SourceGuildIdentity
  joinedAt: number
  partyIds?: string[]
  slotIndex: number | null
}

export interface SessionRoster {
  participants: SessionRosterMember[]
  slots: (string | null)[]
}

export interface SessionProjectionState {
  channelId: string
  messageId: string
  steamLobbyLink: string | null
}

export interface SessionLifecycleSyncState {
  payload: DraftLifecyclePayload
  attempts: number
  nextRetryAt: number
}

export interface SessionProjectionParticipant {
  playerId: string
  team: number | null
  civId: string | null
  placement?: number | null
  ratingBeforeMu?: number | null
  ratingBeforeSigma?: number | null
  ratingAfterMu?: number | null
  ratingAfterSigma?: number | null
  leaderboardBeforeRank?: number | null
  leaderboardAfterRank?: number | null
  leaderboardEligibleCount?: number | null
}

export type SessionProjectionSyncPayload
  = | {
    type: 'draft-completed'
    payload: Extract<DraftLifecyclePayload, { outcome: 'complete' }>
    participants: SessionProjectionParticipant[]
  }
  | {
    type: 'draft-cancelled'
    payload: Extract<DraftLifecyclePayload, { outcome: 'cancelled' }>
    participants: SessionProjectionParticipant[]
  }

export interface SessionProjectionSyncState {
  payload: SessionProjectionSyncPayload
  attempts: number
  nextRetryAt: number
}

export interface SessionDraftStartSyncState {
  attempts: number
  nextRetryAt: number
  deadlineAt: number
}

export type SessionTerminalSyncCommand
  = | {
    type: 'mark-reported'
    matchId: string
    at: number
    reportedById?: string | null
  }
  | {
    type: 'cancel-session'
    matchId: string
    at: number
  }

export interface SessionTerminalSyncState {
  command: SessionTerminalSyncCommand
  attempts: number
  nextRetryAt: number
}

interface BaseSessionRecord {
  id: SessionId
  phase: SessionPhase
  version: number
  hostId: string
  guildId: string | null
  /** Missing participant source is accepted only for records created before source provenance cutover. */
  sourceGuildPolicy?: 'legacy-primary' | 'required'
  channelId: string
  mode: GameMode
  matchId: string | null
  config: SessionConfig
  gameSettings: AppliedCivLobbySettings
  roster: SessionRoster
  lastArrange: LobbyArrangeMarker | null
  projectionState: SessionProjectionState
  createdAt: number
  updatedAt: number
  lastActivityAt: number
  closedAt: number | null
  draftStartSync?: SessionDraftStartSyncState | null
  lifecycleEventSequence?: number
  lifecycleSync?: SessionLifecycleSyncState | null
  projectionSync?: SessionProjectionSyncState | null
  terminalSync?: SessionTerminalSyncState | null
}

export interface OpenSessionRecord extends BaseSessionRecord {
  phase: 'open'
  matchId: null
  closedAt: null
}

export interface DraftSessionRecord extends BaseSessionRecord {
  phase: 'draft'
  matchId: string
  frozenAt: number
  closedAt: null
}

export interface SwapSessionRecord extends BaseSessionRecord {
  phase: 'swap'
  matchId: string
  frozenAt: number
  closedAt: null
}

export interface ActiveSessionRecord extends BaseSessionRecord {
  phase: 'active'
  matchId: string
  frozenAt: number
  closedAt: null
}

export interface ReportedSessionRecord extends BaseSessionRecord {
  phase: 'reported'
  frozenAt: number
  closedAt: number
}

export interface CancelledSessionRecord extends BaseSessionRecord {
  phase: 'cancelled'
  frozenAt: number | null
  closedAt: number
}

export type SessionRecord
  = | OpenSessionRecord
    | DraftSessionRecord
    | SwapSessionRecord
    | ActiveSessionRecord
    | ReportedSessionRecord
    | CancelledSessionRecord

export function buildOpenSessionRecordFromLobby(
  lobby: LobbyState,
  queueEntries: readonly QueueEntry[] = [],
): OpenSessionRecord {
  const record = buildSessionRecordFromLobby(lobby, queueEntries)
  if (record.phase !== 'open') {
    throw new Error(`Expected open lobby for session creation, got ${record.phase}`)
  }
  return record
}

export function syncSessionRecordFromLobby(
  existing: SessionRecord | null,
  lobby: LobbyState,
  queueEntries: readonly QueueEntry[] = [],
): SessionRecord {
  const next = buildSessionRecordFromLobby(lobby, queueEntries)
  if (!existing) return next
  if (existing.id !== next.id) {
    throw new Error(`Session id mismatch: expected ${existing.id}, got ${next.id}`)
  }
  if (next.version <= existing.version) return existing
  return preserveFrozenSessionState(existing, next)
}

export function buildSessionRecordFromLobby(
  lobby: LobbyState,
  queueEntries: readonly QueueEntry[] = [],
): SessionRecord {
  const phase = mapLobbyStatusToSessionPhase(lobby.status)
  const closedAt = phase === 'reported' || phase === 'cancelled'
    ? Math.max(lobby.updatedAt, lobby.lastActivityAt, 1)
    : null
  const base = {
    id: lobby.id,
    phase,
    version: lobby.revision,
    hostId: lobby.hostId,
    guildId: lobby.guildId,
    sourceGuildPolicy: 'required',
    channelId: lobby.channelId,
    mode: lobby.mode,
    matchId: lobby.matchId,
    config: buildSessionConfig(lobby),
    gameSettings: normalizeAppliedCivLobbySettings(lobby.gameSettings),
    roster: buildSessionRoster(lobby, queueEntries),
    lastArrange: lobby.lastArrange ?? null,
    projectionState: {
      channelId: lobby.channelId,
      messageId: lobby.messageId,
      steamLobbyLink: lobby.steamLobbyLink,
    },
    createdAt: lobby.createdAt,
    updatedAt: lobby.updatedAt,
    lastActivityAt: lobby.lastActivityAt,
    closedAt,
    draftStartSync: null,
    lifecycleEventSequence: 0,
    lifecycleSync: null,
    projectionSync: null,
    terminalSync: null,
  } satisfies BaseSessionRecord

  switch (phase) {
    case 'open':
      return {
        ...base,
        phase,
        matchId: null,
        closedAt: null,
      }
    case 'draft':
      return {
        ...base,
        phase,
        matchId: lobby.matchId ?? lobby.id,
        frozenAt: lobby.updatedAt,
        closedAt: null,
      }
    case 'swap':
    case 'active':
      return {
        ...base,
        phase,
        matchId: lobby.matchId ?? lobby.id,
        frozenAt: lobby.updatedAt,
        closedAt: null,
      }
    case 'reported':
      return {
        ...base,
        phase,
        matchId: lobby.matchId,
        frozenAt: lobby.updatedAt,
        closedAt: closedAt ?? lobby.updatedAt,
      }
    case 'cancelled':
      return {
        ...base,
        phase,
        frozenAt: lobby.matchId ? lobby.updatedAt : null,
        closedAt: closedAt ?? lobby.updatedAt,
      }
  }
}

export function buildSessionConfig(lobby: Pick<LobbyState, 'draftConfig' | 'minRole' | 'maxRole'>): SessionConfig {
  return {
    ...lobby.draftConfig,
    minRole: lobby.minRole,
    maxRole: lobby.maxRole,
  }
}

export function buildLobbyStateFromSessionRecord(
  record: SessionRecord,
  currentLobby: LobbyState,
): LobbyState {
  return {
    ...currentLobby,
    id: record.id,
    mode: record.mode,
    status: mapSessionPhaseToLobbyStatus(record.phase, currentLobby.status),
    guildId: record.guildId,
    hostId: record.hostId,
    channelId: record.projectionState.channelId,
    messageId: record.projectionState.messageId,
    matchId: record.matchId,
    steamLobbyLink: record.projectionState.steamLobbyLink,
    minRole: record.config.minRole,
    maxRole: record.config.maxRole,
    lastArrange: record.lastArrange,
    lastActivityAt: record.lastActivityAt,
    memberPlayerIds: record.roster.participants.map(member => member.playerId),
    slots: [...record.roster.slots],
    draftConfig: buildLobbyDraftConfigFromSessionConfig(record.config),
    gameSettings: normalizeAppliedCivLobbySettings(record.gameSettings),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    revision: record.version,
  }
}

export function buildLobbyProjectionFromSessionRecord(record: SessionRecord): LobbyState {
  return {
    id: record.id,
    mode: record.mode,
    status: mapSessionPhaseToLobbyStatus(record.phase, 'cancelled'),
    guildId: record.guildId,
    hostId: record.hostId,
    channelId: record.projectionState.channelId,
    messageId: record.projectionState.messageId,
    matchId: record.matchId,
    steamLobbyLink: record.projectionState.steamLobbyLink,
    minRole: record.config.minRole,
    maxRole: record.config.maxRole,
    lastArrange: record.lastArrange,
    lastActivityAt: record.lastActivityAt,
    memberPlayerIds: record.roster.participants.map(member => member.playerId),
    slots: [...record.roster.slots],
    draftConfig: buildLobbyDraftConfigFromSessionConfig(record.config),
    gameSettings: normalizeAppliedCivLobbySettings(record.gameSettings),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    revision: record.version,
  }
}

export function buildLobbyDraftConfigFromSessionConfig(config: SessionConfig): LobbyDraftConfig {
  return {
    banTimerSeconds: config.banTimerSeconds,
    pickTimerSeconds: config.pickTimerSeconds,
    leaderPoolSize: config.leaderPoolSize,
    leaderDataVersion: config.leaderDataVersion,
    mapVoteEnabled: config.mapVoteEnabled,
    teamFormationEnabled: config.teamFormationEnabled === true,
    blindBans: config.blindBans,
    simultaneousPick: config.simultaneousPick,
    permanentAlly: config.redDeath || config.civBlitz ? false : config.permanentAlly !== false,
    redDeath: config.redDeath,
    dealOptionsSize: config.dealOptionsSize,
    civBlitz: config.civBlitz,
    civBlitzOptionCount: config.civBlitzOptionCount,
    civBlitzExcludeBbgExpanded: config.civBlitzExcludeBbgExpanded,
    blindPicks: config.blindPicks,
    randomDraft: config.randomDraft,
    hiddenDraft: config.hiddenDraft,
    duplicateFactions: config.duplicateFactions,
    closed: config.closed === true,
  }
}

export function parseStoredSessionDirectoryConfig(raw: string, mode: GameMode): { config: SessionConfig, gameSettings: AppliedCivLobbySettings } | null {
  try {
    const parsed = JSON.parse(raw) as Partial<SessionConfig> & { gameSettings?: unknown }
    if (!parsed || typeof parsed !== 'object') return null
    return {
      config: {
        banTimerSeconds: typeof parsed.banTimerSeconds === 'number' ? parsed.banTimerSeconds : null,
        pickTimerSeconds: typeof parsed.pickTimerSeconds === 'number' ? parsed.pickTimerSeconds : null,
        leaderPoolSize: typeof parsed.leaderPoolSize === 'number' ? parsed.leaderPoolSize : null,
        leaderDataVersion: parsed.leaderDataVersion === 'beta' ? 'beta' : 'live',
        mapVoteEnabled: parsed.mapVoteEnabled === true,
        teamFormationEnabled: parsed.teamFormationEnabled === true,
        blindBans: parsed.blindBans !== false,
        blindPicks: parsed.blindPicks === true,
        simultaneousPick: parsed.simultaneousPick === true,
        permanentAlly: mode === 'ffa' && parsed.redDeath !== true && parsed.civBlitz !== true ? parsed.permanentAlly !== false : false,
        redDeath: parsed.redDeath === true,
        dealOptionsSize: typeof parsed.dealOptionsSize === 'number' ? parsed.dealOptionsSize : null,
        civBlitz: parsed.civBlitz === true,
        civBlitzOptionCount: typeof parsed.civBlitzOptionCount === 'number' ? parsed.civBlitzOptionCount : 4,
        civBlitzExcludeBbgExpanded: parsed.civBlitzExcludeBbgExpanded !== false,
        randomDraft: parsed.randomDraft === true,
        hiddenDraft: parsed.hiddenDraft === true,
        duplicateFactions: parsed.duplicateFactions === true,
        closed: parsed.closed === true,
        minRole: parsed.minRole ?? null,
        maxRole: parsed.maxRole ?? null,
      },
      gameSettings: normalizeAppliedCivLobbySettings(parsed.gameSettings),
    }
  }
  catch {
    return null
  }
}

export function buildSessionRosterQueueEntries(record: Pick<SessionRecord, 'roster'>): QueueEntry[] {
  return record.roster.participants.map(member => buildQueueEntryFromRosterMember(member))
}

export function buildSessionRosterSlotEntries(record: Pick<SessionRecord, 'roster'>): QueueEntry[] {
  const memberByPlayerId = new Map(record.roster.participants.map(member => [member.playerId, member]))
  const entries: QueueEntry[] = []
  for (const playerId of record.roster.slots) {
    if (!playerId) continue
    const member = memberByPlayerId.get(playerId)
    if (!member) continue
    entries.push(buildQueueEntryFromRosterMember(member))
  }
  return entries
}

export function buildSessionRoster(
  lobby: Pick<LobbyState, 'memberPlayerIds' | 'slots'>,
  queueEntries: readonly QueueEntry[] = [],
): SessionRoster {
  const queueEntryByPlayerId = new Map(queueEntries.map(entry => [entry.playerId, entry]))
  const slotIndexByPlayerId = new Map<string, number>()
  lobby.slots.forEach((playerId, index) => {
    if (playerId && !slotIndexByPlayerId.has(playerId)) slotIndexByPlayerId.set(playerId, index)
  })

  return {
    participants: lobby.memberPlayerIds.map((playerId) => {
      const queueEntry = queueEntryByPlayerId.get(playerId)
      const partyIds = queueEntry?.partyIds?.filter(partyId => partyId !== playerId)
      return {
        playerId,
        displayName: queueEntry?.displayName ?? null,
        avatarUrl: queueEntry?.avatarUrl ?? null,
        ...(queueEntry?.sourceGuild ? { sourceGuild: queueEntry.sourceGuild } : {}),
        joinedAt: queueEntry?.joinedAt ?? 0,
        ...(partyIds && partyIds.length > 0 ? { partyIds } : {}),
        slotIndex: slotIndexByPlayerId.get(playerId) ?? null,
      }
    }),
    slots: [...lobby.slots],
  }
}

/** Project final draft team assignments back into team-grouped lobby slots. */
export function buildSessionRosterFromDraftSeats(roster: SessionRoster, seats: readonly { playerId: string, team?: number }[]): SessionRoster {
  if (seats.length === 0 || seats.some(seat => seat.team == null)) return roster
  const teamIndexes = [...new Set(seats.map(seat => seat.team!))].sort((left, right) => left - right)
  if (teamIndexes.length < 2) return roster
  const slots = teamIndexes.flatMap(team => seats.filter(seat => seat.team === team).map(seat => seat.playerId))
  if (slots.length !== seats.length || new Set(slots).size !== seats.length) return roster
  const slotIndexByPlayerId = new Map(slots.map((playerId, slotIndex) => [playerId, slotIndex]))
  return {
    slots,
    participants: roster.participants.map(member => ({
      ...member,
      slotIndex: slotIndexByPlayerId.get(member.playerId) ?? null,
    })),
  }
}

function mapLobbyStatusToSessionPhase(status: LobbyState['status']): SessionPhase {
  switch (status) {
    case 'open':
      return 'open'
    case 'drafting':
      return 'draft'
    case 'active':
      return 'active'
    case 'completed':
      return 'reported'
    case 'cancelled':
    case 'scrubbed':
      return 'cancelled'
  }
}

function mapSessionPhaseToLobbyStatus(phase: SessionPhase, currentStatus: LobbyState['status']): LobbyState['status'] {
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
      return currentStatus === 'scrubbed' ? 'scrubbed' : 'cancelled'
  }
}

function buildQueueEntryFromRosterMember(member: SessionRosterMember): QueueEntry {
  return {
    playerId: member.playerId,
    displayName: member.displayName ?? member.playerId,
    avatarUrl: member.avatarUrl,
    ...(member.sourceGuild ? { sourceGuild: member.sourceGuild } : {}),
    joinedAt: member.joinedAt,
    ...(member.partyIds && member.partyIds.length > 0 ? { partyIds: member.partyIds } : {}),
  }
}

function preserveFrozenSessionState(existing: SessionRecord, next: SessionRecord): SessionRecord {
  const withImmutableOrigin = {
    ...next,
    guildId: existing.guildId,
    channelId: existing.channelId,
    projectionState: {
      ...next.projectionState,
      channelId: existing.projectionState.channelId,
      messageId: existing.projectionState.messageId,
    },
  } as SessionRecord
  if (existing.phase === 'open' || next.phase === 'open') return withImmutableOrigin

  return {
    ...withImmutableOrigin,
    config: existing.config,
    gameSettings: existing.gameSettings,
    roster: existing.roster,
    frozenAt: existing.frozenAt ?? next.frozenAt,
  } as SessionRecord
}
