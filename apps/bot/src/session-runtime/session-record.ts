import type { CompetitiveTier, GameMode, QueueEntry } from '@civup/game'
import type { LobbyArrangeMarker, LobbyDraftConfig, LobbyState } from '../services/lobby/types.ts'

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

interface BaseSessionRecord {
  id: SessionId
  phase: SessionPhase
  version: number
  hostId: string
  guildId: string | null
  channelId: string
  mode: GameMode
  matchId: string | null
  config: SessionConfig
  roster: SessionRoster
  lastArrange: LobbyArrangeMarker | null
  projectionState: SessionProjectionState
  createdAt: number
  updatedAt: number
  lastActivityAt: number
  closedAt: number | null
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

export type SessionRecord =
  | OpenSessionRecord
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
    channelId: lobby.channelId,
    mode: lobby.mode,
    matchId: lobby.matchId,
    config: buildSessionConfig(lobby),
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
    blindBans: config.blindBans,
    simultaneousPick: config.simultaneousPick,
    redDeath: config.redDeath,
    dealOptionsSize: config.dealOptionsSize,
    randomDraft: config.randomDraft,
    duplicateFactions: config.duplicateFactions,
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
        joinedAt: queueEntry?.joinedAt ?? 0,
        ...(partyIds && partyIds.length > 0 ? { partyIds } : {}),
        slotIndex: slotIndexByPlayerId.get(playerId) ?? null,
      }
    }),
    slots: [...lobby.slots],
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
    joinedAt: member.joinedAt,
    ...(member.partyIds && member.partyIds.length > 0 ? { partyIds: member.partyIds } : {}),
  }
}

function preserveFrozenSessionState(existing: SessionRecord, next: SessionRecord): SessionRecord {
  if (existing.phase === 'open' || next.phase === 'open') return next

  return {
    ...next,
    config: existing.config,
    roster: existing.roster,
    frozenAt: existing.frozenAt ?? next.frozenAt,
  } as SessionRecord
}
