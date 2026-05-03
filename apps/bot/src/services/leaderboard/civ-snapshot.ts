import type { Database } from '@civup/db'
import { civStats, civStatTotals, matchCivStatContributions, matches, matchParticipants } from '@civup/db'
import { getLeader, redDeathLeaderMap } from '@civup/game'
import { and, eq, sql } from 'drizzle-orm'
import { kvMdelete, kvMget, kvMput } from '../kv/batch.ts'

export interface CivLeaderboardSnapshotRow {
  civId: string
  leaderName: string
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
  updatedAt?: unknown
  completedMatchCount?: unknown
  rows?: unknown
}

interface CivAggregate {
  civId: string
  leaderName: string
  picks: number
  bans: number
  wins: number
}

interface ParsedDraftData {
  redDeath?: unknown
  state?: {
    bans?: Array<{
      civId?: unknown
    }>
  }
}

interface CivStatContributionEntry {
  civId: string
  picks: number
  wins: number
  bans: number
}

interface MatchCivStatContribution {
  completedMatchCount: number
  entries: CivStatContributionEntry[]
}

const CIV_LEADERBOARD_SNAPSHOT_KEY = 'leaderboard:civ:snapshot'
const CIV_STAT_TOTAL_SCOPE = 'global'
const CIV_STAT_INITIALIZED_SCOPE = 'history-initialized'
const INSERT_CHUNK_SIZE = 100

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
  const snapshot = await buildCivLeaderboardSnapshotFromStats(db, updatedAt)
  await setCivLeaderboardSnapshot(kv, snapshot)
  return snapshot
}

export async function buildCivLeaderboardSnapshotFromStats(
  db: Database,
  updatedAt = Date.now(),
): Promise<CivLeaderboardSnapshot> {
  const [totalRows, statRows] = await Promise.all([
    db
      .select({ completedMatchCount: civStatTotals.completedMatchCount })
      .from(civStatTotals)
      .where(eq(civStatTotals.scope, CIV_STAT_TOTAL_SCOPE))
      .limit(1),
    db
      .select({
        civId: civStats.civId,
        picks: civStats.picks,
        wins: civStats.wins,
        bans: civStats.bans,
      })
      .from(civStats),
  ])

  const completedMatchCount = normalizeCount(totalRows[0]?.completedMatchCount)
  return {
    updatedAt,
    completedMatchCount,
    rows: statRows
      .filter(row => row.picks > 0 || row.wins > 0 || row.bans > 0)
      .filter(row => !isRedDeathFaction(row.civId))
      .map(row => toSnapshotRow({
        civId: row.civId,
        leaderName: resolveLeaderName(row.civId),
        picks: row.picks,
        wins: row.wins,
        bans: row.bans,
      }, completedMatchCount))
      .sort((left, right) => right.picks - left.picks || right.bans - left.bans || left.civId.localeCompare(right.civId)),
  }
}

export async function rebuildCivLeaderboardStatsFromContributions(
  db: Database,
  updatedAt = Date.now(),
): Promise<CivLeaderboardSnapshot> {
  const contributionRows = await db
    .select({
      completedMatchCount: matchCivStatContributions.completedMatchCount,
      contributionsJson: matchCivStatContributions.contributionsJson,
    })
    .from(matchCivStatContributions)

  const aggregateByCivId = new Map<string, CivAggregate>()
  let completedMatchCount = 0
  for (const row of contributionRows) {
    completedMatchCount += normalizeCount(row.completedMatchCount)
    addContributionToAggregates(aggregateByCivId, parseContributionEntries(row.contributionsJson))
  }

  await replaceCivStatsFromAggregates(db, aggregateByCivId, completedMatchCount, updatedAt)
  return snapshotFromAggregates(aggregateByCivId, completedMatchCount, updatedAt)
}

