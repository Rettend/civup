import type { Database } from '@civup/db'
import type { CompetitiveTier, LeaderboardMode } from '@civup/game'
import { leaderboardDecaySchedules, playerRatings, seasonPeakDivisionRanks, seasonPeakRanks, seasonRatingStates, seasons } from '@civup/db'
import { PUBLIC_RATING_BANDS } from '@civup/rating'
import { LEADERBOARD_MODES } from '@civup/game'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { kvMdelete, kvMget, kvMput } from '../kv/batch.ts'
import { projectPublicRatingDecay } from '../season/decay.ts'
import type { PublicRatingDecayState } from '@civup/rating'

export interface LeaderboardSnapshotRow {
  playerId: string
  mode: LeaderboardMode
  mu: number
  sigma: number
  gamesPlayed: number
  wins: number
  lastPlayedAt: number | null
  publicRating?: number
  seasonGames?: number
  seasonWins?: number
  pastRanks?: Array<{ seasonNumber: number, tier: CompetitiveTier, label?: string, division?: number }>
  publicDecay?: PublicRatingDecayState | null
}

export interface LeaderboardModeSnapshot {
  mode: LeaderboardMode
  updatedAt: number
  rows: LeaderboardSnapshotRow[]
  ratingSystem?: 'rp'
  publicReadsEnabled?: boolean
  seasonNumber?: number
  nextDecayAt?: number
  pastRanksByPlayerId?: Record<string, NonNullable<LeaderboardSnapshotRow['pastRanks']>>
}

interface StoredLeaderboardModeSnapshot {
  version?: unknown
  updatedAt?: unknown
  rows?: unknown
  ratingSystem?: unknown
  publicReadsEnabled?: unknown
  seasonNumber?: unknown
  nextDecayAt?: unknown
  pastRanksByPlayerId?: unknown
}

const LEADERBOARD_MODE_SNAPSHOT_KEY_PREFIX = 'leaderboard:snapshot:'
const LEADERBOARD_MODE_SNAPSHOT_VERSION = 4

export function leaderboardModeSnapshotKey(mode: LeaderboardMode): string {
  return `${LEADERBOARD_MODE_SNAPSHOT_KEY_PREFIX}${mode}`
}

export async function ensureLeaderboardModeSnapshot(
  db: Database,
  kv: KVNamespace,
  mode: LeaderboardMode,
): Promise<LeaderboardModeSnapshot> {
  const snapshots = await ensureLeaderboardModeSnapshots(db, kv, [mode])
  return snapshots.get(mode) ?? buildLeaderboardModeSnapshot(mode, [], Date.now())
}

export async function ensureLeaderboardModeSnapshots(
  db: Database,
  kv: KVNamespace,
  modes: readonly LeaderboardMode[] = LEADERBOARD_MODES,
): Promise<Map<LeaderboardMode, LeaderboardModeSnapshot>> {
  const requestedModes = [...new Set(modes.filter(isLeaderboardMode))]
  if (requestedModes.length === 0) return new Map()

  const snapshots = await getStoredLeaderboardModeSnapshots(kv, requestedModes)
  const missingModes = requestedModes.filter(mode => !snapshots.has(mode))

  if (missingModes.length === 0) return snapshots

  const rowsByMode = await listLeaderboardModeRowsFromD1ByModes(db, missingModes)

  const era = await loadSnapshotEra(db)
  const rebuilt = missingModes.map(mode => ({ ...buildLeaderboardModeSnapshot(mode, rowsByMode.get(mode) ?? [], Date.now()), ...era }))

  await saveDecaySchedules(db, rebuilt)
  await setLeaderboardModeSnapshots(kv, rebuilt)
  for (const snapshot of rebuilt) {
    snapshots.set(snapshot.mode, snapshot)
  }

  return snapshots
}

export async function getStoredLeaderboardModeSnapshot(
  kv: KVNamespace,
  mode: LeaderboardMode,
): Promise<LeaderboardModeSnapshot | null> {
  const snapshots = await getStoredLeaderboardModeSnapshots(kv, [mode])
  return snapshots.get(mode) ?? null
}

