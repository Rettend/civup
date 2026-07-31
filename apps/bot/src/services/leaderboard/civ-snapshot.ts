import type { Database } from '@civup/db'
import type { LeaderDataVersion } from '@civup/game'
import type { StatsContext } from '../stats/context.ts'
import {
  civStatPoolTotals as legacyCivStatPoolTotals,
  civStats as legacyCivStats,
  civStatTotals as legacyCivStatTotals,
  matchCivStatContributions as legacyMatchCivStatContributions,
  matches,
  matchParticipants,
  scopedCivStatPoolTotals as civStatPoolTotals,
  scopedCivStats as civStats,
  scopedCivStatTotals as civStatTotals,
  scopedMatchCivStatContributions as matchCivStatContributions,
  tournamentMatches,
} from '@civup/db'
import { getLeader, getLeaderIds, liveLeaderDataVersionLabel, normalizeAvailableLeaderDataVersion, parseGameMode, redDeathLeaderMap, toLeaderboardMode } from '@civup/game'
import { and, eq, inArray, not, or, sql } from 'drizzle-orm'
import { kvMdelete, kvMget, kvMput } from '../kv/batch.ts'

export type CivLeaderboardSource = 'live' | 'beta'
export type CivLeaderboardModeScope = 'all' | 'duel' | 'duo' | 'squad'

export const CIV_LEADERBOARD_MODE_SCOPES: readonly CivLeaderboardModeScope[] = ['all', 'duel', 'duo', 'squad']

export interface CivLeaderboardSnapshotRow {
  civId: string
  leaderName: string
  picks: number
  bans: number
  wins: number
  poolGames: number
  pickRatePct: number | null
  winRatePct: number | null
  banRatePct: number | null
}

export interface CivLeaderboardSnapshot {
  updatedAt: number
  historyInitialized: boolean
  label: string
  modeScope: CivLeaderboardModeScope
  completedMatchCount: number
  rows: CivLeaderboardSnapshotRow[]
}

export interface CivLeaderboardDisplayConfig {
  version: 1
  label: string
  liveFrom: number
  betaFrom: number | null
  betaUntil: number | null
  pendingBetaFrom: number
}

export interface CivLeaderboardStatsStatus {
  historyInitialized: boolean
  historyInitializedAt: number | null
  completedMatchCount: number
  contributionRowCount: number
  civRowCount: number
  snapshotUpdatedAt: number | null
  snapshotRowCount: number
}

export interface CivLeaderboardStatsRebuildResult {
  snapshot: CivLeaderboardSnapshot
  status: CivLeaderboardStatsStatus
  scannedCompletedMatchCount: number
  scannedParticipantRowCount: number
  contributionRowCount: number
  civRowCount: number
}

interface StoredCivLeaderboardSnapshot {
  updatedAt?: unknown
  historyInitialized?: unknown
  label?: unknown
  modeScope?: unknown
  completedMatchCount?: unknown
  rows?: unknown
}

interface StoredCivLeaderboardDisplayConfig {
  version?: unknown
  label?: unknown
  liveFrom?: unknown
  betaFrom?: unknown
  betaUntil?: unknown
  pendingBetaFrom?: unknown
}

interface CivAggregate {
  civId: string
  leaderName: string
  picks: number
  bans: number
  wins: number
  poolGames: number
}

