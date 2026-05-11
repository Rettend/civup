import type { Database } from '@civup/db'
import type { LeaderboardMode } from '@civup/game'
import type { FfaEntry, RatingUpdate, TeamInput } from '@civup/rating'
import type { LeaderboardModeSnapshot } from '../leaderboard/snapshot.ts'
import type { ParticipantRow, ReportInput, ReportResult } from './types.ts'
import { matchBans, matches, matchParticipants, playerRatingEvents, playerRatings, players } from '@civup/db'
import { allFactionIds, allLeaderIds, isTeamMode } from '@civup/game'
import { calculateRatings, createRating, IMPORTED_GAME_EFFECTIVE_WEIGHT } from '@civup/rating'
import { and, eq, inArray } from 'drizzle-orm'
import { getSessionRecord, runSessionTerminalLifecycleCommand } from '../../session-runtime/session-do-client.ts'
import { reconcileCivLeaderboardMatchContribution } from '../leaderboard/civ-snapshot.ts'
import { getStoredLeaderboardModeSnapshot, rebuildLeaderboardModeSnapshot } from '../leaderboard/snapshot.ts'
import { getCurrentRankAssignments } from '../ranked/role-sync.ts'
import { getCompletedAtFromDraftData, getDraftStateFromDraftData, getHiddenDraftFromDraftData, getRedDeathFromDraftData, getStoredGameModeContext } from './draft-data.ts'
import { parseOrderedParticipantIds, parseOrderedTeamIndexes, parsePermanentAllyFfaPlacements, resolveWinningTeamIndex } from './placements.ts'
import { buildPermanentAllyFfaEffectiveRows, buildPermanentAllyFfaPlacementByPlayerId, calculatePermanentAllyFfaRatingUpdates } from './permanent-ally.ts'
import { hydrateModeRatingSnapshotsFromEvents } from './rating-events.ts'
import { buildRankByPlayer, recalculateGlobalRatings, recalculateLeaderboardMode } from './ratings.ts'

interface ReportMatchOptions {
  sessionNamespace?: DurableObjectNamespace | null
  allowDirectTerminalWriteForTests?: boolean
  rankedRoleGuildId?: string | null
}

interface RatedReportMatchContext {
  id: string
  gameMode: string
  draftData: string | null
  isOld: boolean
  createdAt: number
}

type RatingScope = LeaderboardMode | typeof GLOBAL_RATING_SCOPE

interface StoredRatingSummaryRow {
  playerId: string
  mode: RatingScope
  mu: number
  sigma: number
  gamesPlayed: number
  wins: number
  lastPlayedAt: number | null
  importedGames: number
  effectiveGames: number
  winsVsTier1: number
  winsVsTier2Plus: number
  effectiveWinsVsTier1: number
  effectiveWinsVsTier2Plus: number
  updatedAt: number | null
}

interface MatchEvidenceDelta {
  importedGames: number
  effectiveGames: number
  winsVsTier1: number
  winsVsTier2Plus: number
  effectiveWinsVsTier1: number
  effectiveWinsVsTier2Plus: number
}

interface RatingScopeUpdateInput {
  scope: RatingScope
  match: RatedReportMatchContext
  gameMode: string
  permanentAlly: boolean
  participantRows: ParticipantRow[]
  existingRatingsByPlayerId: Map<string, StoredRatingSummaryRow>
  evidenceByPlayerId: Map<string, MatchEvidenceDelta>
  now: number
  writeParticipantSnapshots: boolean
}

const GLOBAL_RATING_SCOPE = 'global'

interface RatingState {
  mu: number
  sigma: number
}

