import type { Database } from '@civup/db'
import type { LeaderboardMode } from '@civup/game'
import type { FfaEntry, TeamInput } from '@civup/rating'
import type { LeaderboardModeSnapshot, LeaderboardSnapshotRow } from '../leaderboard/snapshot.ts'
import type { ParticipantRow, ReportInput, ReportResult } from './types.ts'
import { matchBans, matches, matchParticipants, playerRatings, playerRatingSeeds, players } from '@civup/db'
import { allFactionIds, allLeaderIds, isTeamMode, leaderboardModesToGameModes } from '@civup/game'
import { calculateRatings, createRating } from '@civup/rating'
import { and, eq, gt, inArray, lt, or, sql } from 'drizzle-orm'
import { getSessionRecord, runSessionTerminalLifecycleCommand } from '../../session-runtime/session-do-client.ts'
import { reconcileCivLeaderboardMatchContribution } from '../leaderboard/civ-snapshot.ts'
import { getStoredLeaderboardModeSnapshot, rebuildLeaderboardModeSnapshot } from '../leaderboard/snapshot.ts'
import { getCompletedAtFromDraftData, getDraftStateFromDraftData, getHiddenDraftFromDraftData, getRedDeathFromDraftData, getStoredGameModeContext } from './draft-data.ts'
import { parseOrderedParticipantIds, parseOrderedTeamIndexes, resolveWinningTeamIndex } from './placements.ts'
import { buildRankByPlayer, calculateSeedFadeStepMu, recalculateLeaderboardMode } from './ratings.ts'

interface ReportMatchOptions {
  sessionNamespace?: DurableObjectNamespace | null
  allowDirectTerminalWriteForTests?: boolean
}

interface RatedReportMatchContext {
  id: string
  gameMode: string
  draftData: string | null
  isOld: boolean
  createdAt: number
}

interface IncrementalSeedFadeContext {
  seedRowsByPlayerId: Map<string, SeedRatingRow>
  priorNewBotGamesByPlayerId: Map<string, number>
  currentMatchCountsAsNewBotGame: boolean
  requiresRecalculation: boolean
}