interface ParsedDraftData {
  manualReport?: unknown
  completedAt?: unknown
  leaderDataVersion?: unknown
  redDeath?: unknown
  civBlitz?: unknown
  state?: {
    availableCivIds?: unknown
    dealtCivIds?: unknown
    bans?: Array<{
      civId?: unknown
    }>
    picks?: Array<{
      civId?: unknown
    }>
    pendingBlindBans?: Array<{
      civId?: unknown
    }>
    submissions?: Record<string, unknown>
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
  source: CivLeaderboardSource
  modeScope: CivLeaderboardModeScope
  completedAt: number
  visible: boolean
  poolCivIds: string[]
  entries: CivStatContributionEntry[]
}

interface ContributionRow {
  completedMatchCount: number
  contributionsJson: string
  source: string
  modeScope: string
  completedAt: number
  visible: boolean
}

interface CivPoolTotalRow {
  modeScope: CivLeaderboardModeScope
  poolKey: string
  poolCivIds: string[]
  completedMatchCount: number
}

const CIV_STAT_INITIALIZED_SCOPE = 'history-initialized'
const INSERT_CHUNK_SIZE = 100

export function civLeaderboardSnapshotKey(statsContext: StatsContext, modeScope: CivLeaderboardModeScope = 'all'): string {
  return `stats:snapshot:${statsContext.statsKey}:civ:${modeScope}`
}

export function civLeaderboardDisplayConfigKey(statsContext: StatsContext): string {
  return `stats:config:${statsContext.statsKey}:civ`
}

export function defaultCivLeaderboardDisplayConfig(): CivLeaderboardDisplayConfig {
  return {
    version: 1,
    label: `BBG ${liveLeaderDataVersionLabel}`,
    liveFrom: 0,
    betaFrom: null,
    betaUntil: null,
    pendingBetaFrom: 0,
  }
}

export async function getStoredCivLeaderboardDisplayConfig(kv: KVNamespace, statsContext: StatsContext): Promise<CivLeaderboardDisplayConfig> {
  const [raw] = await kvMget(kv, [{ key: civLeaderboardDisplayConfigKey(statsContext), type: 'json' }])
  return normalizeCivLeaderboardDisplayConfig(raw)
}

export async function setCivLeaderboardDisplayConfig(kv: KVNamespace, statsContext: StatsContext, config: CivLeaderboardDisplayConfig): Promise<void> {
  await kvMput(kv, [{ key: civLeaderboardDisplayConfigKey(statsContext), value: JSON.stringify(config) }])
}

export async function ensureCivLeaderboardSnapshot(
  db: Database,
  kv: KVNamespace,
  statsContext: StatsContext,
  modeScope: CivLeaderboardModeScope = 'all',
): Promise<CivLeaderboardSnapshot> {
  const snapshot = await getStoredCivLeaderboardSnapshot(kv, statsContext, modeScope)
  if (snapshot) return snapshot
  return rebuildCivLeaderboardSnapshot(db, kv, statsContext, Date.now(), modeScope)
}

export async function getStoredCivLeaderboardSnapshot(
  kv: KVNamespace,
  statsContext: StatsContext,
  modeScope: CivLeaderboardModeScope = 'all',
): Promise<CivLeaderboardSnapshot | null> {
  const [raw] = await kvMget(kv, [{ key: civLeaderboardSnapshotKey(statsContext, modeScope), type: 'json' }])
  return normalizeCivLeaderboardSnapshot(raw, modeScope)
}

export async function getStoredCivLeaderboardSnapshots(
  kv: KVNamespace,
  statsContext: StatsContext,
  modeScopes: readonly CivLeaderboardModeScope[] = CIV_LEADERBOARD_MODE_SCOPES,
): Promise<Map<CivLeaderboardModeScope, CivLeaderboardSnapshot>> {
  const values = await kvMget(kv, modeScopes.map(modeScope => ({ key: civLeaderboardSnapshotKey(statsContext, modeScope), type: 'json' })))
  const snapshots = new Map<CivLeaderboardModeScope, CivLeaderboardSnapshot>()
  for (let index = 0; index < modeScopes.length; index++) {
    const modeScope = modeScopes[index]!
    const snapshot = normalizeCivLeaderboardSnapshot(values[index], modeScope)
    if (snapshot) snapshots.set(modeScope, snapshot)
  }
  return snapshots
}

export async function rebuildCivLeaderboardSnapshot(
  db: Database,
  kv: KVNamespace,
  statsContext: StatsContext,
  updatedAt = Date.now(),
  modeScope: CivLeaderboardModeScope = 'all',
): Promise<CivLeaderboardSnapshot> {
  const snapshots = await rebuildCivLeaderboardSnapshots(db, kv, statsContext, [modeScope], updatedAt)
  return snapshots.get(modeScope) ?? emptySnapshot(modeScope, defaultCivLeaderboardDisplayConfig().label, updatedAt, await isCivLeaderboardStatsInitialized(db, statsContext))
}

export async function rebuildCivLeaderboardSnapshots(
  db: Database,
  kv: KVNamespace,
  statsContext: StatsContext,
  modeScopes: readonly CivLeaderboardModeScope[] = CIV_LEADERBOARD_MODE_SCOPES,
  updatedAt = Date.now(),
): Promise<Map<CivLeaderboardModeScope, CivLeaderboardSnapshot>> {
  const [config, historyInitialized] = await Promise.all([
    getStoredCivLeaderboardDisplayConfig(kv, statsContext),
    isCivLeaderboardStatsInitialized(db, statsContext),
  ])
  const snapshots = await buildCivLeaderboardSnapshotsFromStats(db, statsContext, config, modeScopes, updatedAt, historyInitialized)
  await setCivLeaderboardSnapshots(kv, statsContext, snapshots)
  return snapshots
}

export async function buildCivLeaderboardSnapshotFromStats(
  db: Database,
  statsContext: StatsContext,
  updatedAt = Date.now(),
  modeScope: CivLeaderboardModeScope = 'all',
): Promise<CivLeaderboardSnapshot> {
  const config = defaultCivLeaderboardDisplayConfig()
  const snapshots = await buildCivLeaderboardSnapshotsFromStats(db, statsContext, config, [modeScope], updatedAt, await isCivLeaderboardStatsInitialized(db, statsContext))
  return snapshots.get(modeScope) ?? emptySnapshot(modeScope, config.label, updatedAt, false)
}

export async function rebuildCivLeaderboardStatsFromContributions(
  db: Database,
  statsContext: StatsContext,
  updatedAt = Date.now(),
): Promise<CivLeaderboardSnapshot> {
  return (await repairCivLeaderboardStatsFromContributions(db, statsContext, updatedAt)).snapshot
}

export async function repairCivLeaderboardStatsFromContributions(
  db: Database,
  statsContext: StatsContext,
  updatedAt = Date.now(),
  config: CivLeaderboardDisplayConfig = defaultCivLeaderboardDisplayConfig(),
): Promise<CivLeaderboardStatsRebuildResult> {
  const contributionRows = await db
    .select({
      completedMatchCount: matchCivStatContributions.completedMatchCount,
      contributionsJson: matchCivStatContributions.contributionsJson,
      source: matchCivStatContributions.source,
      modeScope: matchCivStatContributions.modeScope,
      completedAt: matchCivStatContributions.completedAt,
      visible: matchCivStatContributions.visible,
    })
    .from(matchCivStatContributions)
    .where(and(eq(matchCivStatContributions.statsKey, statsContext.statsKey), eligibleCivContributionCondition()))

  const rows = contributionRows.map(row => ({
    ...row,
    visible: isContributionVisible(row, config),
  }))

  await db.delete(civStats).where(eq(civStats.statsKey, statsContext.statsKey))
  await db.delete(civStatTotals).where(eq(civStatTotals.statsKey, statsContext.statsKey))
  await db.delete(civStatPoolTotals).where(eq(civStatPoolTotals.statsKey, statsContext.statsKey))
  if (writesLegacyStats(statsContext)) {
    await db.delete(legacyCivStats)
    await db.delete(legacyCivStatTotals)
    await db.delete(legacyCivStatPoolTotals)
  }
  await setStoredContributionVisibilityFromConfig(db, statsContext, config, updatedAt)
  await replaceVisibleCivStatsFromContributionRows(db, statsContext, rows, updatedAt)
  await markCivLeaderboardStatsInitialized(db, statsContext, updatedAt)
  const snapshot = snapshotFromContributionRows(rows.filter(row => row.visible), 'all', config.label, updatedAt, true)
  return {
    snapshot,
    status: await getCivLeaderboardStatsStatus(db, statsContext),
    scannedCompletedMatchCount: snapshot.completedMatchCount,
    scannedParticipantRowCount: 0,
    contributionRowCount: contributionRows.length,
    civRowCount: snapshot.rows.length,
  }
}

export async function rebuildCivLeaderboardStatsFromD1(
  db: Database,
  statsContext: StatsContext,
  updatedAt = Date.now(),
): Promise<CivLeaderboardSnapshot> {
  return (await backfillCivLeaderboardStatsFromHistory(db, statsContext, updatedAt)).snapshot
}

export async function backfillCivLeaderboardStatsFromHistory(
  db: Database,
  statsContext: StatsContext,
  updatedAt = Date.now(),
  config: CivLeaderboardDisplayConfig = defaultCivLeaderboardDisplayConfig(),
): Promise<CivLeaderboardStatsRebuildResult> {
  const [matchRows, participantRows] = await Promise.all([
    db
      .select({
        id: matches.id,
        gameMode: matches.gameMode,
        draftData: matches.draftData,
        completedAt: matches.completedAt,
      })
      .from(matches)
      .where(and(eq(matches.status, 'completed'), eq(matches.guildId, statsContext.guildId), excludeTournamentMatchesCondition())),
    db
      .select({
        matchId: matchParticipants.matchId,
        civId: matchParticipants.civId,
        placement: matchParticipants.placement,
      })
      .from(matchParticipants)
      .innerJoin(matches, eq(matchParticipants.matchId, matches.id))
      .where(and(eq(matches.status, 'completed'), eq(matches.guildId, statsContext.guildId), excludeTournamentMatchesCondition())),
  ])

  const participantsByMatchId = new Map<string, Array<{ civId: string | null, placement: number | null }>>()
  for (const row of participantRows) {
    const rows = participantsByMatchId.get(row.matchId) ?? []
    rows.push({ civId: row.civId, placement: row.placement })
    participantsByMatchId.set(row.matchId, rows)
  }

  const contributionRows: Array<typeof matchCivStatContributions.$inferInsert> = []
  const snapshotRows: ContributionRow[] = []
  let completedMatchCount = 0

  for (const match of matchRows) {
    const contribution = buildMatchCivStatContribution(match, participantsByMatchId.get(match.id) ?? [])
    completedMatchCount += contribution.completedMatchCount

    if (contribution.completedMatchCount > 0) {
      const row = toContributionInsertRow(statsContext, match.id, contribution, updatedAt)
      contributionRows.push(row)
      snapshotRows.push({
        completedMatchCount: contribution.completedMatchCount,
        contributionsJson: serializeContributionPayload(contribution),
        source: contribution.source,
        modeScope: contribution.modeScope,
        completedAt: contribution.completedAt,
        visible: isContributionVisible(contribution, config),
      })
    }
  }

  await db.delete(civStats).where(eq(civStats.statsKey, statsContext.statsKey))
  await db.delete(civStatTotals).where(eq(civStatTotals.statsKey, statsContext.statsKey))
  await db.delete(civStatPoolTotals).where(eq(civStatPoolTotals.statsKey, statsContext.statsKey))
  await db.delete(matchCivStatContributions).where(eq(matchCivStatContributions.statsKey, statsContext.statsKey))
  if (writesLegacyStats(statsContext)) {
    await db.delete(legacyCivStats)
    await db.delete(legacyCivStatTotals)
    await db.delete(legacyCivStatPoolTotals)
    await db.delete(legacyMatchCivStatContributions)
  }

  for (let index = 0; index < contributionRows.length; index += INSERT_CHUNK_SIZE) {
    const chunk = contributionRows.slice(index, index + INSERT_CHUNK_SIZE)
    if (chunk.length > 0) {
      await db.insert(matchCivStatContributions).values(chunk)
      if (writesLegacyStats(statsContext)) {
        await db.insert(legacyMatchCivStatContributions).values(chunk.map(({ statsKey: _statsKey, ...row }) => row))
      }
    }
  }

  await replaceVisibleCivStatsFromContributionRows(db, statsContext, snapshotRows, updatedAt)
  await markCivLeaderboardStatsInitialized(db, statsContext, updatedAt)

  const snapshot = snapshotFromContributionRows(snapshotRows.filter(row => isContributionVisible(row, config)), 'all', config.label, updatedAt, true)
  return {
    snapshot,
    status: await getCivLeaderboardStatsStatus(db, statsContext),
    scannedCompletedMatchCount: matchRows.length,
    scannedParticipantRowCount: participantRows.length,
    contributionRowCount: contributionRows.length,
    civRowCount: snapshot.rows.length,
  }
}

export async function isCivLeaderboardStatsInitialized(db: Database, statsContext: StatsContext): Promise<boolean> {
  const [row] = await db
    .select({ scope: civStatTotals.scope })
    .from(civStatTotals)
    .where(and(eq(civStatTotals.statsKey, statsContext.statsKey), eq(civStatTotals.scope, CIV_STAT_INITIALIZED_SCOPE)))
    .limit(1)
  return Boolean(row)
}

export async function getCivLeaderboardStatsStatus(
  db: Database,
  statsContext: StatsContext,
  kv?: KVNamespace,
): Promise<CivLeaderboardStatsStatus> {
  const [initializedRows, totalRows, contributionCounts, civCounts, snapshot] = await Promise.all([
    db
      .select({ updatedAt: civStatTotals.updatedAt })
      .from(civStatTotals)
      .where(and(eq(civStatTotals.statsKey, statsContext.statsKey), eq(civStatTotals.scope, CIV_STAT_INITIALIZED_SCOPE)))
      .limit(1),
    db
      .select({ completedMatchCount: civStatPoolTotals.completedMatchCount })
      .from(civStatPoolTotals).where(eq(civStatPoolTotals.statsKey, statsContext.statsKey)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(matchCivStatContributions).where(eq(matchCivStatContributions.statsKey, statsContext.statsKey)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(civStats).where(eq(civStats.statsKey, statsContext.statsKey)),
    kv ? getStoredCivLeaderboardSnapshot(kv, statsContext) : Promise.resolve(null),
  ])

  const initializedAt = normalizeNonNegativeInteger(initializedRows[0]?.updatedAt) ?? null
  return {
    historyInitialized: initializedAt != null,
    historyInitializedAt: initializedAt,
    completedMatchCount: totalRows.reduce((total, row) => total + normalizeCount(row.completedMatchCount), 0),
    contributionRowCount: normalizeCount(contributionCounts[0]?.count),
    civRowCount: normalizeCount(civCounts[0]?.count),
    snapshotUpdatedAt: snapshot?.updatedAt ?? null,
    snapshotRowCount: snapshot?.rows.length ?? 0,
  }
}

export async function reconcileCivLeaderboardMatchContribution(
  db: Database,
  statsContext: StatsContext,
  matchId: string,
  updatedAt = Date.now(),
): Promise<void> {
  if (await isTournamentMatchId(db, matchId)) {
    await replaceCivLeaderboardMatchContribution(db, statsContext, matchId, null)
    return
  }

  const [match] = await db
    .select({ id: matches.id, status: matches.status, draftData: matches.draftData, gameMode: matches.gameMode, completedAt: matches.completedAt, guildId: matches.guildId })
    .from(matches)
    .where(eq(matches.id, matchId))
    .limit(1)

  if (!match || match.guildId !== statsContext.guildId || match.status !== 'completed') {
    await replaceCivLeaderboardMatchContribution(db, statsContext, matchId, null)
    return
  }

  const participants = await db
    .select({ civId: matchParticipants.civId, placement: matchParticipants.placement })
    .from(matchParticipants)
    .where(eq(matchParticipants.matchId, matchId))

  await replaceCivLeaderboardMatchContribution(
    db,
    statsContext,
    matchId,
    buildMatchCivStatContribution(match, participants),
    updatedAt,
  )
}

export async function removeCivLeaderboardMatchContribution(
  db: Database,
  statsContext: StatsContext,
  matchId: string,
): Promise<void> {
  await replaceCivLeaderboardMatchContribution(db, statsContext, matchId, null)
}

export async function buildCivLeaderboardSnapshotFromD1(
  db: Database,
  statsContext: StatsContext,
  updatedAt = Date.now(),
): Promise<CivLeaderboardSnapshot> {
  const [matchRows, participantRows] = await Promise.all([
    db
      .select({
        id: matches.id,
        gameMode: matches.gameMode,
        draftData: matches.draftData,
        completedAt: matches.completedAt,
      })
      .from(matches)
      .where(and(eq(matches.status, 'completed'), eq(matches.guildId, statsContext.guildId), excludeTournamentMatchesCondition())),
    db
      .select({
        matchId: matchParticipants.matchId,
        civId: matchParticipants.civId,
        placement: matchParticipants.placement,
      })
      .from(matchParticipants)
      .innerJoin(matches, eq(matchParticipants.matchId, matches.id))
      .where(and(eq(matches.status, 'completed'), eq(matches.guildId, statsContext.guildId), excludeTournamentMatchesCondition())),
  ])

  const participantsByMatchId = new Map<string, Array<{ civId: string | null, placement: number | null }>>()
  for (const row of participantRows) {
    const rows = participantsByMatchId.get(row.matchId) ?? []
    rows.push({ civId: row.civId, placement: row.placement })
    participantsByMatchId.set(row.matchId, rows)
  }

  const config = defaultCivLeaderboardDisplayConfig()
  const rows = matchRows.flatMap((match): ContributionRow[] => {
    const contribution = buildMatchCivStatContribution(match, participantsByMatchId.get(match.id) ?? [])
    if (contribution.completedMatchCount <= 0) return []
    return [{
      completedMatchCount: contribution.completedMatchCount,
      contributionsJson: serializeContributionPayload(contribution),
      source: contribution.source,
      modeScope: contribution.modeScope,
      completedAt: contribution.completedAt,
      visible: isContributionVisible(contribution, config),
    }]
  })

  return snapshotFromContributionRows(rows.filter(row => isContributionVisible(row, config)), 'all', config.label, updatedAt, true)
}

async function buildCivLeaderboardSnapshotsFromStats(
  db: Database,
  statsContext: StatsContext,
  config: CivLeaderboardDisplayConfig,
  modeScopes: readonly CivLeaderboardModeScope[],
  updatedAt: number,
  historyInitialized: boolean,
): Promise<Map<CivLeaderboardModeScope, CivLeaderboardSnapshot>> {
  const requestedModeScopes = [...new Set(modeScopes)]
  const readModeScopes = expandCivStatReadModeScopes(requestedModeScopes)
  const [statRows, poolRows] = await Promise.all([
    readModeScopes.length > 0
      ? db
          .select({
            modeScope: civStats.modeScope,
            civId: civStats.civId,
            picks: civStats.picks,
            wins: civStats.wins,
            bans: civStats.bans,
          })
          .from(civStats)
          .where(and(eq(civStats.statsKey, statsContext.statsKey), inArray(civStats.modeScope, readModeScopes)))
      : Promise.resolve([]),
    readModeScopes.length > 0
      ? db
          .select({
            modeScope: civStatPoolTotals.modeScope,
            poolCivIdsJson: civStatPoolTotals.poolCivIdsJson,
            completedMatchCount: civStatPoolTotals.completedMatchCount,
          })
          .from(civStatPoolTotals)
          .where(and(eq(civStatPoolTotals.statsKey, statsContext.statsKey), inArray(civStatPoolTotals.modeScope, readModeScopes)))
      : Promise.resolve([]),
  ])

  const completedMatchCountByScope = new Map<CivLeaderboardModeScope, number>()
  const poolGamesByScope = new Map<CivLeaderboardModeScope, Map<string, number>>()
  for (const row of poolRows) {
    const modeScope = normalizeModeScope(row.modeScope)
    if (!modeScope) continue
    const completedMatchCount = normalizeCount(row.completedMatchCount)
    if (completedMatchCount <= 0) continue
    completedMatchCountByScope.set(modeScope, (completedMatchCountByScope.get(modeScope) ?? 0) + completedMatchCount)
    const poolGames = getPoolGamesMap(poolGamesByScope, modeScope)
    for (const civId of parsePoolCivIds(row.poolCivIdsJson)) {
      if (isRedDeathFaction(civId)) continue
      poolGames.set(civId, (poolGames.get(civId) ?? 0) + completedMatchCount)
    }
  }

  const aggregatesByScope = new Map<CivLeaderboardModeScope, Map<string, CivAggregate>>()
  for (const row of statRows) {
    const modeScope = normalizeModeScope(row.modeScope)
    if (!modeScope) continue
    const aggregate = getCivAggregate(getAggregatesMap(aggregatesByScope, modeScope), row.civId)
    aggregate.picks += normalizeCount(row.picks)
    aggregate.wins += normalizeCount(row.wins)
    aggregate.bans += normalizeCount(row.bans)
  }

  const snapshots = new Map<CivLeaderboardModeScope, CivLeaderboardSnapshot>()
  for (const modeScope of requestedModeScopes) {
    const sourceModeScopes = modeScope === 'all' ? CIV_LEADERBOARD_MODE_SCOPES : [modeScope]
    const aggregates = combineAggregateScopes(aggregatesByScope, sourceModeScopes)
    const poolGames = combinePoolGamesScopes(poolGamesByScope, sourceModeScopes)
    const completedMatchCount = sourceModeScopes.reduce((total, sourceModeScope) => total + (completedMatchCountByScope.get(sourceModeScope) ?? 0), 0)
    for (const aggregate of aggregates.values()) {
      aggregate.poolGames = poolGames.get(aggregate.civId) ?? (completedMatchCount > 0 ? completedMatchCount : 0)
    }
    snapshots.set(modeScope, snapshotFromAggregates(aggregates, modeScope, config.label, completedMatchCount, updatedAt, historyInitialized))
  }
  return snapshots
}

async function setStoredContributionVisibilityFromConfig(
  db: Database,
  statsContext: StatsContext,
  config: CivLeaderboardDisplayConfig,
  updatedAt: number,
): Promise<void> {
  const visibleCondition = and(contributionVisibleCondition(config), eligibleCivContributionCondition()) ?? sql`1 = 0`
  await db
    .update(matchCivStatContributions)
    .set({ visible: false, updatedAt })
    .where(and(eq(matchCivStatContributions.statsKey, statsContext.statsKey), eq(matchCivStatContributions.visible, true), not(visibleCondition)))
  await db
    .update(matchCivStatContributions)
    .set({ visible: true, updatedAt })
    .where(and(eq(matchCivStatContributions.statsKey, statsContext.statsKey), eq(matchCivStatContributions.visible, false), visibleCondition))

  if (writesLegacyStats(statsContext)) {
    const legacyVisibleCondition = legacyContributionVisibleCondition(config) ?? sql`1 = 0`
    await db
      .update(legacyMatchCivStatContributions)
      .set({ visible: false, updatedAt })
      .where(and(eq(legacyMatchCivStatContributions.visible, true), not(legacyVisibleCondition)))
    await db
      .update(legacyMatchCivStatContributions)
      .set({ visible: true, updatedAt })
      .where(and(eq(legacyMatchCivStatContributions.visible, false), legacyVisibleCondition))
  }
}

function contributionVisibleCondition(config: CivLeaderboardDisplayConfig) {
  const liveCondition = and(
    eq(matchCivStatContributions.source, 'live'),
    sql`${matchCivStatContributions.completedAt} >= ${config.liveFrom}`,
  )
  const betaCondition = config.betaFrom == null
    ? undefined
    : and(
        eq(matchCivStatContributions.source, 'beta'),
        sql`${matchCivStatContributions.completedAt} >= ${config.betaFrom}`,
        config.betaUntil == null
          ? sql`1 = 1`
          : sql`${matchCivStatContributions.completedAt} < ${config.betaUntil}`,
      )
  return betaCondition ? or(liveCondition, betaCondition) : liveCondition
}

function legacyContributionVisibleCondition(config: CivLeaderboardDisplayConfig) {
  const liveCondition = and(
    eq(legacyMatchCivStatContributions.source, 'live'),
    sql`${legacyMatchCivStatContributions.completedAt} >= ${config.liveFrom}`,
  )
  const betaCondition = config.betaFrom == null
    ? undefined
    : and(
        eq(legacyMatchCivStatContributions.source, 'beta'),
        sql`${legacyMatchCivStatContributions.completedAt} >= ${config.betaFrom}`,
        config.betaUntil == null
          ? sql`1 = 1`
          : sql`${legacyMatchCivStatContributions.completedAt} < ${config.betaUntil}`,
      )
  return betaCondition ? or(liveCondition, betaCondition) : liveCondition
}

async function replaceCivLeaderboardMatchContribution(
  db: Database,
  statsContext: StatsContext,
  matchId: string,
  next: MatchCivStatContribution | null,
  updatedAt: number = Date.now(),
): Promise<void> {
  const previous = await getCivLeaderboardMatchContribution(db, statsContext, matchId)

  if (next && next.completedMatchCount > 0) {
    const values = toContributionInsertRow(statsContext, matchId, next, updatedAt)
    await db
      .insert(matchCivStatContributions)
      .values(values)
      .onConflictDoUpdate({
        target: [matchCivStatContributions.statsKey, matchCivStatContributions.matchId],
        set: {
          completedMatchCount: values.completedMatchCount,
          contributionsJson: values.contributionsJson,
          source: values.source,
          modeScope: values.modeScope,
          completedAt: values.completedAt,
          visible: values.visible,
          updatedAt,
        },
      })
    if (writesLegacyStats(statsContext)) {
      const { statsKey: _statsKey, ...legacyValues } = values
      await db
        .insert(legacyMatchCivStatContributions)
        .values(legacyValues)
        .onConflictDoUpdate({
          target: legacyMatchCivStatContributions.matchId,
          set: {
            completedMatchCount: legacyValues.completedMatchCount,
            contributionsJson: legacyValues.contributionsJson,
            source: legacyValues.source,
            modeScope: legacyValues.modeScope,
            completedAt: legacyValues.completedAt,
            visible: legacyValues.visible,
            updatedAt,
          },
        })
    }
    await applyCivLeaderboardAggregateDelta(db, statsContext, previous, next, updatedAt)
    return
  }

  await db.delete(matchCivStatContributions).where(and(eq(matchCivStatContributions.statsKey, statsContext.statsKey), eq(matchCivStatContributions.matchId, matchId)))
  if (writesLegacyStats(statsContext)) await db.delete(legacyMatchCivStatContributions).where(eq(legacyMatchCivStatContributions.matchId, matchId))
  await applyCivLeaderboardAggregateDelta(db, statsContext, previous, null, updatedAt)
}

async function getCivLeaderboardMatchContribution(
  db: Database,
  statsContext: StatsContext,
  matchId: string,
): Promise<MatchCivStatContribution | null> {
  const [row] = await db
    .select({
      completedMatchCount: matchCivStatContributions.completedMatchCount,
      contributionsJson: matchCivStatContributions.contributionsJson,
      source: matchCivStatContributions.source,
      modeScope: matchCivStatContributions.modeScope,
      completedAt: matchCivStatContributions.completedAt,
      visible: matchCivStatContributions.visible,
    })
    .from(matchCivStatContributions)
    .where(and(eq(matchCivStatContributions.statsKey, statsContext.statsKey), eq(matchCivStatContributions.matchId, matchId)))
    .limit(1)

  if (!row) return null
  const source = normalizeContributionSource(row.source)
  const payload = parseContributionPayload(row.contributionsJson, source)
  return {
    completedMatchCount: normalizeCount(row.completedMatchCount),
    source,
    modeScope: normalizeModeScope(row.modeScope) ?? 'all',
    completedAt: normalizeCompletedAt(row.completedAt),
    visible: row.visible === true,
    poolCivIds: payload.poolCivIds,
    entries: payload.entries,
  }
}

async function applyCivLeaderboardAggregateDelta(
  db: Database,
  statsContext: StatsContext,
  previous: MatchCivStatContribution | null,
  next: MatchCivStatContribution | null,
  updatedAt: number,
): Promise<void> {
  const statDeltas = new Map<string, { modeScope: CivLeaderboardModeScope, civId: string, picks: number, wins: number, bans: number }>()
  const poolDeltas = new Map<string, { modeScope: CivLeaderboardModeScope, poolKey: string, poolCivIds: string[], completedMatchCount: number }>()

  addAggregateContributionDelta(statDeltas, poolDeltas, previous, -1)
  addAggregateContributionDelta(statDeltas, poolDeltas, next, 1)

  for (const delta of statDeltas.values()) {
    if (delta.picks === 0 && delta.wins === 0 && delta.bans === 0) continue
    await db
      .insert(civStats)
      .values({
        statsKey: statsContext.statsKey,
        modeScope: delta.modeScope,
        civId: delta.civId,
        picks: Math.max(0, delta.picks),
        wins: Math.max(0, delta.wins),
        bans: Math.max(0, delta.bans),
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [civStats.statsKey, civStats.modeScope, civStats.civId],
        set: {
          picks: sql<number>`max(0, ${civStats.picks} + ${delta.picks})`,
          wins: sql<number>`max(0, ${civStats.wins} + ${delta.wins})`,
          bans: sql<number>`max(0, ${civStats.bans} + ${delta.bans})`,
          updatedAt,
        },
      })
    if (writesLegacyStats(statsContext)) {
      await db
        .insert(legacyCivStats)
        .values({
          modeScope: delta.modeScope,
          civId: delta.civId,
          picks: Math.max(0, delta.picks),
          wins: Math.max(0, delta.wins),
          bans: Math.max(0, delta.bans),
          updatedAt,
        })
        .onConflictDoUpdate({
          target: [legacyCivStats.modeScope, legacyCivStats.civId],
          set: {
            picks: sql<number>`max(0, ${legacyCivStats.picks} + ${delta.picks})`,
            wins: sql<number>`max(0, ${legacyCivStats.wins} + ${delta.wins})`,
            bans: sql<number>`max(0, ${legacyCivStats.bans} + ${delta.bans})`,
            updatedAt,
          },
        })
    }

    if (delta.picks < 0 || delta.wins < 0 || delta.bans < 0) {
      await db
        .delete(civStats)
        .where(and(
          eq(civStats.statsKey, statsContext.statsKey),
          eq(civStats.modeScope, delta.modeScope),
          eq(civStats.civId, delta.civId),
          sql`${civStats.picks} <= 0 and ${civStats.wins} <= 0 and ${civStats.bans} <= 0`,
        ))
      if (writesLegacyStats(statsContext)) {
        await db
          .delete(legacyCivStats)
          .where(and(
            eq(legacyCivStats.modeScope, delta.modeScope),
            eq(legacyCivStats.civId, delta.civId),
            sql`${legacyCivStats.picks} <= 0 and ${legacyCivStats.wins} <= 0 and ${legacyCivStats.bans} <= 0`,
          ))
      }
    }
  }

  for (const delta of poolDeltas.values()) {
    if (delta.completedMatchCount === 0) continue
    await db
      .insert(civStatPoolTotals)
      .values({
        statsKey: statsContext.statsKey,
        modeScope: delta.modeScope,
        poolKey: delta.poolKey,
        poolCivIdsJson: JSON.stringify(delta.poolCivIds),
        completedMatchCount: Math.max(0, delta.completedMatchCount),
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [civStatPoolTotals.statsKey, civStatPoolTotals.modeScope, civStatPoolTotals.poolKey],
        set: {
          poolCivIdsJson: JSON.stringify(delta.poolCivIds),
          completedMatchCount: sql<number>`max(0, ${civStatPoolTotals.completedMatchCount} + ${delta.completedMatchCount})`,
          updatedAt,
        },
      })
    if (writesLegacyStats(statsContext)) {
      await db
        .insert(legacyCivStatPoolTotals)
        .values({
          modeScope: delta.modeScope,
          poolKey: delta.poolKey,
          poolCivIdsJson: JSON.stringify(delta.poolCivIds),
          completedMatchCount: Math.max(0, delta.completedMatchCount),
          updatedAt,
        })
        .onConflictDoUpdate({
          target: [legacyCivStatPoolTotals.modeScope, legacyCivStatPoolTotals.poolKey],
          set: {
            poolCivIdsJson: JSON.stringify(delta.poolCivIds),
            completedMatchCount: sql<number>`max(0, ${legacyCivStatPoolTotals.completedMatchCount} + ${delta.completedMatchCount})`,
            updatedAt,
          },
        })
    }

    if (delta.completedMatchCount < 0) {
      await db
        .delete(civStatPoolTotals)
        .where(and(
          eq(civStatPoolTotals.statsKey, statsContext.statsKey),
          eq(civStatPoolTotals.modeScope, delta.modeScope),
          eq(civStatPoolTotals.poolKey, delta.poolKey),
          sql`${civStatPoolTotals.completedMatchCount} <= 0`,
        ))
      if (writesLegacyStats(statsContext)) {
        await db
          .delete(legacyCivStatPoolTotals)
          .where(and(
            eq(legacyCivStatPoolTotals.modeScope, delta.modeScope),
            eq(legacyCivStatPoolTotals.poolKey, delta.poolKey),
            sql`${legacyCivStatPoolTotals.completedMatchCount} <= 0`,
          ))
      }
    }
  }
}

function addAggregateContributionDelta(
  statDeltas: Map<string, { modeScope: CivLeaderboardModeScope, civId: string, picks: number, wins: number, bans: number }>,
  poolDeltas: Map<string, { modeScope: CivLeaderboardModeScope, poolKey: string, poolCivIds: string[], completedMatchCount: number }>,
  contribution: MatchCivStatContribution | null,
  direction: 1 | -1,
): void {
  if (!contribution?.visible || contribution.completedMatchCount <= 0) return
  const modeScopes = aggregateModeScopes(contribution.modeScope)
  const completedMatchCountDelta = direction * normalizeCount(contribution.completedMatchCount)
  const poolCivIds = uniqueStrings(contribution.poolCivIds).filter(civId => civId.length > 0 && !isRedDeathFaction(civId)).sort((left, right) => left.localeCompare(right))
  const poolKey = poolCivIds.join('|')

  for (const modeScope of modeScopes) {
    if (poolKey.length > 0) {
      const key = `${modeScope}\0${poolKey}`
      const delta = poolDeltas.get(key) ?? { modeScope, poolKey, poolCivIds, completedMatchCount: 0 }
      delta.completedMatchCount += completedMatchCountDelta
      poolDeltas.set(key, delta)
    }

    for (const entry of contribution.entries) {
      if (isRedDeathFaction(entry.civId)) continue
      const key = `${modeScope}\0${entry.civId}`
      const delta = statDeltas.get(key) ?? { modeScope, civId: entry.civId, picks: 0, wins: 0, bans: 0 }
      delta.picks += direction * normalizeCount(entry.picks)
      delta.wins += direction * normalizeCount(entry.wins)
      delta.bans += direction * normalizeCount(entry.bans)
      statDeltas.set(key, delta)
    }
  }
}

async function replaceVisibleCivStatsFromContributionRows(
  db: Database,
  statsContext: StatsContext,
  rows: readonly ContributionRow[],
  updatedAt: number,
): Promise<void> {
  const statDeltas = new Map<string, { modeScope: CivLeaderboardModeScope, civId: string, picks: number, wins: number, bans: number }>()
  const poolDeltas = new Map<string, { modeScope: CivLeaderboardModeScope, poolKey: string, poolCivIds: string[], completedMatchCount: number }>()

  for (const row of rows) {
    if (!row.visible) continue
    const source = normalizeContributionSource(row.source)
    const payload = parseContributionPayload(row.contributionsJson, source)
    addAggregateContributionDelta(statDeltas, poolDeltas, {
      completedMatchCount: normalizeCount(row.completedMatchCount),
      source,
      modeScope: normalizeModeScope(row.modeScope) ?? 'all',
      completedAt: normalizeCompletedAt(row.completedAt),
      visible: true,
      poolCivIds: payload.poolCivIds,
      entries: payload.entries,
    }, 1)
  }

  const statRows = [...statDeltas.values()].flatMap(delta => delta.picks > 0 || delta.wins > 0 || delta.bans > 0
    ? [{
        statsKey: statsContext.statsKey,
        modeScope: delta.modeScope,
        civId: delta.civId,
        picks: Math.max(0, delta.picks),
        wins: Math.max(0, delta.wins),
        bans: Math.max(0, delta.bans),
        updatedAt,
      }]
    : [])
  for (let index = 0; index < statRows.length; index += INSERT_CHUNK_SIZE) {
    const chunk = statRows.slice(index, index + INSERT_CHUNK_SIZE)
    if (chunk.length > 0) {
      await db.insert(civStats).values(chunk)
      if (writesLegacyStats(statsContext)) await db.insert(legacyCivStats).values(chunk.map(({ statsKey: _statsKey, ...row }) => row))
    }
  }

  const poolRows = [...poolDeltas.values()].flatMap(delta => delta.completedMatchCount > 0
    ? [{
        statsKey: statsContext.statsKey,
        modeScope: delta.modeScope,
        poolKey: delta.poolKey,
        poolCivIdsJson: JSON.stringify(delta.poolCivIds),
        completedMatchCount: delta.completedMatchCount,
        updatedAt,
      }]
    : [])
  for (let index = 0; index < poolRows.length; index += INSERT_CHUNK_SIZE) {
    const chunk = poolRows.slice(index, index + INSERT_CHUNK_SIZE)
    if (chunk.length > 0) {
      await db.insert(civStatPoolTotals).values(chunk)
      if (writesLegacyStats(statsContext)) await db.insert(legacyCivStatPoolTotals).values(chunk.map(({ statsKey: _statsKey, ...row }) => row))
    }
  }
}

function toContributionInsertRow(
  statsContext: StatsContext,
  matchId: string,
  contribution: MatchCivStatContribution,
  updatedAt: number,
): typeof matchCivStatContributions.$inferInsert {
  return {
    statsKey: statsContext.statsKey,
    matchId,
    completedMatchCount: contribution.completedMatchCount,
    contributionsJson: serializeContributionPayload(contribution),
    source: contribution.source,
    modeScope: contribution.modeScope,
    completedAt: contribution.completedAt,
    visible: contribution.visible,
    updatedAt,
  }
}

async function markCivLeaderboardStatsInitialized(db: Database, statsContext: StatsContext, updatedAt: number): Promise<void> {
  await db
    .insert(civStatTotals)
    .values({
      statsKey: statsContext.statsKey,
      scope: CIV_STAT_INITIALIZED_SCOPE,
      completedMatchCount: 1,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: [civStatTotals.statsKey, civStatTotals.scope],
      set: {
        completedMatchCount: 1,
        updatedAt,
      },
    })
  if (writesLegacyStats(statsContext)) {
    await db
      .insert(legacyCivStatTotals)
      .values({
        scope: CIV_STAT_INITIALIZED_SCOPE,
        completedMatchCount: 1,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: legacyCivStatTotals.scope,
        set: {
          completedMatchCount: 1,
          updatedAt,
        },
      })
  }
}

function snapshotFromContributionRows(
  rows: readonly ContributionRow[],
  modeScope: CivLeaderboardModeScope,
  label: string,
  updatedAt: number,
  historyInitialized: boolean,
): CivLeaderboardSnapshot {
  const aggregateByCivId = new Map<string, CivAggregate>()
  let completedMatchCount = 0

  for (const row of rows) {
    const normalizedModeScope = normalizeModeScope(row.modeScope) ?? 'all'
    if (modeScope !== 'all' && normalizedModeScope !== modeScope) continue

    const completedCount = normalizeCount(row.completedMatchCount)
    if (completedCount <= 0) continue

    completedMatchCount += completedCount

    const source = normalizeContributionSource(row.source)
    const payload = parseContributionPayload(row.contributionsJson, source)
    for (const civId of payload.poolCivIds) {
      if (isRedDeathFaction(civId)) continue
      getCivAggregate(aggregateByCivId, civId).poolGames += completedCount
    }
    addContributionToAggregates(aggregateByCivId, payload.entries)
  }

  return {
    updatedAt,
    historyInitialized,
    label,
    modeScope,
    completedMatchCount,
    rows: [...aggregateByCivId.values()]
      .filter(row => row.picks > 0 || row.wins > 0 || row.bans > 0)
      .filter(row => !isRedDeathFaction(row.civId))
      .map(toSnapshotRow)
      .sort((left, right) => right.picks - left.picks || right.bans - left.bans || left.civId.localeCompare(right.civId)),
  }
}

function snapshotFromAggregates(
  aggregateByCivId: Map<string, CivAggregate>,
  modeScope: CivLeaderboardModeScope,
  label: string,
  completedMatchCount: number,
  updatedAt: number,
  historyInitialized: boolean,
): CivLeaderboardSnapshot {
  return {
    updatedAt,
    historyInitialized,
    label,
    modeScope,
    completedMatchCount,
    rows: [...aggregateByCivId.values()]
      .filter(row => row.picks > 0 || row.wins > 0 || row.bans > 0)
      .filter(row => !isRedDeathFaction(row.civId))
      .map(toSnapshotRow)
      .sort((left, right) => right.picks - left.picks || right.bans - left.bans || left.civId.localeCompare(right.civId)),
  }
}

function buildMatchCivStatContribution(
  match: { draftData: string | null, gameMode: string, completedAt: number | null },
  participants: readonly { civId: string | null, placement: number | null }[],
): MatchCivStatContribution {
  if (isRedDeathMatch(match.draftData)) return emptyMatchContribution(match)

  const source = getContributionSourceFromDraftData(match.draftData)
  const modeScope = getContributionModeScope(match.gameMode, match.draftData)
  if (!modeScope) return emptyMatchContribution(match)

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

  const entries = [...aggregateByCivId.values()]
    .filter(entry => entry.picks > 0 || entry.wins > 0 || entry.bans > 0)
    .map(entry => ({
      civId: entry.civId,
      picks: entry.picks,
      wins: entry.wins,
      bans: entry.bans,
    }))
    .sort((left, right) => left.civId.localeCompare(right.civId))

  return {
    completedMatchCount: 1,
    source,
    modeScope,
    completedAt: normalizeCompletedAt(match.completedAt ?? getCompletedAtFromDraftData(match.draftData)),
    // Keep the report/correction hot path config-free; beta windows are promoted by explicit rotate/backfill repair.
    visible: source === 'live',
    poolCivIds: resolveDraftPoolCivIds(match.draftData, source, entries),
    entries,
  }
}

function emptyMatchContribution(match: { draftData: string | null, completedAt: number | null }): MatchCivStatContribution {
  return {
    completedMatchCount: 0,
    source: getContributionSourceFromDraftData(match.draftData),
    modeScope: 'all',
    completedAt: normalizeCompletedAt(match.completedAt ?? getCompletedAtFromDraftData(match.draftData)),
    visible: false,
    poolCivIds: [],
    entries: [],
  }
}

async function isTournamentMatchId(db: Database, matchId: string): Promise<boolean> {
  const [row] = await db
    .select({ sessionId: tournamentMatches.sessionId })
    .from(tournamentMatches)
    .where(or(eq(tournamentMatches.matchId, matchId), eq(tournamentMatches.sessionId, matchId)))
    .limit(1)
  return row != null
}

function excludeTournamentMatchesCondition() {
  return sql`not exists (
    select 1 from ${tournamentMatches}
    where ${tournamentMatches.matchId} = ${matches.id}
       or ${tournamentMatches.sessionId} = ${matches.id}
  )`
}

function excludeTournamentContributionCondition() {
  return sql`not exists (
    select 1 from ${tournamentMatches}
    where ${tournamentMatches.matchId} = ${matchCivStatContributions.matchId}
       or ${tournamentMatches.sessionId} = ${matchCivStatContributions.matchId}
  )`
}

function eligibleCivContributionCondition() {
  return and(
    sql`exists (
      select 1 from ${matches}
      where ${matches.id} = ${matchCivStatContributions.matchId}
        and ${matches.status} = 'completed'
        and not coalesce(json_valid(${matches.draftData}) and json_extract(${matches.draftData}, '$.redDeath') = true, false)
        and not coalesce(json_valid(${matches.draftData}) and json_extract(${matches.draftData}, '$.civBlitz') = true, false)
    )`,
    excludeTournamentContributionCondition(),
  )
}

function addContributionToAggregates(
  aggregateByCivId: Map<string, CivAggregate>,
  entries: readonly CivStatContributionEntry[],
): void {
  for (const entry of entries) {
    if (isRedDeathFaction(entry.civId)) continue
    const aggregate = getCivAggregate(aggregateByCivId, entry.civId)
    aggregate.picks += entry.picks
    aggregate.wins += entry.wins
    aggregate.bans += entry.bans
  }
}

function serializeContributionPayload(contribution: MatchCivStatContribution): string {
  return JSON.stringify({
    version: 2,
    poolCivIds: uniqueStrings(contribution.poolCivIds).filter(civId => !isRedDeathFaction(civId)).sort((left, right) => left.localeCompare(right)),
    entries: normalizeContributionEntries(contribution.entries),
  })
}

function parseContributionPayload(raw: string, source: CivLeaderboardSource): { poolCivIds: string[], entries: CivStatContributionEntry[] } {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      const entries = parseContributionEntries(parsed)
      return { entries, poolCivIds: fallbackPoolCivIds(source, entries) }
    }

    if (!parsed || typeof parsed !== 'object') return { entries: [], poolCivIds: fallbackPoolCivIds(source, []) }
    const record = parsed as { poolCivIds?: unknown, entries?: unknown }
    const entries = parseContributionEntries(record.entries)
    const poolCivIds = Array.isArray(record.poolCivIds)
      ? uniqueStrings(record.poolCivIds.flatMap(value => typeof value === 'string' && value.length > 0 ? [value] : []))
      : fallbackPoolCivIds(source, entries)
    return { entries, poolCivIds: ensurePoolIncludesEntries(poolCivIds.length > 0 ? poolCivIds : fallbackPoolCivIds(source, entries), entries) }
  }
  catch {
    return { entries: [], poolCivIds: fallbackPoolCivIds(source, []) }
  }
}

function parseContributionEntries(value: unknown): CivStatContributionEntry[] {
  if (!Array.isArray(value)) return []
  return normalizeContributionEntries(value.flatMap((entry) => {
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
  }))
}

function normalizeContributionEntries(entries: readonly CivStatContributionEntry[]): CivStatContributionEntry[] {
  return entries
    .filter(entry => entry.civId.length > 0)
    .map(entry => ({
      civId: entry.civId,
      picks: normalizeCount(entry.picks),
      wins: normalizeCount(entry.wins),
      bans: normalizeCount(entry.bans),
    }))
    .filter(entry => entry.picks > 0 || entry.wins > 0 || entry.bans > 0)
    .sort((left, right) => left.civId.localeCompare(right.civId))
}

export async function clearCivLeaderboardSnapshot(kv: KVNamespace, statsContext: StatsContext): Promise<void> {
  await kvMdelete(kv, CIV_LEADERBOARD_MODE_SCOPES.map(modeScope => civLeaderboardSnapshotKey(statsContext, modeScope)))
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
    poolGames: 0,
  }
  aggregates.set(civId, created)
  return created
}