export async function rebuildCivLeaderboardStatsFromD1(
  db: Database,
  updatedAt = Date.now(),
): Promise<CivLeaderboardSnapshot> {
  const [matchRows, participantRows] = await Promise.all([
    db
      .select({
        id: matches.id,
        draftData: matches.draftData,
      })
      .from(matches)
      .where(eq(matches.status, 'completed')),
    db
      .select({
        matchId: matchParticipants.matchId,
        civId: matchParticipants.civId,
        placement: matchParticipants.placement,
      })
      .from(matchParticipants)
      .innerJoin(matches, eq(matchParticipants.matchId, matches.id))
      .where(eq(matches.status, 'completed')),
  ])

  const participantsByMatchId = new Map<string, Array<{ civId: string | null, placement: number | null }>>()
  for (const row of participantRows) {
    const rows = participantsByMatchId.get(row.matchId) ?? []
    rows.push({ civId: row.civId, placement: row.placement })
    participantsByMatchId.set(row.matchId, rows)
  }

  const aggregateByCivId = new Map<string, CivAggregate>()
  const contributionRows: Array<typeof matchCivStatContributions.$inferInsert> = []
  let completedMatchCount = 0

  for (const match of matchRows) {
    const contribution = buildMatchCivStatContribution(match, participantsByMatchId.get(match.id) ?? [])
    completedMatchCount += contribution.completedMatchCount
    addContributionToAggregates(aggregateByCivId, contribution.entries)

    if (contribution.completedMatchCount > 0 || contribution.entries.length > 0) {
      contributionRows.push({
        matchId: match.id,
        completedMatchCount: contribution.completedMatchCount,
        contributionsJson: serializeContributionEntries(contribution.entries),
        updatedAt,
      })
    }
  }

  await db.delete(civStatTotals).where(eq(civStatTotals.scope, CIV_STAT_INITIALIZED_SCOPE))
  await db.delete(matchCivStatContributions)
  await replaceCivStatsFromAggregates(db, aggregateByCivId, completedMatchCount, updatedAt)

  for (let index = 0; index < contributionRows.length; index += INSERT_CHUNK_SIZE) {
    const chunk = contributionRows.slice(index, index + INSERT_CHUNK_SIZE)
    if (chunk.length > 0) await db.insert(matchCivStatContributions).values(chunk)
  }

  await markCivLeaderboardStatsInitialized(db, updatedAt)

  return snapshotFromAggregates(aggregateByCivId, completedMatchCount, updatedAt)
}

export async function reconcileCivLeaderboardMatchContribution(
  db: Database,
  matchId: string,
  updatedAt = Date.now(),
): Promise<void> {
  const [match] = await db
    .select({ id: matches.id, status: matches.status, draftData: matches.draftData })
    .from(matches)
    .where(eq(matches.id, matchId))
    .limit(1)

  if (!match || match.status !== 'completed') {
    await replaceCivLeaderboardMatchContribution(db, matchId, { completedMatchCount: 0, entries: [] }, updatedAt)
    return
  }

  const participants = await db
    .select({ civId: matchParticipants.civId, placement: matchParticipants.placement })
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, matchId))

  await replaceCivLeaderboardMatchContribution(
    db,
    matchId,
    buildMatchCivStatContribution(match, participants),
    updatedAt,
  )
}

export async function removeCivLeaderboardMatchContribution(
  db: Database,
  matchId: string,
  updatedAt = Date.now(),
): Promise<void> {
  await replaceCivLeaderboardMatchContribution(db, matchId, { completedMatchCount: 0, entries: [] }, updatedAt)
}