export async function getStoredLeaderboardModeSnapshots(
  kv: KVNamespace,
  modes: readonly LeaderboardMode[] = LEADERBOARD_MODES,
): Promise<Map<LeaderboardMode, LeaderboardModeSnapshot>> {
  const requestedModes = [...new Set(modes.filter(isLeaderboardMode))]
  if (requestedModes.length === 0) return new Map()

  const rawSnapshots = await kvMget(kv, requestedModes.map(mode => ({
    key: leaderboardModeSnapshotKey(mode),
    type: 'json',
  })))

  const snapshots = new Map<LeaderboardMode, LeaderboardModeSnapshot>()
  for (let index = 0; index < requestedModes.length; index++) {
    const mode = requestedModes[index]
    if (!mode) continue

    const snapshot = normalizeLeaderboardModeSnapshot(mode, rawSnapshots[index])
    if (!snapshot) continue
    snapshots.set(mode, snapshot)
  }

  return snapshots
}

export async function getLeaderboardModeSnapshotsForPreview(
  db: Database,
  kv: KVNamespace,
  modes: readonly LeaderboardMode[] = LEADERBOARD_MODES,
): Promise<Map<LeaderboardMode, LeaderboardModeSnapshot>> {
  const requestedModes = [...new Set(modes.filter(isLeaderboardMode))]
  const snapshots = await getStoredLeaderboardModeSnapshots(kv, requestedModes)
  const missingModes = requestedModes.filter(mode => !snapshots.has(mode))
  if (missingModes.length === 0) return snapshots

  const rebuilt = await buildLeaderboardModeSnapshotsFromD1(db, missingModes)
  await setLeaderboardModeSnapshots(kv, [...rebuilt.values()])
  for (const [mode, snapshot] of rebuilt) snapshots.set(mode, snapshot)
  return snapshots
}

export async function rebuildLeaderboardModeSnapshot(
  db: Database,
  kv: KVNamespace,
  mode: LeaderboardMode,
  updatedAt = Date.now(),
): Promise<LeaderboardModeSnapshot> {
  const snapshot = await buildLeaderboardModeSnapshotFromD1(db, mode, updatedAt)
  await setLeaderboardModeSnapshots(kv, [snapshot])
  return snapshot
}

export async function buildLeaderboardModeSnapshotFromD1(
  db: Database,
  mode: LeaderboardMode,
  updatedAt = Date.now(),
): Promise<LeaderboardModeSnapshot> {
  const rows = await listLeaderboardModeRowsFromD1(db, mode, updatedAt)
  const snapshot = { ...buildLeaderboardModeSnapshot(mode, rows, updatedAt), ...await loadSnapshotEra(db) }
  await saveDecaySchedules(db, [snapshot])
  return snapshot
}

export async function buildLeaderboardModeSnapshotsFromD1(
  db: Database,
  modes: readonly LeaderboardMode[] = LEADERBOARD_MODES,
  updatedAt = Date.now(),
): Promise<Map<LeaderboardMode, LeaderboardModeSnapshot>> {
  const requestedModes = [...new Set(modes.filter(isLeaderboardMode))]
  const rowsByMode = await listLeaderboardModeRowsFromD1ByModes(db, requestedModes, updatedAt)
  const era = await loadSnapshotEra(db)
  const snapshots = requestedModes.map(mode => ({ ...buildLeaderboardModeSnapshot(mode, rowsByMode.get(mode) ?? [], updatedAt), ...era }))
  await saveDecaySchedules(db, snapshots)
  return new Map(snapshots.map(snapshot => [snapshot.mode, snapshot]))
}