function resolveLeaderName(civId: string): string {
  try {
    return getLeader(civId).name
  }
  catch {
    try {
      return getLeader(civId, 'beta').name
    }
    catch {
      return ''
    }
  }
}

function toSnapshotRow(row: CivAggregate): CivLeaderboardSnapshotRow {
  return {
    civId: row.civId,
    leaderName: row.leaderName,
    picks: row.picks,
    bans: row.bans,
    wins: row.wins,
    poolGames: row.poolGames,
    pickRatePct: row.poolGames > 0 ? round((row.picks / row.poolGames) * 100, 1) : null,
    winRatePct: row.picks > 0 ? round((row.wins / row.picks) * 100, 1) : null,
    banRatePct: row.poolGames > 0 ? round((row.bans / row.poolGames) * 100, 1) : null,
  }
}

async function setCivLeaderboardSnapshots(
  kv: KVNamespace,
  statsContext: StatsContext,
  snapshots: ReadonlyMap<CivLeaderboardModeScope, CivLeaderboardSnapshot>,
): Promise<void> {
  await kvMput(kv, [...snapshots.entries()].map(([modeScope, snapshot]) => ({
    key: civLeaderboardSnapshotKey(statsContext, modeScope),
    value: JSON.stringify({
      updatedAt: snapshot.updatedAt,
      historyInitialized: snapshot.historyInitialized,
      label: snapshot.label,
      modeScope: snapshot.modeScope,
      completedMatchCount: snapshot.completedMatchCount,
      rows: snapshot.rows,
    } satisfies StoredCivLeaderboardSnapshot),
  })))
}