export async function reportMatch(
  db: Database,
  kv: KVNamespace,
  input: ReportInput,
  options: ReportMatchOptions = {},
): Promise<ReportResult> {
  const [match] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, input.matchId))
    .limit(1)

  if (!match) {
    return { error: `Match **${input.matchId}** not found.` }
  }

  const participantRows = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, input.matchId))

  const isParticipant = participantRows.some(p => p.playerId === input.reporterId)
  if (!isParticipant) {
    return { error: 'Only match participants can report results.' }
  }

  if (match.status === 'active' && getCompletedAtFromDraftData(match.draftData) == null) {
    return { error: `Match **${input.matchId}** is not ready to report until the draft is complete.` }
  }

  if (match.status === 'completed') {
    const sessionValidationError = await validateReportableSession(options, input.matchId)
    if (sessionValidationError) return { error: sessionValidationError }

    const repaired = await repairCompletedReportedMatch(db, kv, match, participantRows, options)
    if (repaired) return repaired

    const cleanupError = await ensureReportedMatchCleanup(db, options, input.matchId, Date.now(), null, false)
    if (cleanupError) return { error: cleanupError }
    await reconcileCivLeaderboardMatchContribution(db, input.matchId)
    return { match, participants: await hydrateParticipantRowsForRatingEvents(db, match, participantRows), idempotent: true }
  }

  if (match.status !== 'active') {
    return { error: `Match **${input.matchId}** is not active (status: ${match.status}).` }
  }

  const gameContext = getStoredGameModeContext(match.gameMode, match.draftData)
  if (!gameContext) {
    return { error: `Match **${input.matchId}** has unsupported game mode: ${match.gameMode}.` }
  }

  const gameMode = gameContext.mode
  const sessionValidationError = await validateReportableSession(options, input.matchId)
  if (sessionValidationError) return { error: sessionValidationError }
  if (await isSessionAlreadyReported(options, input.matchId)) {
    const cleanupError = await ensureReportedMatchCleanup(db, options, input.matchId, Date.now(), null, false)
    if (cleanupError) return { error: cleanupError }

    const [updatedMatch] = await db.select().from(matches).where(eq(matches.id, input.matchId)).limit(1)
    const updatedParticipants = await db.select().from(matchParticipants).where(eq(matchParticipants.matchId, input.matchId))
    await reconcileCivLeaderboardMatchContribution(db, input.matchId)
    return { match: updatedMatch ?? match, participants: await hydrateParticipantRowsForRatingEvents(db, updatedMatch ?? match, updatedParticipants), idempotent: true }
  }

  const hiddenLeaderAssignments = getHiddenDraftFromDraftData(match.draftData)
    ? validateHiddenDraftLeaderAssignments(match.draftData, participantRows, input.leaderAssignments)
    : null
  if (hiddenLeaderAssignments && 'error' in hiddenLeaderAssignments) return hiddenLeaderAssignments

  if (gameContext.permanentAlly && gameMode === 'ffa') {
    const parsedPlacements = parsePermanentAllyFfaPlacements(input.placements, participantRows)
    if ('error' in parsedPlacements) return parsedPlacements

    for (const participant of participantRows) {
      const placement = parsedPlacements.placementsByPlayer.get(participant.playerId)
      if (placement == null) return { error: `Permanent Ally FFA placement missing for <@${participant.playerId}>.` }
      await db
        .update(matchParticipants)
        .set({ placement })
        .where(
          and(
            eq(matchParticipants.matchId, input.matchId),
            eq(matchParticipants.playerId, participant.playerId),
          ),
        )
    }
  }
  else if (isTeamMode(gameMode) || gameMode === '1v1') {
    const uniqueTeams = new Set(participantRows.flatMap(participant => participant.team == null ? [] : [participant.team]))
    if (uniqueTeams.size > 2) {
      const parsedTeams = parseOrderedTeamIndexes(input.placements, participantRows)
      if ('error' in parsedTeams) return parsedTeams

      for (let index = 0; index < parsedTeams.orderedTeams.length; index++) {
        const teamIndex = parsedTeams.orderedTeams[index]!
        await db
          .update(matchParticipants)
          .set({ placement: index + 1 })
          .where(
            and(
              eq(matchParticipants.matchId, input.matchId),
              eq(matchParticipants.team, teamIndex),
            ),
          )
      }

      const remainingTeams = [...uniqueTeams].filter(teamIndex => !parsedTeams.orderedTeams.includes(teamIndex))
      let nextPlacement = parsedTeams.orderedTeams.length + 1
      for (const teamIndex of remainingTeams) {
        await db
          .update(matchParticipants)
          .set({ placement: nextPlacement })
          .where(
            and(
              eq(matchParticipants.matchId, input.matchId),
              eq(matchParticipants.team, teamIndex),
            ),
          )
        nextPlacement += 1
      }
    }
    else {
      const resolvedTeam = resolveWinningTeamIndex(input.placements, participantRows)
      if ('error' in resolvedTeam) return resolvedTeam

      const winTeamIdx = resolvedTeam.winningTeamIndex

      for (const participant of participantRows) {
        const placement = participant.team === winTeamIdx ? 1 : 2
        await db
          .update(matchParticipants)
          .set({ placement })
          .where(
            and(
              eq(matchParticipants.matchId, input.matchId),
              eq(matchParticipants.playerId, participant.playerId),
            ),
          )
      }
    }
  }
  else {
    const parsedOrder = parseOrderedParticipantIds(input.placements, participantRows)
    if ('error' in parsedOrder) return parsedOrder
    const placementIds = parsedOrder.orderedIds

    for (let index = 0; index < placementIds.length; index++) {
      const playerId = placementIds[index]!
      await db
        .update(matchParticipants)
        .set({ placement: index + 1 })
        .where(
          and(
            eq(matchParticipants.matchId, input.matchId),
            eq(matchParticipants.playerId, playerId),
          ),
        )
    }

    const mentionedIds = new Set(placementIds)
    const unplaced = participantRows.filter(participant => !mentionedIds.has(participant.playerId))
    const lastPlace = placementIds.length + 1
    for (const participant of unplaced) {
      await db
        .update(matchParticipants)
        .set({ placement: lastPlace })
        .where(
          and(
            eq(matchParticipants.matchId, input.matchId),
            eq(matchParticipants.playerId, participant.playerId),
          ),
        )
    }
  }

  if (hiddenLeaderAssignments) {
    await applyHiddenDraftLeaderAssignments(db, input.matchId, hiddenLeaderAssignments.assignments)
  }

  const updatedParticipants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, input.matchId))

  if (updatedParticipants.some(participant => participant.placement === null)) {
    return { error: 'Could not resolve placements for all participants.' }
  }

  const finalized = await finalizeReportedMatch(db, kv, match, updatedParticipants, participantRows, input.reporterId, options)
  if ('error' in finalized) {
    return finalized
  }

  return finalized
}