async function saveDecaySchedules(db: Database, snapshots: readonly LeaderboardModeSnapshot[]) {
  if (!snapshots.length) return
  await db.insert(leaderboardDecaySchedules).values(snapshots.map(snapshot => ({
    mode: snapshot.mode,
    nextDecayAt: sql<number | null>`case when exists(select 1 from seasons where active = 1 and rating_system = 'rp') then ${snapshot.nextDecayAt ?? null} else null end`,
    updatedAt: snapshot.updatedAt,
  }))).onConflictDoUpdate({
    target: leaderboardDecaySchedules.mode,
    set: { nextDecayAt: sql`excluded.next_decay_at`, updatedAt: sql`excluded.updated_at` },
    setWhere: sql`excluded.updated_at >= ${leaderboardDecaySchedules.updatedAt}`,
  })
}

async function loadSnapshotEra(db: Database): Promise<Pick<LeaderboardModeSnapshot, 'ratingSystem' | 'publicReadsEnabled' | 'seasonNumber' | 'pastRanksByPlayerId'>> {
  const [season] = await db.select({ seasonNumber: seasons.seasonNumber, ratingSystem: seasons.ratingSystem, enabled: seasons.publicReadsEnabled }).from(seasons).orderBy(desc(seasons.active), desc(seasons.startsAt)).limit(1)
  if (!season) return {}
  const closed = await db.select({ id: seasons.id, seasonNumber: seasons.seasonNumber }).from(seasons).where(eq(seasons.active, false)).orderBy(desc(seasons.seasonNumber)).limit(8)
  const historical = closed.length ? await db.select({ playerId: seasonPeakRanks.playerId, seasonId: seasonPeakRanks.seasonId, tier: seasonPeakRanks.tier, minimum: seasonPeakDivisionRanks.minimum }).from(seasonPeakRanks)
    .leftJoin(seasonPeakDivisionRanks, and(eq(seasonPeakDivisionRanks.seasonId, seasonPeakRanks.seasonId), eq(seasonPeakDivisionRanks.playerId, seasonPeakRanks.playerId)))
    .where(inArray(seasonPeakRanks.seasonId, closed.map(season => season.id))) : []
  const pastRanksByPlayerId: NonNullable<LeaderboardModeSnapshot['pastRanksByPlayerId']> = {}
  for (const row of historical) {
    const ranks = pastRanksByPlayerId[row.playerId] ?? []
    ranks.push({ seasonNumber: closed.find(season => season.id === row.seasonId)!.seasonNumber, tier: row.tier as CompetitiveTier,
      ...(row.minimum != null ? { division: PUBLIC_RATING_BANDS.find(band => band.minimum === row.minimum)?.division } : {}) })
    pastRanksByPlayerId[row.playerId] = ranks
  }
  for (const ranks of Object.values(pastRanksByPlayerId)) ranks.sort((a, b) => b.seasonNumber - a.seasonNumber)
  return { seasonNumber: season.seasonNumber, pastRanksByPlayerId, ...(season.ratingSystem === 'rp' ? { ratingSystem: 'rp' as const, publicReadsEnabled: season.enabled } : {}) }
}

export async function clearLeaderboardModeSnapshot(kv: KVNamespace, mode: LeaderboardMode): Promise<void> {
  await kvMdelete(kv, [leaderboardModeSnapshotKey(mode)])
}

export async function clearAllLeaderboardModeSnapshots(kv: KVNamespace): Promise<void> {
  await kvMdelete(kv, LEADERBOARD_MODES.map(mode => leaderboardModeSnapshotKey(mode)))
}

function buildLeaderboardModeSnapshot(
  mode: LeaderboardMode,
  rows: LeaderboardSnapshotRow[],
  updatedAt: number,
): LeaderboardModeSnapshot {
  return {
    mode,
    updatedAt,
    nextDecayAt: rows.some(row => row.publicDecay?.active) ? Math.min(...rows.flatMap(row => row.publicDecay?.active ? [row.publicDecay.bankUntil > updatedAt ? row.publicDecay.bankUntil : updatedAt + 86_400_000] : [])) : undefined,
    rows: rows.map(row => ({
      playerId: row.playerId,
      mode,
      mu: row.mu,
      sigma: row.sigma,
      gamesPlayed: row.gamesPlayed,
      wins: row.wins,
      lastPlayedAt: row.lastPlayedAt,
      ...(row.publicRating != null ? { publicRating: row.publicRating } : {}),
      seasonGames: row.seasonGames,
      seasonWins: row.seasonWins,
      pastRanks: row.pastRanks,
    })),
  }
}

