import type { Database } from '@civup/db'
import { runUnbufferedRatingMutation } from './maintenance.ts'
import type { CompetitiveTier, LeaderboardMode } from '@civup/game'
import { matches, playerRatingEvents, playerRatings, seasonPeakModeRanks, seasonPeakRanks, seasonRatingStates, seasons } from '@civup/db'
import { competitiveTierRank, parseLeaderboardMode } from '@civup/game'
import { DEFAULT_SEASON_RESET_FACTOR, DEFAULT_SIGMA, displayRating } from '@civup/rating'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { clearAllLeaderboardModeSnapshots } from '../leaderboard/snapshot.ts'
import { normalizeRankedRoleTierId } from '../ranked/roles.ts'
import { runDbBatch } from '../db/batch.ts'
import type { DbBatchItem } from '../db/batch.ts'
import { prepareSeasonStandingsWrite } from './standings.ts'

export interface SeasonPeakCandidate {
  playerId: string
  tier: CompetitiveTier
  sourceMode: LeaderboardMode | null
}

export interface SeasonPeakSyncResult {
  seasonId: string | null
  inserted: number
  updated: number
  skipped: number
}

export interface SeasonModePeakCandidate {
  playerId: string
  mode: LeaderboardMode
  tier: CompetitiveTier | null
  rating: number
}

export interface SeasonPeakPreviewPlayer {
  playerId: string
  managed?: boolean
  liveAssignment: {
    tier: CompetitiveTier
    sourceMode: LeaderboardMode | null
  }
  assignment: {
    tier: CompetitiveTier
    sourceMode: LeaderboardMode | null
  }
  ladderTiers: Record<LeaderboardMode, CompetitiveTier | null>
}

export async function getActiveSeason(db: Database) {
  const [season] = await db
    .select()
    .from(seasons)
    .where(eq(seasons.active, true))
    .orderBy(desc(seasons.startsAt))
    .limit(1)

  return season ?? null
}

export async function getLatestSeason(db: Database) {
  const [season] = await db
    .select()
    .from(seasons)
    .orderBy(desc(seasons.seasonNumber))
    .limit(1)

  return season ?? null
}

export async function getDisplaySeason(db: Database) {
  const activeSeason = await getActiveSeason(db)
  if (activeSeason) return activeSeason
  return getLatestSeason(db)
}

export async function getNextSeasonNumber(db: Database): Promise<number> {
  const latestSeason = await getLatestSeason(db)
  return (latestSeason?.seasonNumber ?? 0) + 1
}

export function formatSeasonName(seasonNumber: number): string {
  return `Season ${Math.max(1, Math.round(seasonNumber))}`
}

export function formatSeasonShortName(seasonNumber: number): string {
  return `S${Math.max(1, Math.round(seasonNumber))}`
}

export async function startSeason(...args: Parameters<typeof startSeasonImpl>) {
  const result = await runUnbufferedRatingMutation(args[0], 'season:start', () => startSeasonImpl(...args))
  if ('error' in result) throw new Error(result.error)
  return result
}

async function startSeasonImpl(db: Database, input: { now?: number, kv?: KVNamespace, seasonNumber?: number, softReset?: boolean } = {}) {
  const existing = await getActiveSeason(db)
  if (existing) throw new Error(`Cannot start a new season while **${existing.name}** is still active.`)

  const now = input.now ?? Date.now()
  const latestSeason = await getLatestSeason(db)
  if (latestSeason?.ratingSystem === 'rp' || latestSeason?.isolatedRatingsEnabled) throw new Error('RP seasons require the reviewed season transition workflow; the legacy reset cannot change frozen ratings.')
  const nextSeasonNumber = (latestSeason?.seasonNumber ?? 0) + 1
  const seasonNumber = input.seasonNumber ?? nextSeasonNumber
  if (!Number.isSafeInteger(seasonNumber) || seasonNumber < 1) throw new Error('Season number must be a positive integer.')
  if (seasonNumber < nextSeasonNumber) {
    throw new Error(`Cannot start ${formatSeasonName(seasonNumber)} because ${formatSeasonName(nextSeasonNumber)} is the next available season.`)
  }

  const softReset = input.softReset ?? true
  const season = {
    id: `season-${seasonNumber}`,
    seasonNumber,
    name: formatSeasonName(seasonNumber),
    startsAt: now,
    endsAt: null,
    softReset,
    active: true,
    preserveEvidence: true,
  } as const

  const queries: DbBatchItem[] = [db.insert(seasons).values(season)]
  if (softReset) {
    queries.push(db.update(playerRatings).set({
      sigma: sql<number>`${playerRatings.sigma} + (${DEFAULT_SIGMA} - ${playerRatings.sigma}) * ${DEFAULT_SEASON_RESET_FACTOR}`,
    }))
  }
  await runDbBatch(db, queries)
  if (input.kv) {
    await clearAllLeaderboardModeSnapshots(input.kv)
  }
  return {
    ...season,
    didSoftReset: softReset,
  }
}