export function normalizeCivLeaderboardSnapshot(value: unknown, fallbackModeScope: CivLeaderboardModeScope = 'all'): CivLeaderboardSnapshot | null {
  if (!value || typeof value !== 'object') return null

  const raw = value as StoredCivLeaderboardSnapshot
  if (!Array.isArray(raw.rows)) return null
  if (!raw.rows.every(isCurrentCivLeaderboardSnapshotRowShape)) return null

  const modeScope = normalizeModeScope(raw.modeScope) ?? fallbackModeScope
  return {
    updatedAt: normalizeNonNegativeInteger(raw.updatedAt) ?? 0,
    historyInitialized: raw.historyInitialized === true,
    label: typeof raw.label === 'string' && raw.label.trim().length > 0 ? raw.label.trim() : defaultCivLeaderboardDisplayConfig().label,
    modeScope,
    completedMatchCount: normalizeNonNegativeInteger(raw.completedMatchCount) ?? 0,
    rows: raw.rows
      .map(normalizeCivLeaderboardSnapshotRow)
      .filter((row): row is CivLeaderboardSnapshotRow => row !== null && !isRedDeathFaction(row.civId)),
  }
}

function isCurrentCivLeaderboardSnapshotRowShape(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const raw = value as Record<string, unknown>
  return 'poolGames' in raw && 'pickRatePct' in raw && 'winRatePct' in raw && 'banRatePct' in raw
}

