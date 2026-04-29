import type { Database } from '@civup/db'
import { matches, matchParticipants } from '@civup/db'
import { getLeader } from '@civup/game'
import { and, eq, sql } from 'drizzle-orm'
import { kvMdelete, kvMget, kvMput } from '../kv/batch.ts'

export interface CivLeaderboardSnapshotRow {
  civId: string
  leaderName: string
  civilizationName: string
  picks: number
  bans: number
  wins: number
  winRatePct: number | null
  banRatePct: number | null
}

export interface CivLeaderboardSnapshot {
  updatedAt: number
  completedMatchCount: number
  rows: CivLeaderboardSnapshotRow[]
}

interface StoredCivLeaderboardSnapshot {
  version?: unknown
  updatedAt?: unknown
  completedMatchCount?: unknown
  rows?: unknown
}

interface CivAggregate {
  civId: string
  leaderName: string
  civilizationName: string
  picks: number
  bans: number
  wins: number
}

interface ParsedDraftData {
  state?: {
    bans?: Array<{
      civId?: unknown
    }>
  }
}

const CIV_LEADERBOARD_SNAPSHOT_KEY = 'leaderboard:civ:snapshot'
const CIV_LEADERBOARD_SNAPSHOT_VERSION = 1

export function civLeaderboardSnapshotKey(): string {
  return CIV_LEADERBOARD_SNAPSHOT_KEY
}

export async function ensureCivLeaderboardSnapshot(
  db: Database,
  kv: KVNamespace,
): Promise<CivLeaderboardSnapshot> {
  const snapshot = await getStoredCivLeaderboardSnapshot(kv)
  if (snapshot) return snapshot
  return await rebuildCivLeaderboardSnapshot(db, kv)
}

export async function getStoredCivLeaderboardSnapshot(kv: KVNamespace): Promise<CivLeaderboardSnapshot | null> {
  const [raw] = await kvMget(kv, [{ key: CIV_LEADERBOARD_SNAPSHOT_KEY, type: 'json' }])
  return normalizeCivLeaderboardSnapshot(raw)
}

export async function rebuildCivLeaderboardSnapshot(
  db: Database,
  kv: KVNamespace,
  updatedAt = Date.now(),
): Promise<CivLeaderboardSnapshot> {
  const snapshot = await buildCivLeaderboardSnapshotFromD1(db, updatedAt)
  await setCivLeaderboardSnapshot(kv, snapshot)
  return snapshot
}

export async function buildCivLeaderboardSnapshotFromD1(
  db: Database,
  updatedAt = Date.now(),
): Promise<CivLeaderboardSnapshot> {
  const [matchRows, pickRows] = await Promise.all([
    db
      .select({
        id: matches.id,
        draftData: matches.draftData,
      })
      .from(matches)
      .where(eq(matches.status, 'completed')),
    db
      .select({
        civId: matchParticipants.civId,
        picks: sql<number>`count(*)`,
        wins: sql<number>`sum(case when ${matchParticipants.placement} = 1 then 1 else 0 end)`,
      })
      .from(matchParticipants)
      .innerJoin(matches, eq(matchParticipants.matchId, matches.id))
      .where(and(
        eq(matches.status, 'completed'),
        sql`${matchParticipants.civId} is not null`,
      ))
      .groupBy(matchParticipants.civId),
  ])

  const aggregates = new Map<string, CivAggregate>()

  for (const row of pickRows) {
    if (!row.civId) continue
    const aggregate = getCivAggregate(aggregates, row.civId)
    aggregate.picks += normalizeCount(row.picks)
    aggregate.wins += normalizeCount(row.wins)
  }

  for (const match of matchRows) {
    for (const civId of extractDraftDataBanCivIds(match.draftData)) {
      const aggregate = getCivAggregate(aggregates, civId)
      aggregate.bans += 1
    }
  }

  return {
    updatedAt,
    completedMatchCount: matchRows.length,
    rows: Array.from(aggregates.values())
      .map(row => toSnapshotRow(row, matchRows.length))
      .sort((left, right) => right.picks - left.picks || right.bans - left.bans || left.civId.localeCompare(right.civId)),
  }
}

export async function clearCivLeaderboardSnapshot(kv: KVNamespace): Promise<void> {
  await kvMdelete(kv, [CIV_LEADERBOARD_SNAPSHOT_KEY])
}