interface SeedRatingRow {
  playerId: string
  mu: number
  sigma: number
  fadeGamesRemaining: number | null
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
    await reconcileLeaderboardAggregatesForMatch(db, input.matchId)
    return { match, participants: participantRows, idempotent: true }
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
    await reconcileLeaderboardAggregatesForMatch(db, input.matchId)
    return { match: updatedMatch ?? match, participants: updatedParticipants, idempotent: true }
  }

  const hiddenLeaderAssignments = getHiddenDraftFromDraftData(match.draftData)
    ? validateHiddenDraftLeaderAssignments(match.draftData, participantRows, input.leaderAssignments)
    : null
  if (hiddenLeaderAssignments && 'error' in hiddenLeaderAssignments) return hiddenLeaderAssignments

  if (isTeamMode(gameMode) || gameMode === '1v1') {
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
    return await finalizeReportedUnrankedMatch(db, match, originalParticipantRows, reporterId, options)
  }

  const sessionValidationError = await validateReportableSession(options, matchId)
  if (sessionValidationError) return { error: sessionValidationError }

  const cachedLeaderboardSnapshot = await getStoredLeaderboardModeSnapshot(kv, leaderboardMode)
  const beforeRankByPlayer = buildCachedRankByPlayer(cachedLeaderboardSnapshot, leaderboardMode)
  const existingRatingsByPlayerId = await listPlayerRatingsForPlayers(
    db,
    leaderboardMode,
    participantRows.map(participant => participant.playerId),
  )
  const usesLiveSeedFade = await modeUsesLiveSeedFade(db, leaderboardMode)
  const seedFadeContext = usesLiveSeedFade
    ? await buildIncrementalSeedFadeContext(db, leaderboardMode, match, participantRows.map(participant => participant.playerId), existingRatingsByPlayerId)
    : null

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

  if (seedFadeContext?.requiresRecalculation) {
    try {
      const recalculated = await recalculateLeaderboardMode(db, leaderboardMode, {
        fromMatchId: matchId,
        includeFromMatch: true,
        includeActiveBoundary: true,
      })
      if ('error' in recalculated) {
        const rollbackError = await rollbackReportedRatedMatch(db, kv, {
          match,
          leaderboardMode,
          participantRows: originalParticipantRows,
        })
        if (rollbackError) return { error: `${recalculated.error} Automatic rollback also failed: ${rollbackError}` }
        return recalculated
      }
    }
    catch (error) {
      const rollbackError = await rollbackReportedRatedMatch(db, kv, {
        match,
        leaderboardMode,
        participantRows: originalParticipantRows,
      })
      if (rollbackError) {
        console.error(`Failed to roll back reported match ${matchId}:`, rollbackError)
      }
      throw error
    }
  }
  else {
    const applied = await applyIncrementalRatedReport(
      db,
      matchId,
      gameContext.mode,
      leaderboardMode,
      participantRows,
      existingRatingsByPlayerId,
      now,
      seedFadeContext,
    )
    if (applied) return { error: applied }
  }

  const cleanupError = await ensureReportedMatchCleanup(db, options, matchId, now, reporterId, true)
  if (cleanupError) {
    const rollbackError = await rollbackPreparedReportAfterLifecycleFailure(db, kv, options, match, leaderboardMode, originalParticipantRows)
    if (rollbackError) return { error: `${cleanupError} Automatic rollback also failed: ${rollbackError}` }
    return { error: cleanupError }
  }

  await reconcileLeaderboardAggregatesForMatch(db, matchId)

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
    : new Map<string, LeaderboardSnapshotRow>()
  const afterRankContext = buildCachedRankContext(cachedLeaderboardSnapshot, leaderboardMode, updatedRatingsByPlayerId)

  const participantsWithLeaderboardRanks: ParticipantRow[] = updatedParticipants.map(participant => ({
    ...participant,
    leaderboardBeforeRank: beforeRankByPlayer.get(participant.playerId) ?? null,
    leaderboardAfterRank: afterRankContext?.rankByPlayer.get(participant.playerId) ?? null,
    leaderboardEligibleCount: afterRankContext?.eligibleCount ?? null,
  }))

  return { match: updatedMatch!, participants: participantsWithLeaderboardRanks }
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
  updatedRatingsByPlayerId: Map<string, LeaderboardSnapshotRow>,
): { rankByPlayer: Map<string, number>, eligibleCount: number } | null {
  if (!snapshot) return null

  const rowsByPlayerId = new Map(snapshot.rows.map(row => [row.playerId, row]))
  for (const [playerId, rating] of updatedRatingsByPlayerId) rowsByPlayerId.set(playerId, rating)

  const rankByPlayer = buildRankByPlayer([...rowsByPlayerId.values()], leaderboardMode)
  return { rankByPlayer, eligibleCount: rankByPlayer.size }
}

async function reconcileLeaderboardAggregatesForMatch(
  db: Database,
  matchId: string,
): Promise<void> {
  await reconcileCivLeaderboardMatchContribution(db, matchId)
}

async function listPlayerRatingsForPlayers(
  db: Database,
  leaderboardMode: LeaderboardMode,
  playerIds: readonly string[],
): Promise<Map<string, LeaderboardSnapshotRow>> {
  const uniquePlayerIds = [...new Set(playerIds.filter(playerId => playerId.length > 0))]
  if (uniquePlayerIds.length === 0) return new Map()

  const rows = await db
    .select({
      mode: playerRatings.mode,
      playerId: playerRatings.playerId,
      mu: playerRatings.mu,
      sigma: playerRatings.sigma,
      gamesPlayed: playerRatings.gamesPlayed,
      wins: playerRatings.wins,
      lastPlayedAt: playerRatings.lastPlayedAt,
    })
    .from(playerRatings)
    .where(and(
      eq(playerRatings.mode, leaderboardMode),
      inArray(playerRatings.playerId, uniquePlayerIds),
    ))

  return new Map(rows.map(row => [row.playerId, {
    mode: leaderboardMode,
    playerId: row.playerId,
    mu: row.mu,
    sigma: row.sigma,
    gamesPlayed: row.gamesPlayed,
    wins: row.wins,
    lastPlayedAt: row.lastPlayedAt ?? null,
  }]))
}

