import type { Database } from '@civup/db'
import type { CompetitiveTier, LeaderboardMode } from '@civup/game'
import { seasonPeakRanks, seasons } from '@civup/db'
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

export async function getActiveSeason(db: Database) {
  const [season] = await db
    .select()
    .from(seasons)
    .where(eq(seasons.active, true))
    .orderBy(desc(seasons.startsAt))
    .limit(1)

  return season ?? null
}

export async function startSeason(db: Database, input: { name: string, now?: number }) {
  const name = input.name.trim()
  if (!name) throw new Error('Season name is required.')

  const existing = await getActiveSeason(db)
  if (existing) throw new Error(`Cannot start a new season while **${existing.name}** is still active.`)

  const now = input.now ?? Date.now()
  const [latestSeason] = await db
    .select({ seasonNumber: seasons.seasonNumber })
    .from(seasons)
    .orderBy(desc(seasons.seasonNumber))
    .limit(1)

  const seasonNumber = (latestSeason?.seasonNumber ?? 0) + 1
  const season = {
    id: `season-${seasonNumber}`,
    seasonNumber,
    name,
    startsAt: now,
    endsAt: null,
    active: true,
  } as const

  await db.insert(seasons).values(season)
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