export async function endSeason(...args: Parameters<typeof endSeasonImpl>) {
  const result = await runUnbufferedRatingMutation(args[0], 'season:end', () => endSeasonImpl(...args))
  if (result && 'error' in result) throw new Error(result.error)
  return result
}

async function endSeasonImpl(db: Database, input: { now?: number } = {}) {
  const existing = await getActiveSeason(db)
  if (!existing) throw new Error('There is no active season to end.')
  if (existing.ratingSystem === 'rp' || existing.isolatedRatingsEnabled) throw new Error('RP seasons require the reviewed season transition workflow; the legacy close cannot finalize them.')

  const endsAt = input.now ?? Date.now()
  if (!Number.isSafeInteger(endsAt) || endsAt < existing.startsAt) throw new Error('Season close must not precede its opening.')
  const closingSnapshot = db.insert(seasonRatingStates).select(db.select({
    seasonId: sql<string>`${existing.id}`.as('season_id'),
    playerId: playerRatings.playerId,
    mode: playerRatings.mode,
    mu: playerRatings.mu,
    sigma: playerRatings.sigma,
    publicRating: sql<number | null>`null`.as('public_rating'),
    publicBadge: sql<number | null>`null`.as('public_badge'),
    publicDecay: sql<null>`null`.as('public_decay'),
    managedTier: sql<string | null>`null`.as('managed_tier'),
    seasonGames: sql<number>`coalesce(sum(case when ${matches.seasonId} = ${existing.id} and ${matches.status} = 'completed' then ${playerRatingEvents.gamesDelta} else 0 end), 0)`.as('season_games'),
    seasonWins: sql<number>`coalesce(sum(case when ${matches.seasonId} = ${existing.id} and ${matches.status} = 'completed' then ${playerRatingEvents.winsDelta} else 0 end), 0)`.as('season_wins'),
    evidence: sql<Record<string, number>>`json_object(
      'gamesPlayed', ${playerRatings.gamesPlayed}, 'wins', ${playerRatings.wins},
      'importedGames', ${playerRatings.importedGames}, 'effectiveGames', ${playerRatings.effectiveGames},
      'winsVsTier1', ${playerRatings.winsVsTier1}, 'winsVsTier2Plus', ${playerRatings.winsVsTier2Plus},
      'effectiveWinsVsTier1', ${playerRatings.effectiveWinsVsTier1}, 'effectiveWinsVsTier2Plus', ${playerRatings.effectiveWinsVsTier2Plus})`.as('evidence'),
    lastPlayedAt: playerRatings.lastPlayedAt,
    revision: sql<number>`0`.as('revision'),
    updatedAt: sql<number>`${endsAt}`.as('updated_at'),
  }).from(playerRatings)
    .leftJoin(playerRatingEvents, and(eq(playerRatingEvents.playerId, playerRatings.playerId), eq(playerRatingEvents.mode, playerRatings.mode)))
    .leftJoin(matches, eq(matches.id, playerRatingEvents.matchId))
    .groupBy(playerRatings.playerId, playerRatings.mode))
  await runDbBatch(db, [closingSnapshot, db.update(seasons)
    .set({ active: false, endsAt, finalizedAt: endsAt })
    .where(eq(seasons.id, existing.id)), prepareSeasonStandingsWrite(db, existing.id)])

  return {
    ...existing,
    active: false,
    endsAt,
    finalizedAt: endsAt,
  }
}

export async function syncSeasonPeakRanks(...args: Parameters<typeof syncSeasonPeakRanksImpl>): Promise<SeasonPeakSyncResult> {
  const result = await runUnbufferedRatingMutation(args[0], 'season:overall-peaks', () => syncSeasonPeakRanksImpl(...args))
  if ('error' in result) throw new Error(result.error)
  return result
}