function validateHiddenDraftLeaderAssignments(
  draftData: string | null,
  participantRows: ParticipantRow[],
  input: Record<string, string> | undefined,
): { assignments: Map<string, string> } | { error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: 'Hidden draft reports require leader assignments for every participant.' }
  }

  const participantIds = new Set(participantRows.map(participant => participant.playerId))
  const assignments = new Map<string, string>()
  for (const [playerId, civId] of Object.entries(input)) {
    if (!participantIds.has(playerId)) {
      return { error: `Leader assignment references an unknown participant: **${playerId}**.` }
    }
    if (typeof civId !== 'string' || civId.trim().length === 0) {
      return { error: `Leader assignment for **${playerId}** is missing a leader.` }
    }
    assignments.set(playerId, civId.trim())
  }

  for (const participant of participantRows) {
    if (!assignments.has(participant.playerId)) {
      return { error: 'Hidden draft reports require leader assignments for every participant.' }
    }
  }

  const draftState = getDraftStateFromDraftData(draftData)
  const validCivIds = new Set(getRedDeathFromDraftData(draftData) ? allFactionIds : allLeaderIds)
  for (const civId of draftState?.availableCivIds ?? []) validCivIds.add(civId)
  for (const ban of draftState?.bans ?? []) validCivIds.add(ban.civId)
  for (const pick of draftState?.picks ?? []) validCivIds.add(pick.civId)

  const assignedCivIds = [...assignments.values()]
  for (const civId of assignedCivIds) {
    if (!validCivIds.has(civId)) return { error: `Unknown leader assignment: **${civId}**.` }
  }

  if (draftState?.duplicateFactions !== true && new Set(assignedCivIds).size !== assignedCivIds.length) {
    return { error: 'Leader assignments must be unique for this match.' }
  }

  return { assignments }
}

async function applyHiddenDraftLeaderAssignments(
  db: Database,
  matchId: string,
  assignments: Map<string, string>,
): Promise<void> {
  for (const [playerId, civId] of assignments) {
    await db
      .update(matchParticipants)
      .set({ civId })
      .where(and(
        eq(matchParticipants.matchId, matchId),
        eq(matchParticipants.playerId, playerId),
      ))
  }
}

async function finalizeReportedMatch(
  db: Database,
  kv: KVNamespace,
  match: RatedReportMatchContext,
  participantRows: ParticipantRow[],
  originalParticipantRows: ParticipantRow[],
  reporterId: string,
  options: ReportMatchOptions,
): Promise<ReportResult> {
  const matchId = match.id
  const gameContext = getStoredGameModeContext(match.gameMode, match.draftData)
  if (!gameContext) return { error: `Match **${match.id}** has unsupported game mode: ${match.gameMode}.` }

  const leaderboardMode = gameContext.leaderboardMode
  if (leaderboardMode == null) {
    return finalizeReportedUnrankedMatch(db, match, originalParticipantRows, reporterId, options)
  }

  const sessionValidationError = await validateReportableSession(options, matchId)
  if (sessionValidationError) return { error: sessionValidationError }

  const cachedLeaderboardSnapshot = await getStoredLeaderboardModeSnapshot(kv, leaderboardMode)
  const beforeRankByPlayer = buildCachedRankByPlayer(cachedLeaderboardSnapshot, leaderboardMode)
  const existingRatingsByScope = await listPlayerRatingsForPlayers(
    db,
    [leaderboardMode, GLOBAL_RATING_SCOPE],
    participantRows.map(participant => participant.playerId),
  )

  const now = Date.now()

  for (const participant of participantRows) {
    await db
      .insert(players)
      .values({
        id: participant.playerId,
        displayName: participant.playerId,
        createdAt: now,
      })
      .onConflictDoNothing()
  }

  const applied = await applyIncrementalRatedReport(
    db,
    kv,
    options.rankedRoleGuildId,
    match,
    gameContext.mode,
    gameContext.permanentAlly,
    leaderboardMode,
    participantRows,
    existingRatingsByScope,
    now,
  )
  if (applied) return { error: applied }

  const cleanupError = await ensureReportedMatchCleanup(db, options, matchId, now, reporterId, true)
  if (cleanupError) {
    const rollbackError = await rollbackPreparedReportAfterLifecycleFailure(db, kv, options, match, leaderboardMode, originalParticipantRows)
    if (rollbackError) return { error: `${cleanupError} Automatic rollback also failed: ${rollbackError}` }
    return { error: cleanupError }
  }

  await reconcileCivLeaderboardMatchContribution(db, matchId)

  const [updatedMatch] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, matchId))
    .limit(1)

  const updatedParticipants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, matchId))

  const updatedRatingsByPlayerId = cachedLeaderboardSnapshot
    ? await listPlayerRatingsForPlayers(db, leaderboardMode, updatedParticipants.map(participant => participant.playerId))
    : new Map<RatingScope, Map<string, StoredRatingSummaryRow>>()
  const afterRankContext = buildCachedRankContext(cachedLeaderboardSnapshot, leaderboardMode, updatedRatingsByPlayerId.get(leaderboardMode) ?? new Map())

  const participantsWithLeaderboardRanks: ParticipantRow[] = updatedParticipants.map(participant => ({
    ...participant,
    leaderboardBeforeRank: beforeRankByPlayer.get(participant.playerId) ?? null,
    leaderboardAfterRank: afterRankContext?.rankByPlayer.get(participant.playerId) ?? null,
    leaderboardEligibleCount: afterRankContext?.eligibleCount ?? null,
  }))

  return { match: updatedMatch!, participants: await hydrateParticipantRowsForRatingEvents(db, updatedMatch!, participantsWithLeaderboardRanks) }
}