async function setLeaderboardModeSnapshots(
  kv: KVNamespace,
  snapshots: readonly LeaderboardModeSnapshot[],
): Promise<void> {
  if (snapshots.length === 0) return

  await kvMput(kv, snapshots.map(snapshot => ({
    key: leaderboardModeSnapshotKey(snapshot.mode),
    value: JSON.stringify({
      version: LEADERBOARD_MODE_SNAPSHOT_VERSION,
      updatedAt: snapshot.updatedAt,
      seasonNumber: snapshot.seasonNumber,
      nextDecayAt: snapshot.nextDecayAt,
      pastRanksByPlayerId: snapshot.pastRanksByPlayerId,
      ...(snapshot.ratingSystem === 'rp' ? { ratingSystem: 'rp', publicReadsEnabled: snapshot.publicReadsEnabled === true } : {}),
      rows: snapshot.rows.map(row => ({
        playerId: row.playerId,
        mu: row.mu,
        sigma: row.sigma,
        gamesPlayed: row.gamesPlayed,
        wins: row.wins,
        lastPlayedAt: row.lastPlayedAt,
        ...(row.publicRating != null ? { publicRating: row.publicRating } : {}),
        seasonGames: row.seasonGames,
        seasonWins: row.seasonWins,
        pastRanks: row.pastRanks,
      })),
    } satisfies StoredLeaderboardModeSnapshot),
  })))
}

async function listLeaderboardModeRowsFromD1(
  db: Database,
  mode: LeaderboardMode,
  now = Date.now(),
): Promise<LeaderboardSnapshotRow[]> {
  return (await listLeaderboardModeRowsFromD1ByModes(db, [mode], now)).get(mode) ?? []
}

async function listLeaderboardModeRowsFromD1ByModes(
  db: Database,
  modes: readonly LeaderboardMode[],
  now = Date.now(),
): Promise<Map<LeaderboardMode, LeaderboardSnapshotRow[]>> {
  const requestedModes = [...new Set(modes.filter(isLeaderboardMode))]
  if (requestedModes.length === 0) return new Map()

  const rows = await db
    .select({
      mode: playerRatings.mode,
      playerId: playerRatings.playerId,
      mu: playerRatings.mu,
      sigma: playerRatings.sigma,
      gamesPlayed: playerRatings.gamesPlayed,
      wins: playerRatings.wins,
      lastPlayedAt: playerRatings.lastPlayedAt,
      publicRating: playerRatings.publicRating,
      publicDecay: playerRatings.publicDecay,
      seasonGames: seasonRatingStates.seasonGames,
      seasonWins: seasonRatingStates.seasonWins,
    })
    .from(playerRatings)
    .leftJoin(seasonRatingStates, and(eq(seasonRatingStates.playerId, playerRatings.playerId), eq(seasonRatingStates.mode, playerRatings.mode), sql`${seasonRatingStates.seasonId} = (select id from seasons order by active desc, starts_at desc limit 1)`))
    .where(inArray(playerRatings.mode, requestedModes))


  const rowsByMode = new Map<LeaderboardMode, LeaderboardSnapshotRow[]>(requestedModes.map(mode => [mode, []]))
  for (const row of await projectPublicRatingDecay(db, rows, now)) {
    if (!isLeaderboardMode(row.mode)) continue
    const modeRows = rowsByMode.get(row.mode) ?? []
    modeRows.push({
      playerId: row.playerId,
      mode: row.mode,
      mu: row.mu,
      sigma: row.sigma,
      gamesPlayed: row.gamesPlayed,
      wins: row.wins,
      lastPlayedAt: row.lastPlayedAt ?? null,
      ...(row.publicRating != null ? { publicRating: row.publicRating } : {}),
      seasonGames: row.seasonGames ?? 0,
      seasonWins: row.seasonWins ?? 0,
      publicDecay: row.publicDecay,
    })
    rowsByMode.set(row.mode, modeRows)
  }

  return rowsByMode
}