async function buildIncrementalSeedFadeContext(
  db: Database,
  leaderboardMode: LeaderboardMode,
  match: RatedReportMatchContext,
  playerIds: readonly string[],
  existingRatingsByPlayerId: Map<string, LeaderboardSnapshotRow>,
): Promise<IncrementalSeedFadeContext> {
  const uniquePlayerIds = [...new Set(playerIds.filter(playerId => playerId.length > 0))]
  if (uniquePlayerIds.length === 0) {
    return {
      seedRowsByPlayerId: new Map(),
      priorNewBotGamesByPlayerId: new Map(),
      currentMatchCountsAsNewBotGame: !match.isOld,
      requiresRecalculation: false,
    }
  }

  const gameModes = leaderboardModesToGameModes(leaderboardMode)
  const [seedRows, priorRows, laterModeRows] = await Promise.all([
    db
      .select({
        playerId: playerRatingSeeds.playerId,
        mu: playerRatingSeeds.mu,
        sigma: playerRatingSeeds.sigma,
        fadeGamesRemaining: playerRatingSeeds.fadeGamesRemaining,
      })
      .from(playerRatingSeeds)
      .where(and(
        eq(playerRatingSeeds.mode, leaderboardMode),
        inArray(playerRatingSeeds.playerId, uniquePlayerIds),
      )),
    db
      .select({
        playerId: matchParticipants.playerId,
        completedGames: sql<number>`count(*)`,
        newBotGames: sql<number>`sum(case when ${matches.isOld} = 0 then 1 else 0 end)`,
      })
      .from(matchParticipants)
      .innerJoin(matches, eq(matchParticipants.matchId, matches.id))
      .where(and(
        inArray(matchParticipants.playerId, uniquePlayerIds),
        eq(matches.status, 'completed'),
        inArray(matches.gameMode, gameModes),
        buildBeforeMatchCondition(match),
      ))
      .groupBy(matchParticipants.playerId),
    db
      .select({ count: sql<number>`count(*)` })
      .from(matches)
      .where(and(
        eq(matches.status, 'completed'),
        inArray(matches.gameMode, gameModes),
        buildAfterMatchCondition(match),
      )),
  ])

  const seedRowsByPlayerId = new Map(seedRows
    .filter(row => row.fadeGamesRemaining == null || row.fadeGamesRemaining > 0)
    .map(row => [row.playerId, row]))
  const priorCompletedGamesByPlayerId = new Map(priorRows.map(row => [row.playerId, Number(row.completedGames ?? 0)]))
  const priorNewBotGamesByPlayerId = new Map(priorRows.map(row => [row.playerId, Number(row.newBotGames ?? 0)]))
  const laterCompletedModeMatches = Number(laterModeRows[0]?.count ?? 0)
  const requiresRecalculation = laterCompletedModeMatches > 0
    || uniquePlayerIds.some(playerId => (
      !existingRatingsByPlayerId.has(playerId)
      && (priorCompletedGamesByPlayerId.get(playerId) ?? 0) > 0
    ))

  return {
    seedRowsByPlayerId,
    priorNewBotGamesByPlayerId,
    currentMatchCountsAsNewBotGame: !match.isOld,
    requiresRecalculation,
  }
}

function buildBeforeMatchCondition(match: Pick<RatedReportMatchContext, 'id' | 'createdAt'>) {
  return or(
    lt(matches.createdAt, match.createdAt),
    and(eq(matches.createdAt, match.createdAt), lt(matches.id, match.id)),
  )
}

function buildAfterMatchCondition(match: Pick<RatedReportMatchContext, 'id' | 'createdAt'>) {
  return or(
    gt(matches.createdAt, match.createdAt),
    and(eq(matches.createdAt, match.createdAt), gt(matches.id, match.id)),
  )
}