async function hydrateParticipantRowsForRatingEvents<T extends ParticipantRow>(
  db: Database,
  match: { gameMode: string, draftData: string | null },
  participants: readonly T[],
): Promise<T[]> {
  const hydrated = await hydrateModeRatingSnapshotsFromEvents(db, participants.map(participant => ({
    ...participant,
    gameMode: match.gameMode,
    draftData: match.draftData,
  })))
  return hydrated.map((row, index) => ({
    ...participants[index]!,
    ratingBeforeMu: row.ratingBeforeMu,
    ratingBeforeSigma: row.ratingBeforeSigma,
    ratingAfterMu: row.ratingAfterMu,
    ratingAfterSigma: row.ratingAfterSigma,
  }))
}

function buildCachedRankByPlayer(
  snapshot: LeaderboardModeSnapshot | null,
  leaderboardMode: LeaderboardMode,
): Map<string, number> {
  return snapshot ? buildRankByPlayer(snapshot.rows, leaderboardMode) : new Map()
}

function buildCachedRankContext(
  snapshot: LeaderboardModeSnapshot | null,
  leaderboardMode: LeaderboardMode,
  updatedRatingsByPlayerId: Map<string, StoredRatingSummaryRow>,
): { rankByPlayer: Map<string, number>, eligibleCount: number } | null {
  if (!snapshot) return null

  const rowsByPlayerId = new Map(snapshot.rows.map(row => [row.playerId, row]))
  for (const [playerId, rating] of updatedRatingsByPlayerId) {
    rowsByPlayerId.set(playerId, {
      playerId,
      mode: leaderboardMode,
      mu: rating.mu,
      sigma: rating.sigma,
      gamesPlayed: rating.gamesPlayed,
      wins: rating.wins,
      lastPlayedAt: rating.lastPlayedAt,
    })
  }

  const rankByPlayer = buildRankByPlayer([...rowsByPlayerId.values()], leaderboardMode)
  return { rankByPlayer, eligibleCount: rankByPlayer.size }
}

async function listPlayerRatingsForPlayers(
  db: Database,
  scopes: RatingScope | readonly RatingScope[],
  playerIds: readonly string[],
): Promise<Map<RatingScope, Map<string, StoredRatingSummaryRow>>> {
  const uniquePlayerIds = [...new Set(playerIds.filter(playerId => playerId.length > 0))]
  const requestedScopes = [...new Set((Array.isArray(scopes) ? scopes : [scopes]).filter(scope => scope.length > 0))]
  if (uniquePlayerIds.length === 0 || requestedScopes.length === 0) return new Map()

  const rows = await db
    .select({
      mode: playerRatings.mode,
      playerId: playerRatings.playerId,
      mu: playerRatings.mu,
      sigma: playerRatings.sigma,
      gamesPlayed: playerRatings.gamesPlayed,
      wins: playerRatings.wins,
      importedGames: playerRatings.importedGames,
      effectiveGames: playerRatings.effectiveGames,
      winsVsTier1: playerRatings.winsVsTier1,
      winsVsTier2Plus: playerRatings.winsVsTier2Plus,
      effectiveWinsVsTier1: playerRatings.effectiveWinsVsTier1,
      effectiveWinsVsTier2Plus: playerRatings.effectiveWinsVsTier2Plus,
      lastPlayedAt: playerRatings.lastPlayedAt,
      updatedAt: playerRatings.updatedAt,
    })
    .from(playerRatings)
    .where(and(
      inArray(playerRatings.mode, requestedScopes),
      inArray(playerRatings.playerId, uniquePlayerIds),
    ))

  const byScope = new Map<RatingScope, Map<string, StoredRatingSummaryRow>>(requestedScopes.map(scope => [scope, new Map()]))
  for (const row of rows) {
    if (!requestedScopes.includes(row.mode as RatingScope)) continue
    const scope = row.mode as RatingScope
    byScope.get(scope)?.set(row.playerId, {
      mode: scope,
      playerId: row.playerId,
      mu: row.mu,
      sigma: row.sigma,
      gamesPlayed: row.gamesPlayed,
      wins: row.wins,
      importedGames: row.importedGames,
      effectiveGames: row.effectiveGames,
      winsVsTier1: row.winsVsTier1,
      winsVsTier2Plus: row.winsVsTier2Plus,
      effectiveWinsVsTier1: row.effectiveWinsVsTier1,
      effectiveWinsVsTier2Plus: row.effectiveWinsVsTier2Plus,
      lastPlayedAt: row.lastPlayedAt ?? null,
      updatedAt: row.updatedAt ?? null,
    })
  }

  return byScope
}

async function applyIncrementalRatedReport(
  db: Database,
  kv: KVNamespace,
  rankedRoleGuildId: string | null | undefined,
  match: RatedReportMatchContext,
  gameMode: string,
  permanentAlly: boolean,
  leaderboardMode: LeaderboardMode,
  participantRows: ParticipantRow[],
  existingRatingsByScope: Map<RatingScope, Map<string, StoredRatingSummaryRow>>,
  now: number,
): Promise<string | null> {
  const opponentTierByPlayerId = await loadCurrentRankedRoleTierByPlayerId(kv, rankedRoleGuildId)
  const evidenceByPlayerId = buildMatchEvidenceByPlayerId(participantRows, match.isOld, opponentTierByPlayerId, permanentAlly)
  const modeResult = await applyRatingScopeUpdate(db, {
    scope: leaderboardMode,
    match,
    gameMode,
    permanentAlly,
    participantRows,
    existingRatingsByPlayerId: existingRatingsByScope.get(leaderboardMode) ?? new Map(),
    evidenceByPlayerId,
    now,
    writeParticipantSnapshots: true,
  })
  if (modeResult) return modeResult

  return applyRatingScopeUpdate(db, {
    scope: GLOBAL_RATING_SCOPE,
    match,
    gameMode,
    permanentAlly,
    participantRows,
    existingRatingsByPlayerId: existingRatingsByScope.get(GLOBAL_RATING_SCOPE) ?? new Map(),
    evidenceByPlayerId,
    now,
    writeParticipantSnapshots: false,
  })
}

