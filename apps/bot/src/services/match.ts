import type { Database } from '@civup/db'
import type { DraftSeat, DraftState, GameMode } from '@civup/game'
import type { FfaEntry, TeamInput } from '@civup/rating'
import { matchBans, matches, matchParticipants, playerRatings, players } from '@civup/db'
import { isTeamMode, toLeaderboardMode } from '@civup/game'
import { calculateRatings, createRating } from '@civup/rating'
import { and, eq } from 'drizzle-orm'
import { clearActivityMappings, getChannelForMatch } from './activity.ts'

// ── Types ───────────────────────────────────────────────────

interface MatchRow {
  id: string
  gameMode: string
  status: string
  createdAt: number
  completedAt: number | null
}

interface ParticipantRow {
  matchId: string
  playerId: string
  team: number | null
  civId: string | null
  placement: number | null
  ratingBeforeMu: number | null
  ratingBeforeSigma: number | null
  ratingAfterMu: number | null
  ratingAfterSigma: number | null
}

interface ReportInput {
  matchId: string
  reporterId: string
  /** For team games: "A" or "B". For FFA: player IDs in placement order, newline-separated. */
  placements: string
}

type ReportResult
  = | { match: MatchRow, participants: ParticipantRow[] }
    | { error: string }

type ConfirmResult
  = | { match: MatchRow, participants: ParticipantRow[] }
    | { error: string }

interface CreateDraftMatchInput {
  matchId: string
  mode: GameMode
  seats: DraftSeat[]
}

interface ActivateDraftInput {
  state: DraftState
  completedAt: number
}

type ActivateDraftResult
  = | { match: MatchRow, participants: ParticipantRow[] }
    | { error: string }

// ── Draft lifecycle: create DB rows when queue pops ───────────

export async function createDraftMatch(
  db: Database,
  input: CreateDraftMatchInput,
): Promise<void> {
  const now = Date.now()

  const [existingMatch] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, input.matchId))
    .limit(1)

  if (!existingMatch) {
    await db.insert(matches).values({
      id: input.matchId,
      gameMode: input.mode,
      status: 'drafting',
      createdAt: now,
      completedAt: null,
    })
  }

  const uniquePlayers = new Map<string, DraftSeat>()
  for (const seat of input.seats) {
    if (!uniquePlayers.has(seat.playerId)) {
      uniquePlayers.set(seat.playerId, seat)
    }
  }

  for (const seat of uniquePlayers.values()) {
    await db
      .insert(players)
      .values({
        id: seat.playerId,
        displayName: seat.displayName,
        createdAt: now,
      })
      .onConflictDoNothing()
  }

  const [existingParticipant] = await db
    .select({ playerId: matchParticipants.playerId })
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, input.matchId))
    .limit(1)

  if (!existingParticipant && input.seats.length > 0) {
    await db.insert(matchParticipants).values(
      input.seats.map(seat => ({
        matchId: input.matchId,
        playerId: seat.playerId,
        team: seat.team ?? null,
        civId: null,
        placement: null,
        ratingBeforeMu: null,
        ratingBeforeSigma: null,
        ratingAfterMu: null,
        ratingAfterSigma: null,
      })),
    )
  }
}

// ── Draft lifecycle: activate match when draft completes ─────

export async function activateDraftMatch(
  db: Database,
  input: ActivateDraftInput,
): Promise<ActivateDraftResult> {
  const matchId = input.state.matchId

  const [match] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, matchId))
    .limit(1)

  if (!match) {
    return { error: `Match **${matchId}** not found.` }
  }

  if (match.status === 'cancelled' || match.status === 'completed') {
    return { error: `Match **${matchId}** cannot be activated (status: ${match.status}).` }
  }

  const participantRows = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, matchId))

  if (participantRows.length === 0) {
    return { error: `Match **${matchId}** has no participants.` }
  }

  const playerToSeatIndex = new Map<string, number>()
  input.state.seats.forEach((seat, idx) => {
    playerToSeatIndex.set(seat.playerId, idx)
  })

  const orderedParticipants = [...participantRows].sort((a, b) => {
    const aSeat = playerToSeatIndex.get(a.playerId) ?? Number.MAX_SAFE_INTEGER
    const bSeat = playerToSeatIndex.get(b.playerId) ?? Number.MAX_SAFE_INTEGER
    return aSeat - bSeat
  })

  const civByPlayer = new Map<string, string | null>()
  const gameMode = match.gameMode as GameMode

  if (isTeamMode(gameMode)) {
    const picksByTeam = new Map<number, string[]>()
    for (const pick of input.state.picks) {
      const teamPicks = picksByTeam.get(pick.seatIndex) ?? []
      teamPicks.push(pick.civId)
      picksByTeam.set(pick.seatIndex, teamPicks)
    }

    const teamPickOffsets = new Map<number, number>()
    for (const participant of orderedParticipants) {
      const team = participant.team
      if (team === null) {
        civByPlayer.set(participant.playerId, null)
        continue
      }

      const offset = teamPickOffsets.get(team) ?? 0
      const civId = picksByTeam.get(team)?.[offset] ?? null
      civByPlayer.set(participant.playerId, civId)
      teamPickOffsets.set(team, offset + 1)
    }
  }
  else {
    const pickBySeat = new Map<number, string>()
    for (const pick of input.state.picks) {
      if (!pickBySeat.has(pick.seatIndex)) {
        pickBySeat.set(pick.seatIndex, pick.civId)
      }
    }

    input.state.seats.forEach((seat, seatIndex) => {
      civByPlayer.set(seat.playerId, pickBySeat.get(seatIndex) ?? null)
    })
  }

  for (const participant of participantRows) {
    await db
      .update(matchParticipants)
      .set({ civId: civByPlayer.get(participant.playerId) ?? null })
      .where(
        and(
          eq(matchParticipants.matchId, matchId),
          eq(matchParticipants.playerId, participant.playerId),
        ),
      )
  }

  await db.delete(matchBans).where(eq(matchBans.matchId, matchId))

  const banRows = input.state.bans
    .map((ban) => {
      const seat = input.state.seats[ban.seatIndex]
      if (!seat) return null
      return {
        matchId,
        civId: ban.civId,
        bannedBy: seat.playerId,
        phase: ban.stepIndex,
      }
    })
    .filter(row => row !== null)

  if (banRows.length > 0) {
    await db.insert(matchBans).values(banRows)
  }

  await db
    .update(matches)
    .set({
      status: 'active',
      draftData: JSON.stringify({
        completedAt: input.completedAt,
        state: input.state,
      }),
    })
    .where(eq(matches.id, matchId))

  const [updatedMatch] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, matchId))
    .limit(1)

  const updatedParticipants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, matchId))

  return { match: updatedMatch!, participants: updatedParticipants }
}