function normalizeCivLeaderboardDisplayConfig(value: unknown): CivLeaderboardDisplayConfig {
  const fallback = defaultCivLeaderboardDisplayConfig()
  if (!value || typeof value !== 'object') return fallback

  const raw = value as StoredCivLeaderboardDisplayConfig
  const label = typeof raw.label === 'string' && raw.label.trim().length > 0 ? raw.label.trim() : fallback.label
  const liveFrom = normalizeNonNegativeInteger(raw.liveFrom) ?? fallback.liveFrom
  const betaFrom = raw.betaFrom == null ? null : normalizeNonNegativeInteger(raw.betaFrom)
  const betaUntil = raw.betaUntil == null ? null : normalizeNonNegativeInteger(raw.betaUntil)
  return {
    version: 1,
    label,
    liveFrom,
    betaFrom,
    betaUntil,
    pendingBetaFrom: normalizeNonNegativeInteger(raw.pendingBetaFrom) ?? betaUntil ?? betaFrom ?? fallback.pendingBetaFrom,
  }
}

function isContributionVisible(row: { source: unknown, completedAt: unknown }, config: CivLeaderboardDisplayConfig): boolean {
  const source = normalizeContributionSource(row.source)
  const completedAt = normalizeCompletedAt(row.completedAt)
  if (source === 'live') return completedAt >= config.liveFrom
  if (config.betaFrom == null) return false
  return completedAt >= config.betaFrom && (config.betaUntil == null || completedAt < config.betaUntil)
}