async function applyRatingScopeUpdate(
  db: Database,
  input: RatingScopeUpdateInput,
): Promise<string | null> {
  const placementByPlayerId = input.permanentAlly && input.gameMode === 'ffa'
    ? buildPermanentAllyFfaPlacementByPlayerId(input.participantRows)
    : new Map(input.participantRows.map(participant => [participant.playerId, participant.placement]))
  if ('error' in placementByPlayerId) return placementByPlayerId.error
  const playerRatingMap = new Map<string, { mu: number, sigma: number }>()

  for (const participant of input.participantRows) {
    const existing = input.existingRatingsByPlayerId.get(participant.playerId)
    if (existing) {
      playerRatingMap.set(participant.playerId, { mu: existing.mu, sigma: existing.sigma })
    }
    else {
      const fresh = createRating(participant.playerId)
      playerRatingMap.set(participant.playerId, { mu: fresh.mu, sigma: fresh.sigma })
    }
  }

  let ratingUpdates: RatingUpdate[]

  if (input.permanentAlly && input.gameMode === 'ffa') {
    const updates = calculatePermanentAllyFfaRatingUpdates(input.participantRows, (playerId) => {
      const rating = playerRatingMap.get(playerId)
      if (!rating) throw new Error(`Missing rating state for ${playerId}`)
      return rating
    })
    if ('error' in updates) return updates.error
    ratingUpdates = updates
  }
  else if (isTeamMode(input.gameMode as Parameters<typeof isTeamMode>[0]) || input.gameMode === '1v1') {
    const teams = new Map<number, { playerId: string, mu: number, sigma: number }[]>()
    for (const participant of input.participantRows) {
      const team = participant.team ?? 0
      if (!teams.has(team)) teams.set(team, [])
      const rating = playerRatingMap.get(participant.playerId)
      if (!rating) return `Missing rating state for **${participant.playerId}**.`
      teams.get(team)?.push({ playerId: participant.playerId, mu: rating.mu, sigma: rating.sigma })
    }

    const teamEntries = [...teams.entries()].sort((a, b) => {
      const aPlacement = input.participantRows.find(participant => participant.team === a[0])?.placement ?? 99
      const bPlacement = input.participantRows.find(participant => participant.team === b[0])?.placement ?? 99
      return aPlacement - bPlacement
    })

    const teamInputs: TeamInput[] = teamEntries.map(([, players]) => ({
      players: players.map(player => ({ playerId: player.playerId, mu: player.mu, sigma: player.sigma })),
    }))

    ratingUpdates = calculateRatings({ type: 'team', teams: teamInputs })
  }
  else {
    const ffaEntries: FfaEntry[] = input.participantRows.map((participant) => {
      const rating = playerRatingMap.get(participant.playerId)
      if (!rating) throw new Error(`Missing rating state for ${participant.playerId}`)
      return {
        player: { playerId: participant.playerId, mu: rating.mu, sigma: rating.sigma },
        placement: participant.placement!,
      }
    })

    ratingUpdates = calculateRatings({ type: 'ffa', entries: ffaEntries })
  }

  for (const update of ratingUpdates) {
    const ratingBeforeMu = update.before.mu
    const ratingAfter = scaleRatingAfterForSource(update, input.match.isOld ? IMPORTED_GAME_EFFECTIVE_WEIGHT : 1)
    const ratingAfterMu = ratingAfter.mu
    const ratingAfterSigma = ratingAfter.sigma

    if (input.writeParticipantSnapshots) {
      await db
        .update(matchParticipants)
        .set({
          ratingBeforeMu,
          ratingBeforeSigma: update.before.sigma,
          ratingAfterMu,
          ratingAfterSigma,
        })
        .where(and(
          eq(matchParticipants.matchId, input.match.id),
          eq(matchParticipants.playerId, update.playerId),
        ))
    }

    const existing = input.existingRatingsByPlayerId.get(update.playerId)
    const isWin = placementByPlayerId.get(update.playerId) === 1
    const evidence = input.evidenceByPlayerId.get(update.playerId) ?? createEmptyMatchEvidenceDelta()
    const qualityWins = input.scope === GLOBAL_RATING_SCOPE
      ? evidence
      : createEmptyMatchEvidenceDelta()
    const row = {
      playerId: update.playerId,
      mode: input.scope,
      mu: ratingAfterMu,
      sigma: ratingAfterSigma,
      gamesPlayed: (existing?.gamesPlayed ?? 0) + 1,
      wins: (existing?.wins ?? 0) + (isWin ? 1 : 0),
      importedGames: (existing?.importedGames ?? 0) + evidence.importedGames,
      effectiveGames: (existing?.effectiveGames ?? 0) + evidence.effectiveGames,
      winsVsTier1: (existing?.winsVsTier1 ?? 0) + qualityWins.winsVsTier1,
      winsVsTier2Plus: (existing?.winsVsTier2Plus ?? 0) + qualityWins.winsVsTier2Plus,
      effectiveWinsVsTier1: (existing?.effectiveWinsVsTier1 ?? 0) + qualityWins.effectiveWinsVsTier1,
      effectiveWinsVsTier2Plus: (existing?.effectiveWinsVsTier2Plus ?? 0) + qualityWins.effectiveWinsVsTier2Plus,
      lastPlayedAt: input.match.isOld ? (existing?.lastPlayedAt ?? null) : input.now,
      updatedAt: input.now,
    }
    const eventRow = {
      matchId: input.match.id,
      playerId: update.playerId,
      mode: input.scope,
      gameMode: input.match.gameMode,
      ratingBeforeMu,
      ratingBeforeSigma: update.before.sigma,
      ratingAfterMu,
      ratingAfterSigma,
      gamesDelta: 1,
      winsDelta: isWin ? 1 : 0,
      importedGamesDelta: evidence.importedGames,
      effectiveGamesDelta: evidence.effectiveGames,
      winsVsTier1Delta: qualityWins.winsVsTier1,
      winsVsTier2PlusDelta: qualityWins.winsVsTier2Plus,
      effectiveWinsVsTier1Delta: qualityWins.effectiveWinsVsTier1,
      effectiveWinsVsTier2PlusDelta: qualityWins.effectiveWinsVsTier2Plus,
      matchCreatedAt: input.match.createdAt,
      matchCompletedAt: input.match.isOld ? input.match.createdAt : input.now,
      updatedAt: input.now,
    }

    await db.insert(playerRatings).values(row).onConflictDoUpdate({
      target: [playerRatings.playerId, playerRatings.mode],
      set: row,
    })
    await db.insert(playerRatingEvents).values(eventRow).onConflictDoUpdate({
      target: [playerRatingEvents.matchId, playerRatingEvents.playerId, playerRatingEvents.mode],
      set: eventRow,
    })
  }

  return null
}