// ── Report a match result ───────────────────────────────────

export async function reportMatch(
  db: Database,
  input: ReportInput,
): Promise<ReportResult> {
  // Fetch the match
  const [match] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, input.matchId))
    .limit(1)

  if (!match) {
    return { error: `Match **${input.matchId}** not found.` }
  }

  if (match.status !== 'active') {
    return { error: `Match **${input.matchId}** is not active (status: ${match.status}).` }
  }

  // Verify reporter is a participant
  const participantRows = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, input.matchId))

  const isParticipant = participantRows.some(p => p.playerId === input.reporterId)
  if (!isParticipant) {
    return { error: 'Only match participants can report results.' }
  }

  const gameMode = match.gameMode as GameMode

  if (isTeamMode(gameMode)) {
    // Team game: placements is "A" or "B"
    const winningTeam = input.placements.trim().toUpperCase()
    if (winningTeam !== 'A' && winningTeam !== 'B') {
      return { error: 'For team games, enter "A" or "B" for the winning team.' }
    }

    const winTeamIdx = winningTeam === 'A' ? 0 : 1

    // Set placements: winning team = 1, losing team = 2
    for (const p of participantRows) {
      const placement = p.team === winTeamIdx ? 1 : 2
      await db
        .update(matchParticipants)
        .set({ placement })
        .where(
          and(
            eq(matchParticipants.matchId, input.matchId),
            eq(matchParticipants.playerId, p.playerId),
          ),
        )
    }
  }
  else {
    // FFA: parse placement order from newline-separated player IDs/mentions
    const lines = input.placements
      .trim()
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0)

    // Extract player IDs (handle mentions like <@123456>)
    const placementIds = lines.map(l => l.replace(/[<@!>]/g, ''))

    for (let i = 0; i < placementIds.length; i++) {
      const playerId = placementIds[i]!
      await db
        .update(matchParticipants)
        .set({ placement: i + 1 })
        .where(
          and(
            eq(matchParticipants.matchId, input.matchId),
            eq(matchParticipants.playerId, playerId),
          ),
        )
    }

    // Anyone not mentioned gets last place (tied)
    const mentionedIds = new Set(placementIds)
    const unplaced = participantRows.filter(p => !mentionedIds.has(p.playerId))
    const lastPlace = placementIds.length + 1
    for (const p of unplaced) {
      await db
        .update(matchParticipants)
        .set({ placement: lastPlace })
        .where(
          and(
            eq(matchParticipants.matchId, input.matchId),
            eq(matchParticipants.playerId, p.playerId),
          ),
        )
    }
  }

  // Update match status to pending confirmation
  // (we don't complete it yet — needs a second person to confirm)

  // Fetch updated participants
  const updatedParticipants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, input.matchId))

  return { match, participants: updatedParticipants }
}

// ── Confirm a match result and apply ratings ────────────────