async function syncSeasonPeakRanksImpl(
  db: Database,
  input: {
    seasonId: string
    candidates: SeasonPeakCandidate[]
    activePlayerIds: Set<string>
    now?: number
  },
): Promise<SeasonPeakSyncResult> {
  const now = input.now ?? Date.now()
  const activeCandidates = input.candidates.filter(candidate => input.activePlayerIds.has(candidate.playerId))
  if (activeCandidates.length === 0) {
    return {
      seasonId: input.seasonId,
      inserted: 0,
      updated: 0,
      skipped: 0,
    }
  }

  const existingRows = await db
    .select()
    .from(seasonPeakRanks)
    .where(and(
      eq(seasonPeakRanks.seasonId, input.seasonId),
      inArray(seasonPeakRanks.playerId, activeCandidates.map(candidate => candidate.playerId)),
    ))

  const existingByPlayerId = new Map(
    existingRows.map(row => [row.playerId, row]),
  )

  let inserted = 0
  let updated = 0
  let skipped = 0

  for (const candidate of activeCandidates) {
    const normalizedTier = normalizeRankedRoleTierId(candidate.tier)
    if (!normalizedTier) {
      skipped += 1
      continue
    }

    const existing = existingByPlayerId.get(candidate.playerId)
    if (!existing) {
      await db.insert(seasonPeakRanks).values({
        seasonId: input.seasonId,
        playerId: candidate.playerId,
        tier: normalizedTier,
        sourceMode: candidate.sourceMode,
        achievedAt: now,
      })
      inserted += 1
      continue
    }

    const existingTier = normalizeRankedRoleTierId(existing.tier)
    if (existingTier && competitiveTierRank(normalizedTier) <= competitiveTierRank(existingTier)) {
      skipped += 1
      continue
    }

    await db
      .update(seasonPeakRanks)
      .set({
        tier: normalizedTier,
        sourceMode: candidate.sourceMode,
        achievedAt: now,
      })
      .where(and(
        eq(seasonPeakRanks.seasonId, input.seasonId),
        eq(seasonPeakRanks.playerId, candidate.playerId),
      ))

    updated += 1
  }

  return {
    seasonId: input.seasonId,
    inserted,
    updated,
    skipped,
  }
}

export async function syncSeasonPeakModeRanks(...args: Parameters<typeof syncSeasonPeakModeRanksImpl>): Promise<SeasonPeakSyncResult> {
  const result = await runUnbufferedRatingMutation(args[0], 'season:mode-peaks', () => syncSeasonPeakModeRanksImpl(...args))
  if ('error' in result) throw new Error(result.error)
  return result
}

async function syncSeasonPeakModeRanksImpl(
  db: Database,
  input: {
    seasonId: string
    candidates: SeasonModePeakCandidate[]
    activeModesByPlayerId: Map<string, Set<LeaderboardMode>>
    now?: number
  },
): Promise<SeasonPeakSyncResult> {
  const now = input.now ?? Date.now()
  const activeCandidates = input.candidates.filter((candidate) => {
    const activeModes = input.activeModesByPlayerId.get(candidate.playerId)
    return activeModes?.has(candidate.mode) ?? false
  })
  if (activeCandidates.length === 0) {
    return {
      seasonId: input.seasonId,
      inserted: 0,
      updated: 0,
      skipped: 0,
    }
  }

  const existingRows = await db
    .select()
    .from(seasonPeakModeRanks)
    .where(and(
      eq(seasonPeakModeRanks.seasonId, input.seasonId),
      inArray(seasonPeakModeRanks.playerId, activeCandidates.map(candidate => candidate.playerId)),
      inArray(seasonPeakModeRanks.mode, activeCandidates.map(candidate => candidate.mode)),
    ))

  const existingByKey = new Map(
    existingRows.map(row => [`${row.playerId}:${row.mode}`, row]),
  )

  let inserted = 0
  let updated = 0
  let skipped = 0

  for (const candidate of activeCandidates) {
    const normalizedTier = candidate.tier ? normalizeRankedRoleTierId(candidate.tier) : null
    const key = `${candidate.playerId}:${candidate.mode}`
    const existing = existingByKey.get(key)
    if (!existing) {
      await db.insert(seasonPeakModeRanks).values({
        seasonId: input.seasonId,
        playerId: candidate.playerId,
        mode: candidate.mode,
        tier: normalizedTier,
        rating: candidate.rating,
        achievedAt: now,
      })
      inserted += 1
      continue
    }

    if (!isBetterSeasonModePeak({ ...candidate, tier: normalizedTier }, existing)) {
      skipped += 1
      continue
    }

    await db
      .update(seasonPeakModeRanks)
      .set({
        tier: normalizedTier,
        rating: candidate.rating,
        achievedAt: now,
      })
      .where(and(
        eq(seasonPeakModeRanks.seasonId, input.seasonId),
        eq(seasonPeakModeRanks.playerId, candidate.playerId),
        eq(seasonPeakModeRanks.mode, candidate.mode),
      ))

    updated += 1
  }

  return {
    seasonId: input.seasonId,
    inserted,
    updated,
    skipped,
  }
}