function scaleRatingAfterForSource(update: ReturnType<typeof calculateRatings>[number], sourceWeight: number): { mu: number, sigma: number } {
  if (sourceWeight >= 1) return update.after
  return {
    mu: update.before.mu + ((update.after.mu - update.before.mu) * sourceWeight),
    sigma: update.before.sigma + ((update.after.sigma - update.before.sigma) * sourceWeight),
  }
}

function buildMatchEvidenceByPlayerId(
  participantRows: ParticipantRow[],
  isOld: boolean,
  opponentTierByPlayerId: ReadonlyMap<string, string>,
  permanentAlly = false,
): Map<string, MatchEvidenceDelta> {
  const sourceWeight = isOld ? IMPORTED_GAME_EFFECTIVE_WEIGHT : 1
  const effectiveRows = permanentAlly ? buildPermanentAllyFfaEffectiveRows(participantRows) : participantRows
  const evidenceRows = 'error' in effectiveRows ? participantRows : effectiveRows
  return new Map(evidenceRows.map((participant) => {
    const qualityWins = countQualityWinsForParticipant(participant, evidenceRows, opponentTierByPlayerId, sourceWeight)
    return [participant.playerId, {
      importedGames: isOld ? 1 : 0,
      effectiveGames: sourceWeight,
      winsVsTier1: qualityWins.winsVsTier1,
      winsVsTier2Plus: qualityWins.winsVsTier2Plus,
      effectiveWinsVsTier1: qualityWins.effectiveWinsVsTier1,
      effectiveWinsVsTier2Plus: qualityWins.effectiveWinsVsTier2Plus,
    }]
  }))
}

function createEmptyMatchEvidenceDelta(): MatchEvidenceDelta {
  return {
    importedGames: 0,
    effectiveGames: 0,
    winsVsTier1: 0,
    winsVsTier2Plus: 0,
    effectiveWinsVsTier1: 0,
    effectiveWinsVsTier2Plus: 0,
  }
}

function countQualityWinsForParticipant(
  participant: Pick<ParticipantRow, 'playerId' | 'team' | 'placement'>,
  participantRows: Array<Pick<ParticipantRow, 'playerId' | 'team' | 'placement'>>,
  opponentTierByPlayerId: ReadonlyMap<string, string>,
  sourceWeight = 1,
): { winsVsTier1: number, winsVsTier2Plus: number, effectiveWinsVsTier1: number, effectiveWinsVsTier2Plus: number } {
  let winsVsTier1 = 0
  let winsVsTier2Plus = 0
  let effectiveWinsVsTier1 = 0
  let effectiveWinsVsTier2Plus = 0
  const effectiveWinCredit = sourceWeight / participantTeamSize(participant, participantRows)

  for (const opponent of participantRows) {
    if (!didDefeatOpponent(participant, opponent)) continue
    const opponentTierNumber = rankedRoleTierNumber(opponentTierByPlayerId.get(opponent.playerId) ?? null)
    if (opponentTierNumber == null) continue
    if (opponentTierNumber <= 1) {
      winsVsTier1 += 1
      effectiveWinsVsTier1 += effectiveWinCredit
    }
    if (opponentTierNumber <= 2) {
      winsVsTier2Plus += 1
      effectiveWinsVsTier2Plus += effectiveWinCredit
    }
  }

  return { winsVsTier1, winsVsTier2Plus, effectiveWinsVsTier1, effectiveWinsVsTier2Plus }
}

function participantTeamSize(
  participant: Pick<ParticipantRow, 'playerId' | 'team'>,
  participantRows: Array<Pick<ParticipantRow, 'playerId' | 'team'>>,
): number {
  if (participant.team == null) return 1
  return Math.max(1, participantRows.filter(row => row.team === participant.team).length)
}