export async function confirmMatch(
  db: Database,
  kv: KVNamespace,
  matchId: string,
  confirmerId: string,
): Promise<ConfirmResult> {
  const [match] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, matchId))
    .limit(1)

  if (!match) {
    return { error: `Match **${matchId}** not found.` }
  }

  if (match.status !== 'active') {
    return { error: `Match **${matchId}** is not active.` }
  }

  const participantRows = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, matchId))

  // Verify confirmer is a participant (and not the same as reporter)
  const isParticipant = participantRows.some(p => p.playerId === confirmerId)
  if (!isParticipant) {
    return { error: 'Only match participants can confirm results.' }
  }

  // Check all placements are set
  if (participantRows.some(p => p.placement === null)) {
    return { error: 'Result has not been reported yet.' }
  }

  const gameMode = match.gameMode as GameMode
  const leaderboardMode = toLeaderboardMode(gameMode)

  // Fetch or create ratings for all participants
  const playerRatingMap = new Map<string, { mu: number, sigma: number }>()

  for (const p of participantRows) {
    const [existing] = await db
      .select()
      .from(playerRatings)
      .where(
        and(
          eq(playerRatings.playerId, p.playerId),
          eq(playerRatings.mode, leaderboardMode),
        ),
      )
      .limit(1)

    if (existing) {
      playerRatingMap.set(p.playerId, { mu: existing.mu, sigma: existing.sigma })
    }
    else {
      const fresh = createRating(p.playerId)
      playerRatingMap.set(p.playerId, { mu: fresh.mu, sigma: fresh.sigma })
    }
  }

  // Calculate new ratings
  let ratingUpdates

  if (isTeamMode(gameMode) || gameMode === 'duel') {
    // Group by team
    const teams: Map<number, { playerId: string, mu: number, sigma: number }[]> = new Map()
    for (const p of participantRows) {
      const team = p.team ?? 0
      if (!teams.has(team)) teams.set(team, [])
      const rating = playerRatingMap.get(p.playerId)!
      teams.get(team)!.push({ playerId: p.playerId, mu: rating.mu, sigma: rating.sigma })
    }

    // Sort teams by placement (team with placement=1 first)
    const teamEntries = [...teams.entries()].sort((a, b) => {
      const aPlacement = participantRows.find(p => p.team === a[0])?.placement ?? 99
      const bPlacement = participantRows.find(p => p.team === b[0])?.placement ?? 99
      return aPlacement - bPlacement
    })

    const teamInputs: TeamInput[] = teamEntries.map(([, players]) => ({
      players: players.map(p => ({ playerId: p.playerId, mu: p.mu, sigma: p.sigma })),
    }))

    ratingUpdates = calculateRatings({ type: 'team', teams: teamInputs })
  }
  else {
    // FFA
    const ffaEntries: FfaEntry[] = participantRows.map((p) => {
      const rating = playerRatingMap.get(p.playerId)!
      return {
        player: { playerId: p.playerId, mu: rating.mu, sigma: rating.sigma },
        placement: p.placement!,
      }
    })

    ratingUpdates = calculateRatings({ type: 'ffa', entries: ffaEntries })
  }

  // Apply rating updates to DB
  const now = Date.now()

  for (const update of ratingUpdates) {
    // Snapshot before/after on the participant row
    await db
      .update(matchParticipants)
      .set({
        ratingBeforeMu: update.before.mu,
        ratingBeforeSigma: update.before.sigma,
        ratingAfterMu: update.after.mu,
        ratingAfterSigma: update.after.sigma,
      })
      .where(
        and(
          eq(matchParticipants.matchId, matchId),
          eq(matchParticipants.playerId, update.playerId),
        ),
      )

    // Upsert the player rating
    const [existing] = await db
      .select()
      .from(playerRatings)
      .where(
        and(
          eq(playerRatings.playerId, update.playerId),
          eq(playerRatings.mode, leaderboardMode),
        ),
      )
      .limit(1)

    const isWin = participantRows.find(p => p.playerId === update.playerId)?.placement === 1

    if (existing) {
      await db
        .update(playerRatings)
        .set({
          mu: update.after.mu,
          sigma: update.after.sigma,
          gamesPlayed: existing.gamesPlayed + 1,
          wins: existing.wins + (isWin ? 1 : 0),
          lastPlayedAt: now,
        })
        .where(
          and(
            eq(playerRatings.playerId, update.playerId),
            eq(playerRatings.mode, leaderboardMode),
          ),
        )
    }
    else {
      await db.insert(playerRatings).values({
        playerId: update.playerId,
        mode: leaderboardMode,
        mu: update.after.mu,
        sigma: update.after.sigma,
        gamesPlayed: 1,
        wins: isWin ? 1 : 0,
        lastPlayedAt: now,
      })
    }

    // Ensure player exists in players table
    await db
      .insert(players)
      .values({
        id: update.playerId,
        displayName: update.playerId, // will be updated with real name on next interaction
        createdAt: now,
      })
      .onConflictDoNothing()
  }

  // Mark match as completed
  await db
    .update(matches)
    .set({ status: 'completed', completedAt: now })
    .where(eq(matches.id, matchId))

  const channelId = await getChannelForMatch(kv, matchId)
  await clearActivityMappings(
    kv,
    matchId,
    participantRows.map(p => p.playerId),
    channelId ?? undefined,
  )

  // Fetch final state
  const [updatedMatch] = await db
    .select()
    .from(matches)
    .where(eq(matches.id, matchId))
    .limit(1)

  const updatedParticipants = await db
    .select()
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, matchId))

  return { match: updatedMatch!, participants: updatedParticipants }
}