export async function syncSeasonPeaksForPlayers(...args: Parameters<typeof syncSeasonPeaksForPlayersImpl>) {
  const result = await runUnbufferedRatingMutation(args[0], 'season:player-peaks', () => syncSeasonPeaksForPlayersImpl(...args))
  if ('error' in result) throw new Error(result.error)
  return result
}

async function syncSeasonPeaksForPlayersImpl(
  db: Database,
  input: {
    playerIds: string[]
    playerPreviews: SeasonPeakPreviewPlayer[]
    now?: number
  },
): Promise<{
  seasonId: string | null
  overall: SeasonPeakSyncResult
  byMode: SeasonPeakSyncResult
}> {
  const activeSeason = await getActiveSeason(db)
  if (!activeSeason) {
    return {
      seasonId: null,
      overall: emptySeasonPeakSyncResult(null),
      byMode: emptySeasonPeakSyncResult(null),
    }
  }

  const playerIds = [...new Set(input.playerIds.filter(playerId => playerId.length > 0))]
  if (playerIds.length === 0) {
    return {
      seasonId: activeSeason.id,
      overall: emptySeasonPeakSyncResult(activeSeason.id),
      byMode: emptySeasonPeakSyncResult(activeSeason.id),
    }
  }

  const ratings = await db
    .select({
      playerId: playerRatings.playerId,
      mode: playerRatings.mode,
      mu: playerRatings.mu,
      sigma: playerRatings.sigma,
      lastPlayedAt: playerRatings.lastPlayedAt,
    })
    .from(playerRatings)
    .where(inArray(playerRatings.playerId, playerIds))

  const previewByPlayerId = new Map(input.playerPreviews.map(player => [player.playerId, player]))
  const activePlayerIds = new Set<string>()
  const activeModesByPlayerId = new Map<string, Set<LeaderboardMode>>()

  for (const row of ratings) {
    const lastPlayedAt = row.lastPlayedAt ?? null
    if (lastPlayedAt == null || lastPlayedAt < activeSeason.startsAt) continue

    if (row.mode === 'global') {
      activePlayerIds.add(row.playerId)
      continue
    }

    const mode = parseLeaderboardMode(row.mode)
    if (!mode) continue

    activePlayerIds.add(row.playerId)
    const activeModes = activeModesByPlayerId.get(row.playerId) ?? new Set<LeaderboardMode>()
    activeModes.add(mode)
    activeModesByPlayerId.set(row.playerId, activeModes)
  }

  const overallCandidates = playerIds
    .map((playerId) => {
      const preview = previewByPlayerId.get(playerId)
      if (!preview || preview.managed === false) return null
      return {
        playerId,
        tier: preview.liveAssignment.tier,
        sourceMode: preview.liveAssignment.sourceMode,
      }
    })
    .filter((candidate): candidate is SeasonPeakCandidate => candidate !== null)

  const modeCandidates = ratings
    .map((row) => {
      const mode = parseLeaderboardMode(row.mode)
      if (!mode) return null
      const preview = previewByPlayerId.get(row.playerId)
      if (!preview) return null
      return {
        playerId: row.playerId,
        mode,
        tier: preview.ladderTiers[mode] ?? null,
        rating: Math.round(displayRating(row.mu, row.sigma)),
      }
    })
    .filter((candidate): candidate is SeasonModePeakCandidate => candidate !== null)

  const [overall, byMode] = await Promise.all([
    syncSeasonPeakRanks(db, {
      seasonId: activeSeason.id,
      candidates: overallCandidates,
      activePlayerIds,
      now: input.now,
    }),
    syncSeasonPeakModeRanks(db, {
      seasonId: activeSeason.id,
      candidates: modeCandidates,
      activeModesByPlayerId,
      now: input.now,
    }),
  ])

  return {
    seasonId: activeSeason.id,
    overall,
    byMode,
  }
}

function isBetterSeasonModePeak(
  candidate: SeasonModePeakCandidate,
  existing: { tier: string | null, rating: number },
): boolean {
  const candidateRank = candidate.tier ? competitiveTierRank(candidate.tier) : -1
  const existingTier = normalizeRankedRoleTierId(existing.tier)
  const existingRank = existingTier ? competitiveTierRank(existingTier) : -1
  if (candidateRank !== existingRank) return candidateRank > existingRank
  return candidate.rating > existing.rating
}

function emptySeasonPeakSyncResult(seasonId: string | null): SeasonPeakSyncResult {
  return {
    seasonId,
    inserted: 0,
    updated: 0,
    skipped: 0,
  }
}