function getCivAggregate(aggregates: Map<string, CivAggregate>, civId: string): CivAggregate {
  const existing = aggregates.get(civId)
  if (existing) return existing

  const meta = resolveLeaderMeta(civId)
  const created: CivAggregate = {
    civId,
    leaderName: meta.leaderName,
    civilizationName: meta.civilizationName,
    picks: 0,
    bans: 0,
    wins: 0,
  }
  aggregates.set(civId, created)
  return created
}

function resolveLeaderMeta(civId: string): { leaderName: string, civilizationName: string } {
  try {
    const leader = getLeader(civId)
    return { leaderName: leader.name, civilizationName: leader.civilization }
  }
  catch {
    return { leaderName: '', civilizationName: '' }
  }
}

function toSnapshotRow(row: CivAggregate, completedMatchCount: number): CivLeaderboardSnapshotRow {
  return {
    civId: row.civId,
    leaderName: row.leaderName,
    civilizationName: row.civilizationName,
    picks: row.picks,
    bans: row.bans,
    wins: row.wins,
    winRatePct: row.picks > 0 ? round((row.wins / row.picks) * 100, 1) : null,
    banRatePct: completedMatchCount > 0 ? round((row.bans / completedMatchCount) * 100, 1) : null,
  }
}

async function setCivLeaderboardSnapshot(
  kv: KVNamespace,
  snapshot: CivLeaderboardSnapshot,
): Promise<void> {
  await kvMput(kv, [{
    key: CIV_LEADERBOARD_SNAPSHOT_KEY,
    value: JSON.stringify({
      version: CIV_LEADERBOARD_SNAPSHOT_VERSION,
      updatedAt: snapshot.updatedAt,
      completedMatchCount: snapshot.completedMatchCount,
      rows: snapshot.rows,
    } satisfies StoredCivLeaderboardSnapshot),
  }])
}

export function normalizeCivLeaderboardSnapshot(value: unknown): CivLeaderboardSnapshot | null {
  if (!value || typeof value !== 'object') return null

  const raw = value as StoredCivLeaderboardSnapshot
  if (raw.version !== CIV_LEADERBOARD_SNAPSHOT_VERSION) return null
  if (!Array.isArray(raw.rows)) return null

  return {
    updatedAt: normalizeNonNegativeInteger(raw.updatedAt) ?? 0,
    completedMatchCount: normalizeNonNegativeInteger(raw.completedMatchCount) ?? 0,
    rows: raw.rows
      .map(normalizeCivLeaderboardSnapshotRow)
      .filter((row): row is CivLeaderboardSnapshotRow => row !== null),
  }
}

function normalizeCivLeaderboardSnapshotRow(value: unknown): CivLeaderboardSnapshotRow | null {
  if (!value || typeof value !== 'object') return null

  const raw = value as Record<string, unknown>
  const civId = typeof raw.civId === 'string' && raw.civId.length > 0 ? raw.civId : null
  const picks = normalizeNonNegativeInteger(raw.picks)
  const bans = normalizeNonNegativeInteger(raw.bans)
  const wins = normalizeNonNegativeInteger(raw.wins)
  if (!civId || picks == null || bans == null || wins == null) return null

  return {
    civId,
    leaderName: typeof raw.leaderName === 'string' ? raw.leaderName : '',
    civilizationName: typeof raw.civilizationName === 'string' ? raw.civilizationName : '',
    picks,
    bans,
    wins,
    winRatePct: normalizeNullableNumber(raw.winRatePct),
    banRatePct: normalizeNullableNumber(raw.banRatePct),
  }
}

function extractDraftDataBanCivIds(draftData: string | null): string[] {
  const parsed = parseDraftData(draftData)
  const bans = parsed?.state?.bans
  if (!Array.isArray(bans)) return []

  return bans.flatMap((ban) => {
    const civId = ban?.civId
    return typeof civId === 'string' && civId.length > 0 ? [civId] : []
  })
}

function parseDraftData(draftData: string | null): ParsedDraftData | null {
  if (!draftData) return null
  try {
    const parsed = JSON.parse(draftData) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as ParsedDraftData
  }
  catch {
    return null
  }
}

function normalizeCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value))
  if (typeof value === 'bigint') return Number(value)
  return 0
}

function normalizeNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.round(value))
}

function normalizeNullableNumber(value: unknown): number | null {
  if (value == null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}