function normalizeCivLeaderboardSnapshotRow(value: unknown): CivLeaderboardSnapshotRow | null {
  if (!value || typeof value !== 'object') return null

  const raw = value as Record<string, unknown>
  const civId = typeof raw.civId === 'string' && raw.civId.length > 0 ? raw.civId : null
  const picks = normalizeNonNegativeInteger(raw.picks)
  const bans = normalizeNonNegativeInteger(raw.bans)
  const wins = normalizeNonNegativeInteger(raw.wins)
  if (!civId || picks == null || bans == null || wins == null) return null

  const poolGames = normalizeNonNegativeInteger(raw.poolGames) ?? 0
  return {
    civId,
    leaderName: typeof raw.leaderName === 'string' ? raw.leaderName : '',
    picks,
    bans,
    wins,
    poolGames,
    pickRatePct: normalizeNullableNumber(raw.pickRatePct),
    winRatePct: normalizeNullableNumber(raw.winRatePct),
    banRatePct: normalizeNullableNumber(raw.banRatePct),
  }
}

function getContributionModeScope(gameMode: string, draftData: string | null): CivLeaderboardModeScope | null {
  const parsed = parseDraftData(draftData)
  if (parsed?.redDeath === true || parsed?.civBlitz === true) return null
  const mode = parseGameMode(gameMode)
  if (!mode) return null
  const leaderboardMode = toLeaderboardMode(mode, { redDeath: parsed?.redDeath === true, civBlitz: parsed?.civBlitz === true })
  if (leaderboardMode === 'duel' || leaderboardMode === 'duo' || leaderboardMode === 'squad') return leaderboardMode
  if (leaderboardMode === 'ffa') return 'all'
  return null
}