export async function buildCivLeaderboardSnapshotFromD1(
  db: Database,
  updatedAt = Date.now(),
): Promise<CivLeaderboardSnapshot> {
  const [matchRows, pickRows] = await Promise.all([
    db
      .select({
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
  const completedCivMatchCount = matchRows.filter(match => !isRedDeathMatch(match.draftData)).length

  for (const row of pickRows) {
    if (!row.civId) continue
    if (isRedDeathFaction(row.civId)) continue
    const aggregate = getCivAggregate(aggregates, row.civId)
    aggregate.picks += normalizeCount(row.picks)
    aggregate.wins += normalizeCount(row.wins)
  }

  for (const match of matchRows) {
    if (isRedDeathMatch(match.draftData)) continue
    for (const civId of extractDraftDataBanCivIds(match.draftData)) {
      if (isRedDeathFaction(civId)) continue
      const aggregate = getCivAggregate(aggregates, civId)
      aggregate.bans += 1
    }
  }

  return {
    updatedAt,
    completedMatchCount: completedCivMatchCount,
    rows: Array.from(aggregates.values())
      .map(row => toSnapshotRow(row, completedCivMatchCount))
      .sort((left, right) => right.picks - left.picks || right.bans - left.bans || left.civId.localeCompare(right.civId)),
  }
}

async function replaceCivLeaderboardMatchContribution(
  db: Database,
  matchId: string,
  next: MatchCivStatContribution,
  updatedAt: number,
): Promise<void> {
  const previous = await getCivLeaderboardMatchContribution(db, matchId)

  if (next.completedMatchCount > 0 || next.entries.length > 0) {
    await db
      .insert(matchCivStatContributions)
      .values({
        matchId,
        completedMatchCount: next.completedMatchCount,
        contributionsJson: serializeContributionEntries(next.entries),
        updatedAt,
      })
      .onConflictDoUpdate({
        target: matchCivStatContributions.matchId,
        set: {
          completedMatchCount: next.completedMatchCount,
          contributionsJson: serializeContributionEntries(next.entries),
          updatedAt,
        },
      })
    await applyCivLeaderboardAggregateDelta(db, previous, next, updatedAt)
    return
  }

  await db.delete(matchCivStatContributions).where(eq(matchCivStatContributions.matchId, matchId))
  await applyCivLeaderboardAggregateDelta(db, previous, next, updatedAt)
}

async function getCivLeaderboardMatchContribution(
  db: Database,
  matchId: string,
): Promise<MatchCivStatContribution> {
  const [row] = await db
    .select({
      completedMatchCount: matchCivStatContributions.completedMatchCount,
      contributionsJson: matchCivStatContributions.contributionsJson,
    })
    .from(matchCivStatContributions)
    .where(eq(matchCivStatContributions.matchId, matchId))
    .limit(1)

  return row
    ? {
        completedMatchCount: normalizeCount(row.completedMatchCount),
        entries: parseContributionEntries(row.contributionsJson),
      }
    : { completedMatchCount: 0, entries: [] }
}

async function applyCivLeaderboardAggregateDelta(
  db: Database,
  previous: MatchCivStatContribution,
  next: MatchCivStatContribution,
  updatedAt: number,
): Promise<void> {
  const completedMatchCountDelta = normalizeCount(next.completedMatchCount) - normalizeCount(previous.completedMatchCount)
  if (completedMatchCountDelta !== 0) {
    await db
      .insert(civStatTotals)
      .values({
        scope: CIV_STAT_TOTAL_SCOPE,
        completedMatchCount: Math.max(0, completedMatchCountDelta),
        updatedAt,
      })
      .onConflictDoUpdate({
        target: civStatTotals.scope,
        set: {
          completedMatchCount: sql<number>`max(0, ${civStatTotals.completedMatchCount} + ${completedMatchCountDelta})`,
          updatedAt,
        },
      })
  }

  for (const delta of diffCivContributionEntries(previous.entries, next.entries)) {
    await db
      .insert(civStats)
      .values({
        civId: delta.civId,
        picks: Math.max(0, delta.picks),
        wins: Math.max(0, delta.wins),
        bans: Math.max(0, delta.bans),
        updatedAt,
      })
      .onConflictDoUpdate({
        target: civStats.civId,
        set: {
          picks: sql<number>`max(0, ${civStats.picks} + ${delta.picks})`,
          wins: sql<number>`max(0, ${civStats.wins} + ${delta.wins})`,
          bans: sql<number>`max(0, ${civStats.bans} + ${delta.bans})`,
          updatedAt,
        },
      })

    await db
      .delete(civStats)
      .where(and(
        eq(civStats.civId, delta.civId),
        sql`${civStats.picks} <= 0 and ${civStats.wins} <= 0 and ${civStats.bans} <= 0`,
      ))
  }
}

async function replaceCivStatsFromAggregates(
  db: Database,
  aggregateByCivId: Map<string, CivAggregate>,
  completedMatchCount: number,
  updatedAt: number,
): Promise<void> {
  await db.delete(civStats)
  await db.delete(civStatTotals).where(eq(civStatTotals.scope, CIV_STAT_TOTAL_SCOPE))

  await db.insert(civStatTotals).values({
    scope: CIV_STAT_TOTAL_SCOPE,
    completedMatchCount,
    updatedAt,
  })

  const aggregateRows = [...aggregateByCivId.values()]
    .filter(row => row.picks > 0 || row.wins > 0 || row.bans > 0)
  if (aggregateRows.length === 0) return

  await db.insert(civStats).values(aggregateRows.map(row => ({
    civId: row.civId,
    picks: row.picks,
    wins: row.wins,
    bans: row.bans,
    updatedAt,
  })))
}

async function markCivLeaderboardStatsInitialized(db: Database, updatedAt: number): Promise<void> {
  await db
    .insert(civStatTotals)
    .values({
      scope: CIV_STAT_INITIALIZED_SCOPE,
      completedMatchCount: 1,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: civStatTotals.scope,
      set: {
        completedMatchCount: 1,
        updatedAt,
      },
    })
}

function snapshotFromAggregates(
  aggregateByCivId: Map<string, CivAggregate>,
  completedMatchCount: number,
  updatedAt: number,
): CivLeaderboardSnapshot {
  return {
    updatedAt,
    completedMatchCount,
    rows: [...aggregateByCivId.values()]
      .filter(row => row.picks > 0 || row.wins > 0 || row.bans > 0)
      .filter(row => !isRedDeathFaction(row.civId))
      .map(row => toSnapshotRow(row, completedMatchCount))
      .sort((left, right) => right.picks - left.picks || right.bans - left.bans || left.civId.localeCompare(right.civId)),
  }
}

function buildMatchCivStatContribution(
  match: { draftData: string | null },
  participants: readonly { civId: string | null, placement: number | null }[],
): MatchCivStatContribution {
  if (isRedDeathMatch(match.draftData)) return { completedMatchCount: 0, entries: [] }

  const aggregateByCivId = new Map<string, CivAggregate>()
  for (const participant of participants) {
    if (!participant.civId || isRedDeathFaction(participant.civId)) continue
    const aggregate = getCivAggregate(aggregateByCivId, participant.civId)
    aggregate.picks += 1
    if (participant.placement === 1) aggregate.wins += 1
  }

  for (const civId of extractDraftDataBanCivIds(match.draftData)) {
    if (isRedDeathFaction(civId)) continue
    getCivAggregate(aggregateByCivId, civId).bans += 1
  }

  return {
    completedMatchCount: 1,
    entries: [...aggregateByCivId.values()]
      .filter(entry => entry.picks > 0 || entry.wins > 0 || entry.bans > 0)
      .map(entry => ({
        civId: entry.civId,
        picks: entry.picks,
        wins: entry.wins,
        bans: entry.bans,
      }))
      .sort((left, right) => left.civId.localeCompare(right.civId)),
  }
}

function addContributionToAggregates(
  aggregateByCivId: Map<string, CivAggregate>,
  entries: readonly CivStatContributionEntry[],
): void {
  for (const entry of entries) {
    const aggregate = getCivAggregate(aggregateByCivId, entry.civId)
    aggregate.picks += entry.picks
    aggregate.wins += entry.wins
    aggregate.bans += entry.bans
  }
}

function diffCivContributionEntries(
  previous: readonly CivStatContributionEntry[],
  next: readonly CivStatContributionEntry[],
): CivStatContributionEntry[] {
  const deltas = new Map<string, CivStatContributionEntry>()
  for (const entry of previous) {
    deltas.set(entry.civId, {
      civId: entry.civId,
      picks: -normalizeCount(entry.picks),
      wins: -normalizeCount(entry.wins),
      bans: -normalizeCount(entry.bans),
    })
  }

  for (const entry of next) {
    const delta = deltas.get(entry.civId) ?? {
      civId: entry.civId,
      picks: 0,
      wins: 0,
      bans: 0,
    }
    delta.picks += normalizeCount(entry.picks)
    delta.wins += normalizeCount(entry.wins)
    delta.bans += normalizeCount(entry.bans)
    deltas.set(entry.civId, delta)
  }

  return [...deltas.values()]
    .filter(entry => entry.picks !== 0 || entry.wins !== 0 || entry.bans !== 0)
    .sort((left, right) => left.civId.localeCompare(right.civId))
}

function serializeContributionEntries(entries: readonly CivStatContributionEntry[]): string {
  return JSON.stringify(entries
    .filter(entry => entry.picks > 0 || entry.wins > 0 || entry.bans > 0)
    .map(entry => ({
      civId: entry.civId,
      picks: normalizeCount(entry.picks),
      wins: normalizeCount(entry.wins),
      bans: normalizeCount(entry.bans),
    }))
    .sort((left, right) => left.civId.localeCompare(right.civId)))
}

function parseContributionEntries(raw: string): CivStatContributionEntry[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return []
      const candidate = entry as Partial<CivStatContributionEntry>
      if (typeof candidate.civId !== 'string' || candidate.civId.length === 0) return []
      const normalized = {
        civId: candidate.civId,
        picks: normalizeCount(candidate.picks),
        wins: normalizeCount(candidate.wins),
        bans: normalizeCount(candidate.bans),
      }
      return normalized.picks === 0 && normalized.wins === 0 && normalized.bans === 0 ? [] : [normalized]
    })
  }
  catch {
    return []
  }
}

export async function clearCivLeaderboardSnapshot(kv: KVNamespace): Promise<void> {
  await kvMdelete(kv, [CIV_LEADERBOARD_SNAPSHOT_KEY])
}

function getCivAggregate(aggregates: Map<string, CivAggregate>, civId: string): CivAggregate {
  const existing = aggregates.get(civId)
  if (existing) return existing

  const created: CivAggregate = {
    civId,
    leaderName: resolveLeaderName(civId),
    picks: 0,
    bans: 0,
    wins: 0,
  }
  aggregates.set(civId, created)
  return created
}

function resolveLeaderName(civId: string): string {
  try {
    return getLeader(civId).name
  }
  catch {
    return ''
  }
}

function toSnapshotRow(row: CivAggregate, completedMatchCount: number): CivLeaderboardSnapshotRow {
  return {
    civId: row.civId,
    leaderName: row.leaderName,
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
      updatedAt: snapshot.updatedAt,
      completedMatchCount: snapshot.completedMatchCount,
      rows: snapshot.rows,
    } satisfies StoredCivLeaderboardSnapshot),
  }])
}

export function normalizeCivLeaderboardSnapshot(value: unknown): CivLeaderboardSnapshot | null {
  if (!value || typeof value !== 'object') return null

  const raw = value as StoredCivLeaderboardSnapshot
  if (!Array.isArray(raw.rows)) return null

  return {
    updatedAt: normalizeNonNegativeInteger(raw.updatedAt) ?? 0,
    completedMatchCount: normalizeNonNegativeInteger(raw.completedMatchCount) ?? 0,
    rows: raw.rows
      .map(normalizeCivLeaderboardSnapshotRow)
      .filter((row): row is CivLeaderboardSnapshotRow => row !== null && !isRedDeathFaction(row.civId)),
  }
}

function isRedDeathFaction(civId: string): boolean {
  return redDeathLeaderMap.has(civId)
}

function isRedDeathMatch(draftData: string | null): boolean {
  return parseDraftData(draftData)?.redDeath === true
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
