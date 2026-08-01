import type { Database } from '@civup/db'
import type { LeaderboardMode } from '@civup/game'
import type { StatsContext } from '../stats/context.ts'
import { scopedPlayerRatings as playerRatings } from '@civup/db'
import { LEADERBOARD_MODES } from '@civup/game'
import { resolvePublicRating } from '@civup/rating'
import { and, eq, inArray } from 'drizzle-orm'
import { kvMdelete, kvMget, kvMput } from '../kv/batch.ts'
import { recalculateLeaderboardMode } from '../match/ratings.ts'

export interface LeaderboardSnapshotRow {
  playerId: string
  mode: LeaderboardMode
  mu: number
  sigma: number
  publicRating: number
  gamesPlayed: number
  wins: number
  lastPlayedAt: number | null
}

export interface LeaderboardModeSnapshot {
  mode: LeaderboardMode
  updatedAt: number
  rows: LeaderboardSnapshotRow[]
}

interface StoredLeaderboardModeSnapshot {
  version?: unknown
  updatedAt?: unknown
  rows?: unknown
}

const LEADERBOARD_MODE_SNAPSHOT_VERSION = 4

export function leaderboardModeSnapshotKey(statsContext: StatsContext, mode: LeaderboardMode): string {
  return `stats:snapshot:${statsContext.statsKey}:player:${mode}`
}

export async function ensureLeaderboardModeSnapshot(
  db: Database,
  kv: KVNamespace,
  statsContext: StatsContext,
  mode: LeaderboardMode,
): Promise<LeaderboardModeSnapshot> {
  const snapshots = await ensureLeaderboardModeSnapshots(db, kv, statsContext, [mode])
  return snapshots.get(mode) ?? buildLeaderboardModeSnapshot(mode, [], Date.now())
}

export async function ensureLeaderboardModeSnapshots(
  db: Database,
  kv: KVNamespace,
  statsContext: StatsContext,
  modes: readonly LeaderboardMode[] = LEADERBOARD_MODES,
): Promise<Map<LeaderboardMode, LeaderboardModeSnapshot>> {
  const requestedModes = [...new Set(modes.filter(isLeaderboardMode))]
  if (requestedModes.length === 0) return new Map()

  const snapshots = await getStoredLeaderboardModeSnapshots(kv, statsContext, requestedModes)
  const missingModes = requestedModes.filter(mode => !snapshots.has(mode))

  if (missingModes.length === 0) return snapshots

  let rowsByMode = await listLeaderboardModeRowsFromD1ByModes(db, statsContext, missingModes)
  const recalcModes = missingModes.filter(mode => rowsByMode.get(mode)?.length === 0 && (mode === 'duo' || mode === 'squad'))

  for (const mode of recalcModes) {
    const recalculated = await recalculateLeaderboardMode(db, mode, statsContext)
    if ('error' in recalculated) throw new Error(recalculated.error)
  }

  if (recalcModes.length > 0) {
    const recalculatedRowsByMode = await listLeaderboardModeRowsFromD1ByModes(db, statsContext, recalcModes)
    rowsByMode = new Map([...rowsByMode, ...recalculatedRowsByMode])
  }

  const rebuilt = missingModes.map(mode => buildLeaderboardModeSnapshot(mode, rowsByMode.get(mode) ?? [], Date.now()))

  await setLeaderboardModeSnapshots(kv, statsContext, rebuilt)
  for (const snapshot of rebuilt) {
    snapshots.set(snapshot.mode, snapshot)
  }

  return snapshots
}

export async function getStoredLeaderboardModeSnapshot(
  kv: KVNamespace,
  statsContext: StatsContext,
  mode: LeaderboardMode,
): Promise<LeaderboardModeSnapshot | null> {
  const snapshots = await getStoredLeaderboardModeSnapshots(kv, statsContext, [mode])
  return snapshots.get(mode) ?? null
}