function getContributionSourceFromDraftData(draftData: string | null): CivLeaderboardSource {
  const parsed = parseDraftData(draftData)
  return normalizeAvailableLeaderDataVersion(parsed?.leaderDataVersion === 'beta' ? 'beta' : 'live') === 'beta' ? 'beta' : 'live'
}

function normalizeContributionSource(value: unknown): CivLeaderboardSource {
  return value === 'beta' ? 'beta' : 'live'
}

function normalizeModeScope(value: unknown): CivLeaderboardModeScope | null {
  if (value === 'all' || value === 'duel' || value === 'duo' || value === 'squad') return value
  return null
}

function fallbackPoolCivIds(source: CivLeaderboardSource, entries: readonly CivStatContributionEntry[]): string[] {
  return ensurePoolIncludesEntries(getLeaderIds(source).filter(civId => !isRedDeathFaction(civId)), entries)
}

function ensurePoolIncludesEntries(poolCivIds: readonly string[], entries: readonly CivStatContributionEntry[]): string[] {
  return uniqueStrings([
    ...poolCivIds,
    ...entries.map(entry => entry.civId),
  ]).filter(civId => civId.length > 0 && !isRedDeathFaction(civId))
}

function resolveDraftPoolCivIds(draftData: string | null, source: CivLeaderboardSource, entries: readonly CivStatContributionEntry[]): string[] {
  const parsed = parseDraftData(draftData)
  if (parsed?.manualReport === true) return fallbackPoolCivIds(source, entries)

  const state = parsed?.state
  const poolCivIds = uniqueStrings([
    ...normalizeStringArray(state?.availableCivIds),
    ...normalizeDraftSelectionCivIds(state?.bans),
    ...normalizeDraftSelectionCivIds(state?.picks),
    ...normalizeDraftSelectionCivIds(state?.pendingBlindBans),
    ...normalizeSubmissionsCivIds(state?.submissions),
    ...normalizeStringArray(state?.dealtCivIds),
  ]).filter(civId => civId.length > 0 && !isRedDeathFaction(civId))

  return poolCivIds.length > 0 ? ensurePoolIncludesEntries(poolCivIds, entries) : fallbackPoolCivIds(source, entries)
}

