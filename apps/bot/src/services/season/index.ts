import type { Database } from '@civup/db'
import type { CompetitiveTier, LeaderboardMode } from '@civup/game'
import { playerRatings, seasonPeakModeRanks, seasonPeakRanks, seasons } from '@civup/db'
import { competitiveTierRank } from '@civup/game'
import { and, desc, eq, inArray } from 'drizzle-orm'

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
  return await getLatestSeason(db)
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

export async function startSeason(db: Database, input: { now?: number } = {}) {

  const existing = await getActiveSeason(db)
  if (existing) throw new Error(`Cannot start a new season while **${existing.name}** is still active.`)

  const now = input.now ?? Date.now()
  const seasonNumber = await getNextSeasonNumber(db)
  const season = {
    id: `season-${seasonNumber}`,
    seasonNumber,
    name: formatSeasonName(seasonNumber),
    startsAt: now,
    endsAt: null,
    active: true,
  } as const

  await db.insert(seasons).values(season)
  await db.delete(playerRatings)
  return season
}

export async function endSeason(db: Database, input: { now?: number } = {}) {
  const existing = await getActiveSeason(db)
  if (!existing) throw new Error('There is no active season to end.')

  const endsAt = input.now ?? Date.now()
  await db
    .update(seasons)
    .set({ active: false, endsAt })
    .where(eq(seasons.id, existing.id))

  return {
    ...existing,
    active: false,
    endsAt,
  }
}

export async function syncSeasonPeakRanks(
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
    const existing = existingByPlayerId.get(candidate.playerId)
    if (!existing) {
      await db.insert(seasonPeakRanks).values({
        seasonId: input.seasonId,
        playerId: candidate.playerId,
        tier: candidate.tier,
        sourceMode: candidate.sourceMode,
        achievedAt: now,
      })
      inserted += 1
      continue
    }

    if (competitiveTierRank(candidate.tier) <= competitiveTierRank(existing.tier as CompetitiveTier)) {
      skipped += 1
      continue
    }

    await db
      .update(seasonPeakRanks)
      .set({
        tier: candidate.tier,
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

export async function syncSeasonPeakModeRanks(
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
    const key = `${candidate.playerId}:${candidate.mode}`
    const existing = existingByKey.get(key)
    if (!existing) {
      await db.insert(seasonPeakModeRanks).values({
        seasonId: input.seasonId,
        playerId: candidate.playerId,
        mode: candidate.mode,
        tier: candidate.tier,
        rating: candidate.rating,
        achievedAt: now,
      })
      inserted += 1
      continue
    }

    if (!isBetterSeasonModePeak(candidate, existing)) {
      skipped += 1
      continue
    }

    await db
      .update(seasonPeakModeRanks)
      .set({
        tier: candidate.tier,
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

function isBetterSeasonModePeak(
  candidate: SeasonModePeakCandidate,
  existing: { tier: string | null, rating: number },
): boolean {
  const candidateRank = candidate.tier ? competitiveTierRank(candidate.tier) : -1
  const existingRank = existing.tier ? competitiveTierRank(existing.tier as CompetitiveTier) : -1
  if (candidateRank !== existingRank) return candidateRank > existingRank
  return candidate.rating > existing.rating
}