export async function getStoredLeaderboardModeSnapshots(
  kv: KVNamespace,
  statsContext: StatsContext,
  modes: readonly LeaderboardMode[] = LEADERBOARD_MODES,
): Promise<Map<LeaderboardMode, LeaderboardModeSnapshot>> {
  const requestedModes = [...new Set(modes.filter(isLeaderboardMode))]
  if (requestedModes.length === 0) return new Map()

  const rawSnapshots = await kvMget(kv, requestedModes.map(mode => ({
    key: leaderboardModeSnapshotKey(statsContext, mode),
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
  statsContext: StatsContext,
  modes: readonly LeaderboardMode[] = LEADERBOARD_MODES,
): Promise<Map<LeaderboardMode, LeaderboardModeSnapshot>> {
  const requestedModes = [...new Set(modes.filter(isLeaderboardMode))]
  const snapshots = await getStoredLeaderboardModeSnapshots(kv, statsContext, requestedModes)
  const missingModes = requestedModes.filter(mode => !snapshots.has(mode))
  if (missingModes.length === 0) return snapshots

  const rebuilt = await buildLeaderboardModeSnapshotsFromD1(db, statsContext, missingModes)
  await setLeaderboardModeSnapshots(kv, statsContext, [...rebuilt.values()])
  for (const [mode, snapshot] of rebuilt) snapshots.set(mode, snapshot)
  return snapshots
}

export async function rebuildLeaderboardModeSnapshot(
  db: Database,
  kv: KVNamespace,
  statsContext: StatsContext,
  mode: LeaderboardMode,
  updatedAt = Date.now(),
): Promise<LeaderboardModeSnapshot> {
  const snapshot = await buildLeaderboardModeSnapshotFromD1(db, statsContext, mode, updatedAt)
  await setLeaderboardModeSnapshots(kv, statsContext, [snapshot])
  return snapshot
}

export async function buildLeaderboardModeSnapshotFromD1(
  db: Database,
  statsContext: StatsContext,
  mode: LeaderboardMode,
  updatedAt = Date.now(),
): Promise<LeaderboardModeSnapshot> {
  const rows = await listLeaderboardModeRowsFromD1(db, statsContext, mode)
  return buildLeaderboardModeSnapshot(mode, rows, updatedAt)
}

export async function buildLeaderboardModeSnapshotsFromD1(
  db: Database,
  statsContext: StatsContext,
  modes: readonly LeaderboardMode[] = LEADERBOARD_MODES,
  updatedAt = Date.now(),
): Promise<Map<LeaderboardMode, LeaderboardModeSnapshot>> {
  const requestedModes = [...new Set(modes.filter(isLeaderboardMode))]
  const rowsByMode = await listLeaderboardModeRowsFromD1ByModes(db, statsContext, requestedModes)
  return new Map(requestedModes.map(mode => [mode, buildLeaderboardModeSnapshot(mode, rowsByMode.get(mode) ?? [], updatedAt)]))
}

export async function clearLeaderboardModeSnapshot(kv: KVNamespace, statsContext: StatsContext, mode: LeaderboardMode): Promise<void> {
  await kvMdelete(kv, [leaderboardModeSnapshotKey(statsContext, mode)])
}

export async function clearAllLeaderboardModeSnapshots(kv: KVNamespace, statsContext: StatsContext): Promise<void> {
  await kvMdelete(kv, LEADERBOARD_MODES.map(mode => leaderboardModeSnapshotKey(statsContext, mode)))
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
      publicRating: resolvePublicRating(row.publicRating, row.mu),
      gamesPlayed: row.gamesPlayed,
      wins: row.wins,
      lastPlayedAt: row.lastPlayedAt,
    })),
  }
}

async function setLeaderboardModeSnapshots(
  kv: KVNamespace,
  statsContext: StatsContext,
  snapshots: readonly LeaderboardModeSnapshot[],
): Promise<void> {
  if (snapshots.length === 0) return

  await kvMput(kv, snapshots.map(snapshot => ({
    key: leaderboardModeSnapshotKey(statsContext, snapshot.mode),
    value: JSON.stringify({
      version: LEADERBOARD_MODE_SNAPSHOT_VERSION,
      updatedAt: snapshot.updatedAt,
      rows: snapshot.rows.map(row => ({
        playerId: row.playerId,
        mu: row.mu,
        sigma: row.sigma,
        publicRating: row.publicRating,
        gamesPlayed: row.gamesPlayed,
        wins: row.wins,
        lastPlayedAt: row.lastPlayedAt,
      })),
    } satisfies StoredLeaderboardModeSnapshot),
  })))
}

async function listLeaderboardModeRowsFromD1(
  db: Database,
  statsContext: StatsContext,
  mode: LeaderboardMode,
): Promise<LeaderboardSnapshotRow[]> {
  return (await listLeaderboardModeRowsFromD1ByModes(db, statsContext, [mode])).get(mode) ?? []
}

async function listLeaderboardModeRowsFromD1ByModes(
  db: Database,
  statsContext: StatsContext,
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
      publicRating: playerRatings.publicRating,
      gamesPlayed: playerRatings.gamesPlayed,
      wins: playerRatings.wins,
      lastPlayedAt: playerRatings.lastPlayedAt,
    })
    .from(playerRatings)
    .where(and(eq(playerRatings.statsKey, statsContext.statsKey), inArray(playerRatings.mode, requestedModes)))

  const rowsByMode = new Map<LeaderboardMode, LeaderboardSnapshotRow[]>(requestedModes.map(mode => [mode, []]))
  for (const row of rows) {
    if (!isLeaderboardMode(row.mode)) continue
    const modeRows = rowsByMode.get(row.mode) ?? []
    modeRows.push({
      playerId: row.playerId,
      mode: row.mode,
      mu: row.mu,
      sigma: row.sigma,
      publicRating: resolvePublicRating(row.publicRating, row.mu),
      gamesPlayed: row.gamesPlayed,
      wins: row.wins,
      lastPlayedAt: row.lastPlayedAt ?? null,
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
  const publicRating = normalizeFiniteNumber(raw.publicRating)
  const gamesPlayed = normalizeNonNegativeInteger(raw.gamesPlayed)
  const wins = normalizeNonNegativeInteger(raw.wins)
  if (!playerId || mu == null || sigma == null || publicRating == null || publicRating < 0 || gamesPlayed == null || wins == null) return null

  return {
    playerId,
    mode,
    mu,
    sigma,
    publicRating,
    gamesPlayed,
    wins,
    lastPlayedAt: normalizeNullableTimestamp(raw.lastPlayedAt),
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
