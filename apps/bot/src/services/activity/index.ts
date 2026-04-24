import type { DraftSeat, DraftTimerConfig, GameMode, LeaderDataVersion, QueueEntry, RoomConfig } from '@civup/game'
import type { LobbyState } from '../lobby/types.ts'
import { allFactionIds, getDraftFormat, isTeamMode, normalizeMapVoteEnabled, requiresRedDeathDuplicateFactions, resolveLeaderPoolSize, sampleLeaderPool, slotToTeamIndex, teamCount, teamSize } from '@civup/game'
import { getCurrentLobbiesForPlayer, getLobbiesByChannel, getLobbyByMatch, getOpenLobbyForPlayer } from '../lobby/index.ts'

// ── Types ───────────────────────────────────────────────────

export interface MatchCreationResult {
  matchId: string
  formatId: string
  seats: DraftSeat[]
}

export interface CreateDraftRoomOptions {
  matchId: string
  hostId: string
  leaderDataVersion?: LeaderDataVersion
  blindBans?: boolean
  simultaneousPick?: boolean
  redDeath?: boolean
  mapVoteEnabled?: boolean
  randomDraft?: boolean
  duplicateFactions?: boolean
  timerConfig?: DraftTimerConfig
  leaderPoolSize?: number | null
  dealOptionsSize?: number | null
}

export interface DraftRuntimeConfigResult extends MatchCreationResult {
  config: RoomConfig
}

// ── Build draft runtime config under SessionDO ownership ────

/** Builds the initial draft runtime config for a session. */
export function buildDraftRuntimeConfig(
  mode: GameMode,
  entries: QueueEntry[],
  options: CreateDraftRoomOptions,
): DraftRuntimeConfigResult {
  const matchId = options.matchId
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
  }

  return { matchId, formatId: format.id, seats, config }
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

/** Get the open-lobby ID for a user from canonical lobby membership. */
export async function getLobbyForUser(
  kv: KVNamespace,
  userId: string,
): Promise<string | null> {
  return (await getOpenLobbyForPlayer(kv, userId))?.id ?? null
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

/** Get match ID for a user from canonical live lobby membership. */
export async function getMatchForUser(
  kv: KVNamespace,
  userId: string,
): Promise<string | null> {
  const liveLobby = (await getCurrentLobbiesForPlayer(kv, userId))
    .filter((candidate): candidate is LobbyState & { matchId: string } => isCurrentMatchLobby(candidate))
    .sort((left, right) => right.updatedAt - left.updatedAt)[0] ?? null
  return liveLobby?.matchId ?? null
}

/** Get channel ID by match ID from canonical same-id lobby state. */
export async function getChannelForMatch(
  kv: KVNamespace,
  matchId: string,
): Promise<string | null> {
  const lobby = await getLobbyByMatch(kv, matchId)
  return lobby?.channelId ?? null
}

function isCurrentMatchLobby(
  lobby: Pick<LobbyState, 'status' | 'matchId'>,
): lobby is Pick<LobbyState, 'status'> & { matchId: string } {
  return (lobby.status === 'drafting' || lobby.status === 'active')
    && typeof lobby.matchId === 'string'
    && lobby.matchId.length > 0
}