function extractDraftDataBanCivIds(draftData: string | null): string[] {
  const parsed = parseDraftData(draftData)
  return normalizeDraftSelectionCivIds(parsed?.state?.bans)
}

function getCompletedAtFromDraftData(draftData: string | null): number | null {
  const parsed = parseDraftData(draftData)
  return normalizeNonNegativeInteger(parsed?.completedAt)
}

function isRedDeathFaction(civId: string): boolean {
  return redDeathLeaderMap.has(civId)
}

function isRedDeathMatch(draftData: string | null): boolean {
  return parseDraftData(draftData)?.redDeath === true
}

function parseDraftData(draftData: string | null): ParsedDraftData | null {
  if (!draftData) return null
  try {
    const parsed: unknown = JSON.parse(draftData)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as ParsedDraftData
  }
  catch {
    return null
  }
}

function normalizeDraftSelectionCivIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((selection) => {
    if (!selection || typeof selection !== 'object') return []
    const civId = (selection as { civId?: unknown }).civId
    return typeof civId === 'string' && civId.length > 0 ? [civId] : []
  })
}

function normalizeSubmissionsCivIds(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.values(value).flatMap(normalizeStringArray)
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(candidate => typeof candidate === 'string' && candidate.length > 0 ? [candidate] : [])
}

function aggregateModeScopes(modeScope: CivLeaderboardModeScope): CivLeaderboardModeScope[] {
  return [modeScope]
}

function expandCivStatReadModeScopes(modeScopes: readonly CivLeaderboardModeScope[]): CivLeaderboardModeScope[] {
  return [...new Set(modeScopes.flatMap(modeScope => modeScope === 'all' ? CIV_LEADERBOARD_MODE_SCOPES : [modeScope]))]
}

function combineAggregateScopes(
  aggregatesByScope: Map<CivLeaderboardModeScope, Map<string, CivAggregate>>,
  modeScopes: readonly CivLeaderboardModeScope[],
): Map<string, CivAggregate> {
  const combined = new Map<string, CivAggregate>()
  for (const modeScope of modeScopes) {
    const aggregates = aggregatesByScope.get(modeScope)
    if (!aggregates) continue
    for (const row of aggregates.values()) {
      const aggregate = getCivAggregate(combined, row.civId)
      aggregate.picks += row.picks
      aggregate.wins += row.wins
      aggregate.bans += row.bans
    }
  }
  return combined
}

function combinePoolGamesScopes(
  poolGamesByScope: Map<CivLeaderboardModeScope, Map<string, number>>,
  modeScopes: readonly CivLeaderboardModeScope[],
): Map<string, number> {
  const combined = new Map<string, number>()
  for (const modeScope of modeScopes) {
    const poolGames = poolGamesByScope.get(modeScope)
    if (!poolGames) continue
    for (const [civId, count] of poolGames) {
      combined.set(civId, (combined.get(civId) ?? 0) + count)
    }
  }
  return combined
}

function parsePoolCivIds(raw: string): string[] {
  try {
    return normalizeStringArray(JSON.parse(raw)).filter(civId => !isRedDeathFaction(civId))
  }
  catch {
    return []
  }
}

function getPoolGamesMap(
  maps: Map<CivLeaderboardModeScope, Map<string, number>>,
  modeScope: CivLeaderboardModeScope,
): Map<string, number> {
  const existing = maps.get(modeScope)
  if (existing) return existing
  const created = new Map<string, number>()
  maps.set(modeScope, created)
  return created
}

function getAggregatesMap(
  maps: Map<CivLeaderboardModeScope, Map<string, CivAggregate>>,
  modeScope: CivLeaderboardModeScope,
): Map<string, CivAggregate> {
  const existing = maps.get(modeScope)
  if (existing) return existing
  const created = new Map<string, CivAggregate>()
  maps.set(modeScope, created)
  return created
}

function emptySnapshot(modeScope: CivLeaderboardModeScope, label: string, updatedAt: number, historyInitialized: boolean): CivLeaderboardSnapshot {
  return { updatedAt, historyInitialized, label, modeScope, completedMatchCount: 0, rows: [] }
}

async function countContributionRows(db: Database): Promise<number> {
  const [row] = await db.select({ count: sql<number>`count(*)` }).from(matchCivStatContributions)
  return normalizeCount(row?.count)
}

function normalizeCompletedAt(value: unknown): number {
  return normalizeNonNegativeInteger(value) ?? 0
}

function normalizeCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.round(value))
  if (typeof value === 'bigint') return Number(value)
  return 0
}

function writesLegacyStats(statsContext: StatsContext): boolean {
  return statsContext.seasonPolicy === 'ppl-seasons'
}

function normalizeNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.round(value))
}

function normalizeNullableNumber(value: unknown): number | null {
  if (value == null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}
