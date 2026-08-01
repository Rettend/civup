import type { Database } from '@civup/db'
import type { AppliedCivLobbySettings, CompetitiveTier, DraftSeat, DraftTimerConfig, GameMode, LeaderDataVersion, QueueEntry, TeamFormationPlayerStats } from '@civup/game'
import type { DraftRuntimeConfig } from '@civup/session'
import { matches, matchParticipants, sessionDirectory } from '@civup/db'
import { allFactionIds, getCivBlitzComponentIds, getCivBlitzOptionCountMaximum, getDraftFormat, getEligibleLeaderIds, isCaptainPickSupported, isTeamMode, normalizeAppliedCivLobbySettings, normalizeCivBlitzOptionCount, normalizeMapVoteEnabled, requiresRedDeathDuplicateFactions, resolveCivLobbySettings, resolveLeaderPoolSize, sampleLeaderPool, slotToTeamIndex, teamCount, teamSize } from '@civup/game'
import { and, desc, eq, inArray, or } from 'drizzle-orm'
import { getActivitySessionsByChannel, getOpenActivitySessionsForUser } from './session-state.ts'
import { buildLobbyPartyPlayerIds } from '../lobby/team-guilds.ts'

// ── Types ───────────────────────────────────────────────────

export interface MatchCreationResult {
  matchId: string
  formatId: string
  seats: DraftSeat[]
}

export interface CreateDraftRuntimeOptions {
  matchId: string
  hostId: string
  leaderDataVersion?: LeaderDataVersion
  blindBans?: boolean
  blindPicks?: boolean
  simultaneousPick?: boolean
  permanentAlly?: boolean
  redDeath?: boolean
  civBlitz?: boolean
  civBlitzOptionCount?: number | null
  civBlitzExcludeBbgExpanded?: boolean
  mapVoteEnabled?: boolean
  teamFormationEnabled?: boolean
  teamFormationStatsBySeat?: Record<number, TeamFormationPlayerStats>
  randomDraft?: boolean
  hiddenDraft?: boolean
  duplicateFactions?: boolean
  timerConfig?: DraftTimerConfig
  leaderPoolSize?: number | null
  leaderPoolRankTier?: CompetitiveTier | null
  dealOptionsSize?: number | null
  steamLobbyLink?: string | null
  gameSettings?: AppliedCivLobbySettings
}

export interface DraftRuntimeConfigResult extends MatchCreationResult {
  config: DraftRuntimeConfig
}

// ── Build draft runtime config under SessionDO ownership ────

/** Builds the initial draft runtime config for a session. */
export function buildDraftRuntimeConfig(
  mode: GameMode,
  entries: QueueEntry[],
  options: CreateDraftRuntimeOptions,
): DraftRuntimeConfigResult {
  const matchId = options.matchId
  const civBlitz = options.civBlitz === true
  const redDeathMode = !civBlitz && options.redDeath === true
  const seats: DraftSeat[] = buildDraftSeats(mode, entries)
  const teamFormationEnabled = options.teamFormationEnabled === true && isCaptainPickSupported(mode, seats.length)
  const runtimeSeats = teamFormationEnabled
    ? seats.map((seat, seatIndex) => ({ ...seat, team: seatIndex < 2 ? seatIndex : undefined }))
    : seats
  const simultaneousPick = mode === 'ffa' && !redDeathMode && !civBlitz && options.simultaneousPick === true
  const blindPicks = !civBlitz && options.blindPicks === true
  const hiddenDraft = !civBlitz && options.hiddenDraft === true
  const randomDraft = !civBlitz && !hiddenDraft && options.randomDraft === true
  // Duplicate picks are a general draft-engine capability; only Red Death forces them on.
  const duplicateFactions = redDeathMode
    ? (requiresRedDeathDuplicateFactions(mode) || options.duplicateFactions === true)
    : (!civBlitz && options.duplicateFactions === true)
  const mapVoteEnabled = normalizeMapVoteEnabled(mode, options.mapVoteEnabled === true, { redDeath: redDeathMode })
  const format = getDraftFormat(mode, { simultaneousPick, randomDraft, redDeath: redDeathMode, civBlitz, blindBans: options.blindBans, blindPicks, seatCount: seats.length })
  const leaderDataVersion = options.leaderDataVersion ?? 'live'
  const civBlitzExcludeBbgExpanded = options.civBlitzExcludeBbgExpanded !== false
  const civBlitzOptionCount = civBlitz
    ? Math.min(
        normalizeCivBlitzOptionCount(options.civBlitzOptionCount ?? undefined),
        getCivBlitzOptionCountMaximum(leaderDataVersion, { excludeBbgExpanded: civBlitzExcludeBbgExpanded }),
      )
    : undefined
  const gameSettings = normalizeAppliedCivLobbySettings(options.gameSettings)
  const autoBannedLeaderIds = redDeathMode || civBlitz
    ? []
    : resolveCivLobbySettings(gameSettings.profile, mode).autoBannedLeaderIds
  const eligibleLeaderIds = redDeathMode || civBlitz
    ? []
    : getEligibleLeaderIds(leaderDataVersion, autoBannedLeaderIds)
  const requestedLeaderPoolSize = resolveLeaderPoolSize(mode, seats.length, options.leaderPoolSize, leaderDataVersion, options.leaderPoolRankTier)
  const leaderPoolSize = options.leaderPoolSize == null
    ? Math.min(requestedLeaderPoolSize, eligibleLeaderIds.length)
    : requestedLeaderPoolSize
  const civPool = civBlitz
    ? getCivBlitzComponentIds(leaderDataVersion, { excludeBbgExpanded: civBlitzExcludeBbgExpanded })
    : redDeathMode
    ? [...allFactionIds]
    : hiddenDraft
      ? eligibleLeaderIds
      : sampleLeaderPool(leaderPoolSize, Math.random, leaderDataVersion, autoBannedLeaderIds)
  const config: DraftRuntimeConfig = {
    matchId,
    hostId: options.hostId,
    formatId: format.id,
    seats: runtimeSeats,
    civPool,
    dealOptionsSize: redDeathMode ? options.dealOptionsSize ?? undefined : undefined,
    civBlitz,
    civBlitzOptionCount,
    civBlitzExcludeBbgExpanded: civBlitz ? civBlitzExcludeBbgExpanded : undefined,
    blindPicks,
    randomDraft,
    hiddenDraft,
    permanentAlly: mode === 'ffa' && !redDeathMode && !civBlitz && options.permanentAlly !== false,
    duplicateFactions,
    mapVoteEnabled,
    teamFormationEnabled,
    teamFormationPartySeatIndices: teamFormationEnabled ? buildTeamFormationPartySeatIndices(seats, entries) : undefined,
    teamFormationStatsBySeat: teamFormationEnabled ? options.teamFormationStatsBySeat : undefined,
    leaderDataVersion,
    timerConfig: options.timerConfig,
    steamLobbyLink: options.steamLobbyLink ?? null,
    gameSettings,
  }

  return { matchId, formatId: format.id, seats, config }
}

