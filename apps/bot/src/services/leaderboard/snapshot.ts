import type { Database } from '@civup/db'
import type { LeaderboardMode } from '@civup/game'
import { playerRatings, seasons } from '@civup/db'
import { LEADERBOARD_MODES } from '@civup/game'
import { desc, eq, inArray } from 'drizzle-orm'
import { kvMdelete, kvMget, kvMput } from '../kv/batch.ts'
import { recalculateLeaderboardMode } from '../match/ratings.ts'

export interface LeaderboardSnapshotRow {
  playerId: string
  mode: LeaderboardMode
  mu: number
  sigma: number
  gamesPlayed: number
  wins: number
  lastPlayedAt: number | null
  publicRating?: number
}

export interface LeaderboardModeSnapshot {
  mode: LeaderboardMode
  updatedAt: number
  rows: LeaderboardSnapshotRow[]
  ratingSystem?: 'rp'
  publicReadsEnabled?: boolean
}

interface StoredLeaderboardModeSnapshot {
  version?: unknown
  updatedAt?: unknown
  rows?: unknown
  ratingSystem?: unknown
  publicReadsEnabled?: unknown
}

const LEADERBOARD_MODE_SNAPSHOT_KEY_PREFIX = 'leaderboard:snapshot:'
const LEADERBOARD_MODE_SNAPSHOT_VERSION = 3

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

  let rowsByMode = await listLeaderboardModeRowsFromD1ByModes(db, missingModes)
  let recalcModes = missingModes.filter(mode => rowsByMode.get(mode)?.length === 0 && (mode === 'duo' || mode === 'squad'))
  if (recalcModes.length) {
    const [publicSeason] = await db.select({ id: seasons.id }).from(seasons).where(eq(seasons.ratingSystem, 'rp')).limit(1)
    if (publicSeason) recalcModes = []
  }

  for (const mode of recalcModes) {
    const recalculated = await recalculateLeaderboardMode(db, mode)
    if ('error' in recalculated) throw new Error(recalculated.error)
  }

  if (recalcModes.length > 0) {
    const recalculatedRowsByMode = await listLeaderboardModeRowsFromD1ByModes(db, recalcModes)
    rowsByMode = new Map([...rowsByMode, ...recalculatedRowsByMode])
  }

  const era = await loadSnapshotEra(db)
  const rebuilt = missingModes.map(mode => ({ ...buildLeaderboardModeSnapshot(mode, rowsByMode.get(mode) ?? [], Date.now()), ...era }))

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
  const rows = await listLeaderboardModeRowsFromD1(db, mode)
  return { ...buildLeaderboardModeSnapshot(mode, rows, updatedAt), ...await loadSnapshotEra(db) }
}

export async function buildLeaderboardModeSnapshotsFromD1(
  db: Database,
  modes: readonly LeaderboardMode[] = LEADERBOARD_MODES,
  updatedAt = Date.now(),
): Promise<Map<LeaderboardMode, LeaderboardModeSnapshot>> {
  const requestedModes = [...new Set(modes.filter(isLeaderboardMode))]
  const rowsByMode = await listLeaderboardModeRowsFromD1ByModes(db, requestedModes)
  const era = await loadSnapshotEra(db)
  return new Map(requestedModes.map(mode => [mode, { ...buildLeaderboardModeSnapshot(mode, rowsByMode.get(mode) ?? [], updatedAt), ...era }]))
}

async function loadSnapshotEra(db: Database): Promise<Pick<LeaderboardModeSnapshot, 'ratingSystem' | 'publicReadsEnabled'>> {
  const [season] = await db.select({ ratingSystem: seasons.ratingSystem, enabled: seasons.publicReadsEnabled }).from(seasons).orderBy(desc(seasons.active), desc(seasons.startsAt)).limit(1)
  return season?.ratingSystem === 'rp' ? { ratingSystem: 'rp', publicReadsEnabled: season.enabled } : {}
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
    rows: rows.map(row => ({
      playerId: row.playerId,
      mode,
      mu: row.mu,
      sigma: row.sigma,
      gamesPlayed: row.gamesPlayed,
      wins: row.wins,
      lastPlayedAt: row.lastPlayedAt,
      ...(row.publicRating != null ? { publicRating: row.publicRating } : {}),
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
      ...(snapshot.ratingSystem === 'rp' ? { ratingSystem: 'rp', publicReadsEnabled: snapshot.publicReadsEnabled === true } : {}),
      rows: snapshot.rows.map(row => ({
        playerId: row.playerId,
        mu: row.mu,
        sigma: row.sigma,
        gamesPlayed: row.gamesPlayed,
        wins: row.wins,
        lastPlayedAt: row.lastPlayedAt,
        ...(row.publicRating != null ? { publicRating: row.publicRating } : {}),
      })),
    } satisfies StoredLeaderboardModeSnapshot),
  })))
}

async function listLeaderboardModeRowsFromD1(
  db: Database,
  mode: LeaderboardMode,
): Promise<LeaderboardSnapshotRow[]> {
  return (await listLeaderboardModeRowsFromD1ByModes(db, [mode])).get(mode) ?? []
}

async function listLeaderboardModeRowsFromD1ByModes(
  db: Database,
  modes: readonly LeaderboardMode[],
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
    })
    .from(playerRatings)
    .where(inArray(playerRatings.mode, requestedModes))

  const rowsByMode = new Map<LeaderboardMode, LeaderboardSnapshotRow[]>(requestedModes.map(mode => [mode, []]))
  for (const row of rows) {
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
  }
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