export function normalizeLeaderboardModeSnapshot(
  mode: LeaderboardMode,
  value: unknown,
): LeaderboardModeSnapshot | null {
  if (!value || typeof value !== 'object') return null

  const raw = value as StoredLeaderboardModeSnapshot
  if (raw.version !== LEADERBOARD_MODE_SNAPSHOT_VERSION) return null
  if (!Array.isArray(raw.rows)) return null

  const rows = raw.rows
    .map(row => normalizeLeaderboardSnapshotRow(mode, row))
    .filter((row): row is LeaderboardSnapshotRow => row !== null)

  return {
    mode,
    updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
      ? Math.round(raw.updatedAt)
      : 0,
    ...(raw.ratingSystem === 'rp' ? { ratingSystem: 'rp', publicReadsEnabled: raw.publicReadsEnabled === true } as const : {}),
    ...(typeof raw.seasonNumber === 'number' ? { seasonNumber: raw.seasonNumber } : {}),
    ...(typeof raw.nextDecayAt === 'number' && Number.isFinite(raw.nextDecayAt) ? { nextDecayAt: raw.nextDecayAt } : {}),
    pastRanksByPlayerId: raw.pastRanksByPlayerId != null && typeof raw.pastRanksByPlayerId === 'object' ? Object.fromEntries(Object.entries(raw.pastRanksByPlayerId).map(([id, ranks]) => [id, normalizePastRanks(ranks)])) : {},
    rows,
  }
}

function normalizeLeaderboardSnapshotRow(
  mode: LeaderboardMode,
  value: unknown,
): LeaderboardSnapshotRow | null {
  if (!value || typeof value !== 'object') return null

  const raw = value as Record<string, unknown>
  const playerId = typeof raw.playerId === 'string' && raw.playerId.length > 0 ? raw.playerId : null
  const mu = normalizeFiniteNumber(raw.mu)
  const sigma = normalizeFiniteNumber(raw.sigma)
  const gamesPlayed = normalizeNonNegativeInteger(raw.gamesPlayed)
  const wins = normalizeNonNegativeInteger(raw.wins)
  if (!playerId || mu == null || sigma == null || gamesPlayed == null || wins == null) return null

  return {
    playerId,
    mode,
    mu,
    sigma,
    gamesPlayed,
    wins,
    lastPlayedAt: normalizeNullableTimestamp(raw.lastPlayedAt),
    ...(typeof raw.publicRating === 'number' && Number.isFinite(raw.publicRating) && raw.publicRating >= 0 ? { publicRating: raw.publicRating } : {}),
    seasonGames: normalizeNonNegativeInteger(raw.seasonGames) ?? undefined,
    seasonWins: normalizeNonNegativeInteger(raw.seasonWins) ?? undefined,
    pastRanks: normalizePastRanks(raw.pastRanks),
  }
}

function normalizePastRanks(value: unknown): NonNullable<LeaderboardSnapshotRow['pastRanks']> {
  return Array.isArray(value) ? value.filter((rank): rank is { seasonNumber: number, tier: CompetitiveTier } => rank != null && typeof rank === 'object' && Number.isSafeInteger(rank.seasonNumber) && rank.seasonNumber > 0 && /^tier[1-9]\d*$/.test(rank.tier)) : []
}

function normalizeFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.round(value))
}

function normalizeNullableTimestamp(value: unknown): number | null {
  if (value == null) return null
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null
}

function isLeaderboardMode(value: unknown): value is LeaderboardMode {
  return typeof value === 'string' && LEADERBOARD_MODES.includes(value as LeaderboardMode)
}