export function buildTeamFormationPartySeatIndices(seats: readonly DraftSeat[], entries: readonly QueueEntry[]): number[][] {
  const seatIndexByPlayerId = new Map(seats.map((seat, seatIndex) => [seat.playerId, seatIndex]))
  const selected = new Set(seats.map(seat => seat.playerId))
  return buildLobbyPartyPlayerIds(entries, selected)
    .filter(party => party.length > 1)
    .map(party => party.flatMap(playerId => {
      const seatIndex = seatIndexByPlayerId.get(playerId)
      return seatIndex == null ? [] : [seatIndex]
    }))
    .filter(party => party.length > 1)
}

// ── Build seats with team assignment ────────────────────────

export function buildDraftSeats(mode: GameMode, entries: QueueEntry[]): DraftSeat[] {
  if (isTeamMode(mode)) {
    const teams = teamCount(mode, entries.length)
    const playersPerTeam = teamSize(mode, entries.length) ?? 1
    const seats: DraftSeat[] = []

    for (let position = 0; position < playersPerTeam; position++) {
      for (let team = 0; team < teams; team++) {
        const entry = entries[team * playersPerTeam + position]
        if (!entry) continue
        seats.push({
          playerId: entry.playerId,
          displayName: entry.displayName,
          avatarUrl: entry.avatarUrl ?? null,
          ...(entry.sourceGuild ? { sourceGuild: entry.sourceGuild } : {}),
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
      ...(e.sourceGuild ? { sourceGuild: e.sourceGuild } : {}),
      team: slotToTeamIndex(mode, i, entries.length) ?? undefined,
    }))
  }

  return entries.map(e => ({
    playerId: e.playerId,
    displayName: e.displayName,
    avatarUrl: e.avatarUrl ?? null,
    ...(e.sourceGuild ? { sourceGuild: e.sourceGuild } : {}),
  }))
}

/** Get the open-lobby ID for a user from the session directory. */
export async function getLobbyForUser(
  db: Database,
  userId: string,
): Promise<string | null> {
  return (await getOpenActivitySessionsForUser(db, userId))
    .find(session => session.phase === 'open')
    ?.sessionId ?? null
}

/** Get a unique active match ID for a channel from the session directory. */
export async function getMatchForChannel(
  db: Database,
  channelId: string,
): Promise<string | null> {
  const matchIds = new Set<string>()

  const sessions = await getActivitySessionsByChannel(db, channelId)
  for (const session of sessions) {
    if (session.phase !== 'draft' && session.phase !== 'swap' && session.phase !== 'active') continue
    matchIds.add(session.matchId ?? session.sessionId)
    if (matchIds.size > 1) return null
  }

  return [...matchIds][0] ?? null
}

/** Get match ID for a user from persisted match membership and the session directory. */
export async function getMatchForUser(
  db: Database,
  userId: string,
): Promise<string | null> {
  const [active] = await db
    .select({ matchId: matchParticipants.matchId })
    .from(matchParticipants)
    .innerJoin(matches, eq(matchParticipants.matchId, matches.id))
    .where(and(
      eq(matchParticipants.playerId, userId),
      inArray(matches.status, ['drafting', 'active']),
    ))
    .orderBy(desc(matches.createdAt))
    .limit(1)

  if (active?.matchId) return active.matchId

  const session = (await getOpenActivitySessionsForUser(db, userId))
    .find(session => session.phase === 'draft' || session.phase === 'swap') ?? null
  return session ? session.matchId ?? session.sessionId : null
}

/** Get channel ID by match ID from the live session directory. */
export async function getChannelForMatch(
  db: Database,
  matchId: string,
): Promise<string | null> {
  const [row] = await db.select({ channelId: sessionDirectory.channelId })
    .from(sessionDirectory)
    .where(and(
      or(
        eq(sessionDirectory.matchId, matchId),
        eq(sessionDirectory.sessionId, matchId),
      ),
      inArray(sessionDirectory.phase, ['draft', 'swap', 'active']),
    ))
    .orderBy(desc(sessionDirectory.updatedAt))
    .limit(1)

  return row?.channelId ?? null
}