function didDefeatOpponent(
  participant: Pick<ParticipantRow, 'playerId' | 'team' | 'placement'>,
  opponent: Pick<ParticipantRow, 'playerId' | 'team' | 'placement'>,
): boolean {
  if (participant.playerId === opponent.playerId) return false
  if (participant.team != null && opponent.team != null && participant.team === opponent.team) return false
  if (participant.placement == null || opponent.placement == null) return false
  return participant.placement < opponent.placement
}

async function loadCurrentRankedRoleTierByPlayerId(kv: KVNamespace, guildId: string | null | undefined): Promise<Map<string, string>> {
  if (!guildId) return new Map()
  const assignments = await getCurrentRankAssignments(kv, guildId)
  return new Map(Object.entries(assignments.byPlayerId).map(([playerId, assignment]) => [playerId, assignment.tier]))
}

function rankedRoleTierNumber(tier: string | null): number | null {
  if (!tier) return null
  const match = /^tier(\d+)$/i.exec(tier.trim())
  if (!match) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? Math.round(value) : null
}

async function repairCompletedReportedMatch(
  db: Database,
  kv: KVNamespace,
  match: { id: string, gameMode: string, draftData: string | null },
  participantRows: ParticipantRow[],
  options: ReportMatchOptions = {},
): Promise<ReportResult | null> {
  if (!hasMissingRatingSnapshots(participantRows)) return null

  const gameContext = getStoredGameModeContext(match.gameMode, match.draftData)
  if (!gameContext) return { error: `Match **${match.id}** has unsupported game mode: ${match.gameMode}.` }
  if (gameContext.leaderboardMode == null) return null

  console.error(`Repairing incomplete reported match ${match.id}.`)

  const recalculated = await recalculateLeaderboardMode(db, gameContext.leaderboardMode, {
    fromMatchId: match.id,
    includeFromMatch: true,
  })
  if ('error' in recalculated) return recalculated
  const recalculatedGlobal = await recalculateGlobalRatings(db, {
    fromMatchId: match.id,
    includeFromMatch: true,
    opponentTierByPlayerId: await loadCurrentRankedRoleTierByPlayerId(kv, options.rankedRoleGuildId),
  })
  if ('error' in recalculatedGlobal) return recalculatedGlobal

  await rebuildLeaderboardModeSnapshot(db, kv, gameContext.leaderboardMode)

  const [updatedMatch] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, match.id))
    .limit(1)
  if (!updatedMatch) return { error: `Match **${match.id}** not found after repair.` }

  const updatedParticipants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, match.id))

  const cleanupError = await ensureReportedMatchCleanup(db, options, match.id, Date.now(), null, false)
  if (cleanupError) return { error: cleanupError }
  await reconcileCivLeaderboardMatchContribution(db, match.id)
  return { match: updatedMatch, participants: await hydrateParticipantRowsForRatingEvents(db, updatedMatch, updatedParticipants), idempotent: true }
}

function hasMissingRatingSnapshots(participantRows: ParticipantRow[]): boolean {
  return participantRows.some(participant => (
    participant.ratingBeforeMu == null
    || participant.ratingBeforeSigma == null
    || participant.ratingAfterMu == null
    || participant.ratingAfterSigma == null
  ))
}

async function ensureReportedMatchCleanup(
  db: Database,
  options: ReportMatchOptions,
  matchId: string,
  reportedAt = Date.now(),
  reportedById: string | null = null,
  updateMatch = true,
): Promise<string | null> {
  const { sessionNamespace } = options
  if (sessionNamespace) {
    try {
      await runSessionTerminalLifecycleCommand(sessionNamespace, matchId, { type: 'mark-reported', matchId, at: reportedAt, reportedById })
    }
    catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
    return null
  }

  if (!options.allowDirectTerminalWriteForTests) {
    return 'SessionDO binding is required to finalize reported match state.'
  }

  if (updateMatch) {
    const values: { status: string, completedAt: number, draftData?: string | null } = {
      status: 'completed',
      completedAt: reportedAt,
    }
    if (reportedById) {
      const [match] = await db
        .select({ draftData: matches.draftData })
        .from(matches)
        .where(eq(matches.id, matchId))
        .limit(1)
      if (match) values.draftData = setReportedByInDraftData(match.draftData, reportedById)
    }
    await db.update(matches).set(values).where(eq(matches.id, matchId))
  }
  await db.delete(matchBans).where(eq(matchBans.matchId, matchId))
  return null
}