async function applyIncrementalRatedReport(
  db: Database,
  matchId: string,
  gameMode: string,
  leaderboardMode: LeaderboardMode,
  participantRows: ParticipantRow[],
  existingRatingsByPlayerId: Map<string, LeaderboardSnapshotRow>,
  now: number,
  seedFadeContext: IncrementalSeedFadeContext | null = null,
): Promise<string | null> {
  const placementByPlayerId = new Map(participantRows.map(participant => [participant.playerId, participant.placement]))
  const playerRatingMap = new Map<string, { mu: number, sigma: number }>()

  for (const participant of participantRows) {
    const existing = existingRatingsByPlayerId.get(participant.playerId)
    const seed = seedFadeContext?.seedRowsByPlayerId.get(participant.playerId)
    if (existing) {
      playerRatingMap.set(participant.playerId, { mu: existing.mu, sigma: existing.sigma })
    }
    else if (seed) {
      playerRatingMap.set(participant.playerId, { mu: seed.mu, sigma: seed.sigma })
    }
    else {
      const fresh = createRating(participant.playerId)
      playerRatingMap.set(participant.playerId, { mu: fresh.mu, sigma: fresh.sigma })
    }
  }

  let ratingUpdates

  if (isTeamMode(gameMode as Parameters<typeof isTeamMode>[0]) || gameMode === '1v1') {
    const teams = new Map<number, { playerId: string, mu: number, sigma: number }[]>()
    for (const participant of participantRows) {
      const team = participant.team ?? 0
      if (!teams.has(team)) teams.set(team, [])
      const rating = playerRatingMap.get(participant.playerId)
      if (!rating) return `Missing rating state for **${participant.playerId}**.`
      teams.get(team)?.push({ playerId: participant.playerId, mu: rating.mu, sigma: rating.sigma })
    }

    const teamEntries = [...teams.entries()].sort((a, b) => {
      const aPlacement = participantRows.find(participant => participant.team === a[0])?.placement ?? 99
      const bPlacement = participantRows.find(participant => participant.team === b[0])?.placement ?? 99
      return aPlacement - bPlacement
    })

    const teamInputs: TeamInput[] = teamEntries.map(([, players]) => ({
      players: players.map(player => ({ playerId: player.playerId, mu: player.mu, sigma: player.sigma })),
    }))

    ratingUpdates = calculateRatings({ type: 'team', teams: teamInputs })
  }
  else {
    const ffaEntries: FfaEntry[] = participantRows.map((participant) => {
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
    const seedFadeStepMu = getSeedFadeStepMu(seedFadeContext, update.playerId)
    const ratingBeforeMu = update.before.mu - seedFadeStepMu
    const ratingAfterMu = update.after.mu - seedFadeStepMu

    await db
      .update(matchParticipants)
      .set({
        ratingBeforeMu,
        ratingBeforeSigma: update.before.sigma,
        ratingAfterMu,
        ratingAfterSigma: update.after.sigma,
      })
      .where(and(
        eq(matchParticipants.matchId, matchId),
        eq(matchParticipants.playerId, update.playerId),
      ))

    const existing = existingRatingsByPlayerId.get(update.playerId)
    const isWin = placementByPlayerId.get(update.playerId) === 1

    if (existing) {
      await db
        .update(playerRatings)
        .set({
          mu: ratingAfterMu,
          sigma: update.after.sigma,
          gamesPlayed: existing.gamesPlayed + 1,
          wins: (existing.wins ?? 0) + (isWin ? 1 : 0),
          lastPlayedAt: now,
        })
        .where(and(
          eq(playerRatings.playerId, update.playerId),
          eq(playerRatings.mode, leaderboardMode),
        ))
    }
    else {
      await db.insert(playerRatings).values({
        playerId: update.playerId,
        mode: leaderboardMode,
        mu: ratingAfterMu,
        sigma: update.after.sigma,
        gamesPlayed: 1,
        wins: isWin ? 1 : 0,
        lastPlayedAt: now,
      })
    }
  }

  return null
}

function getSeedFadeStepMu(seedFadeContext: IncrementalSeedFadeContext | null, playerId: string): number {
  if (!seedFadeContext?.currentMatchCountsAsNewBotGame) return 0
  const seed = seedFadeContext.seedRowsByPlayerId.get(playerId)
  if (!seed || seed.fadeGamesRemaining == null || seed.fadeGamesRemaining <= 0) return 0

  const defaultRating = createRating(playerId)
  return calculateSeedFadeStepMu(
    seed.mu - defaultRating.mu,
    seed.fadeGamesRemaining,
    seedFadeContext.priorNewBotGamesByPlayerId.get(playerId) ?? 0,
  )
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
  await reconcileLeaderboardAggregatesForMatch(db, match.id)
  return { match: updatedMatch, participants: updatedParticipants, idempotent: true }
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
  return await rollbackReportedRatedMatch(db, kv, { match, leaderboardMode, participantRows })
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

async function modeUsesLiveSeedFade(db: Database, leaderboardMode: string): Promise<boolean> {
  const [row] = await db
    .select({ playerId: playerRatingSeeds.playerId })
    .from(playerRatingSeeds)
    .where(and(
      eq(playerRatingSeeds.mode, leaderboardMode),
      gt(playerRatingSeeds.fadeGamesRemaining, 0),
    ))
    .limit(1)

  return row != null
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
