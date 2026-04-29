import type { Database } from '@civup/db'
import type { DraftSeat, DraftTimerConfig, GameMode, LeaderDataVersion, QueueEntry } from '@civup/game'
import type { DraftRuntimeConfig } from '@civup/session'
import { matches, matchParticipants, sessionDirectory } from '@civup/db'
import { allFactionIds, allLeaderIds, getDraftFormat, isTeamMode, normalizeMapVoteEnabled, requiresRedDeathDuplicateFactions, resolveLeaderPoolSize, sampleLeaderPool, slotToTeamIndex } from '@civup/game'
import { and, desc, eq, inArray, or } from 'drizzle-orm'
import { getActivitySessionsByChannel, getOpenActivitySessionsForUser } from './session-state.ts'

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
  simultaneousPick?: boolean
  redDeath?: boolean
  mapVoteEnabled?: boolean
  randomDraft?: boolean
  hiddenDraft?: boolean
  duplicateFactions?: boolean
  timerConfig?: DraftTimerConfig
  leaderPoolSize?: number | null
  dealOptionsSize?: number | null
  steamLobbyLink?: string | null
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
  const seats: DraftSeat[] = buildSeats(mode, entries)
  const redDeathMode = options.redDeath === true
  const simultaneousPick = mode === 'ffa' && !redDeathMode && options.simultaneousPick === true
  const hiddenDraft = options.hiddenDraft === true
  const randomDraft = !hiddenDraft && options.randomDraft === true
  // Duplicate picks are a general draft-engine capability; only Red Death forces them on.
  const duplicateFactions = redDeathMode
    ? (requiresRedDeathDuplicateFactions(mode) || options.duplicateFactions === true)
    : (options.duplicateFactions === true)
  const mapVoteEnabled = normalizeMapVoteEnabled(mode, options.mapVoteEnabled === true, { redDeath: redDeathMode })
  const format = getDraftFormat(mode, { simultaneousPick, randomDraft, redDeath: redDeathMode, blindBans: options.blindBans, seatCount: seats.length })
  const civPool = redDeathMode
    ? [...allFactionIds]
    : hiddenDraft
      ? [...allLeaderIds]
      : sampleLeaderPool(resolveLeaderPoolSize(mode, seats.length, options.leaderPoolSize))
  const config: DraftRuntimeConfig = {
    matchId,
    hostId: options.hostId,
    formatId: format.id,
    seats,
    civPool,
    dealOptionsSize: redDeathMode ? options.dealOptionsSize ?? undefined : undefined,
    randomDraft,
    hiddenDraft,
    duplicateFactions,
    mapVoteEnabled,
    leaderDataVersion: options.leaderDataVersion ?? 'live',
    timerConfig: options.timerConfig,
    steamLobbyLink: options.steamLobbyLink ?? null,
  }

  return { matchId, formatId: format.id, seats, config }
}

// ── Build seats with team assignment ────────────────────────

function buildSeats(mode: GameMode, entries: QueueEntry[]): DraftSeat[] {
  if (isTeamMode(mode)) {
    return entries.map((entry, index) => ({
      playerId: entry.playerId,
      displayName: entry.displayName,
      avatarUrl: entry.avatarUrl ?? null,
      team: slotToTeamIndex(mode, index, entries.length) ?? undefined,
    }))
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