async function validateReportableSession(
  options: ReportMatchOptions,
  matchId: string,
): Promise<string | null> {
  const { sessionNamespace } = options
  if (!sessionNamespace) {
    return options.allowDirectTerminalWriteForTests ? null : 'SessionDO binding is required to validate match lifecycle.'
  }
  try {
    const record = await getSessionRecord(sessionNamespace, matchId)
    if (!record) return `Session **${matchId}** not found.`
    if (record.phase === 'reported') return null
    if (record.phase === 'cancelled') return 'Cancelled sessions cannot be reported'
    if (record.phase !== 'active' && record.phase !== 'swap') return `Session is not reportable (phase: ${record.phase})`
    return null
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function isSessionAlreadyReported(options: ReportMatchOptions, matchId: string): Promise<boolean> {
  if (!options.sessionNamespace) return false
  try {
    return (await getSessionRecord(options.sessionNamespace, matchId))?.phase === 'reported'
  }
  catch {
    return false
  }
}

async function rollbackReportedRatedMatch(
  db: Database,
  kv: KVNamespace,
  options: {
    match: { id: string, draftData: string | null }
    leaderboardMode: LeaderboardMode
    participantRows?: ParticipantRow[]
    rankedRoleGuildId?: string | null
  },
): Promise<string | null> {
  try {
    if (options.participantRows) {
      for (const participant of options.participantRows) {
        await db
          .update(matchParticipants)
          .set({
            civId: participant.civId,
            placement: participant.placement,
            ratingBeforeMu: participant.ratingBeforeMu,
            ratingBeforeSigma: participant.ratingBeforeSigma,
            ratingAfterMu: participant.ratingAfterMu,
            ratingAfterSigma: participant.ratingAfterSigma,
          })
          .where(and(
            eq(matchParticipants.matchId, options.match.id),
            eq(matchParticipants.playerId, participant.playerId),
          ))
      }
    }
    else {
      await db
        .update(matchParticipants)
        .set({
          placement: null,
          ratingBeforeMu: null,
          ratingBeforeSigma: null,
          ratingAfterMu: null,
          ratingAfterSigma: null,
        })
        .where(eq(matchParticipants.matchId, options.match.id))
    }

    await db
      .update(matches)
      .set({
        status: 'active',
        completedAt: null,
        draftData: options.match.draftData,
      })
      .where(eq(matches.id, options.match.id))

    const recalculated = await recalculateLeaderboardMode(db, options.leaderboardMode, {
      fromMatchId: options.match.id,
      includeFromMatch: false,
    })
    if ('error' in recalculated) return recalculated.error
    const recalculatedGlobal = await recalculateGlobalRatings(db, {
      fromMatchId: options.match.id,
      includeFromMatch: false,
      opponentTierByPlayerId: await loadCurrentRankedRoleTierByPlayerId(kv, options.rankedRoleGuildId),
    })
    if ('error' in recalculatedGlobal) return recalculatedGlobal.error

    await rebuildLeaderboardModeSnapshot(db, kv, options.leaderboardMode)
    return null
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function rollbackPreparedReportAfterLifecycleFailure(
  db: Database,
  kv: KVNamespace,
  options: ReportMatchOptions,
  match: { id: string, draftData: string | null },
  leaderboardMode: LeaderboardMode,
  participantRows?: ParticipantRow[],
): Promise<string | null> {
  if (!await shouldRollbackPreparedReportedMatch(options, match.id)) return null
  return rollbackReportedRatedMatch(db, kv, { match, leaderboardMode, participantRows, rankedRoleGuildId: options.rankedRoleGuildId })
}

async function rollbackParticipantRowsAfterLifecycleFailure(
  db: Database,
  options: ReportMatchOptions,
  matchId: string,
  participants: ParticipantRow[],
): Promise<string | null> {
  if (!await shouldRollbackPreparedReportedMatch(options, matchId)) return null
  try {
    for (const participant of participants) {
      await db
        .update(matchParticipants)
        .set({
          civId: participant.civId,
          placement: participant.placement,
          ratingBeforeMu: participant.ratingBeforeMu,
          ratingBeforeSigma: participant.ratingBeforeSigma,
          ratingAfterMu: participant.ratingAfterMu,
          ratingAfterSigma: participant.ratingAfterSigma,
        })
        .where(and(
          eq(matchParticipants.matchId, matchId),
          eq(matchParticipants.playerId, participant.playerId),
        ))
    }
    return null
  }
  catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function shouldRollbackPreparedReportedMatch(options: ReportMatchOptions, matchId: string): Promise<boolean> {
  if (!options.sessionNamespace) return false
  try {
    const record = await getSessionRecord(options.sessionNamespace, matchId)
    if (!record) return false
    return record.phase === 'active' || record.phase === 'swap'
  }
  catch {
    return false
  }
}

async function finalizeReportedUnrankedMatch(
  db: Database,
  match: { id: string, draftData: string | null },
  originalParticipantRows: ParticipantRow[],
  reporterId: string,
  options: ReportMatchOptions,
): Promise<ReportResult> {
  const matchId = match.id
  const now = Date.now()

  const sessionValidationError = await validateReportableSession(options, matchId)
  if (sessionValidationError) return { error: sessionValidationError }

  await db
    .update(matchParticipants)
    .set({
      ratingBeforeMu: null,
      ratingBeforeSigma: null,
      ratingAfterMu: null,
      ratingAfterSigma: null,
    })
    .where(eq(matchParticipants.matchId, matchId))

  const cleanupError = await ensureReportedMatchCleanup(db, options, matchId, now, reporterId, true)
  if (cleanupError) {
    const rollbackError = await rollbackParticipantRowsAfterLifecycleFailure(db, options, matchId, originalParticipantRows)
    if (rollbackError) return { error: `${cleanupError} Automatic rollback also failed: ${rollbackError}` }
    return { error: cleanupError }
  }
  await reconcileCivLeaderboardMatchContribution(db, matchId)

  const [updatedMatch] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, matchId))
    .limit(1)

  const updatedParticipants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, matchId))

  return {
    match: updatedMatch!,
    participants: updatedParticipants.map(participant => ({
      ...participant,
      leaderboardBeforeRank: null,
      leaderboardAfterRank: null,
      leaderboardEligibleCount: null,
    })),
  }
}

function setReportedByInDraftData(draftData: string | null, reporterId: string): string | null {
  const normalizedReporterId = reporterId.trim()
  if (normalizedReporterId.length === 0) return draftData
  if (!draftData) return JSON.stringify({ reportedById: normalizedReporterId })

  try {
    const parsed = JSON.parse(draftData)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return draftData
    return JSON.stringify({
      ...(parsed as Record<string, unknown>),
      reportedById: normalizedReporterId,
    })
  }
  catch {
    return draftData
  }
}
