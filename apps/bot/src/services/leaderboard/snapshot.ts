import type { Database } from '@civup/db'
import type { LeaderboardMode } from '@civup/game'
import { playerRatings } from '@civup/db'
import { LEADERBOARD_MODES } from '@civup/game'
import { eq } from 'drizzle-orm'
import { stateStoreMdelete, stateStoreMget, stateStoreMput } from '../state/store.ts'

export interface LeaderboardSnapshotRow {
  playerId: string
  mode: LeaderboardMode
  mu: number
  sigma: number
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
  updatedAt?: unknown
  rows?: unknown
}

const LEADERBOARD_MODE_SNAPSHOT_KEY_PREFIX = 'leaderboard:snapshot:'

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

  const rawSnapshots = await stateStoreMget(kv, requestedModes.map(mode => ({
    key: leaderboardModeSnapshotKey(mode),
    type: 'json',
  })))

  const snapshots = new Map<LeaderboardMode, LeaderboardModeSnapshot>()
  const missingModes: LeaderboardMode[] = []

  for (let index = 0; index < requestedModes.length; index++) {
    const mode = requestedModes[index]
    if (!mode) continue

    const snapshot = normalizeLeaderboardModeSnapshot(mode, rawSnapshots[index])
    if (snapshot) {
      snapshots.set(mode, snapshot)
      continue
    }

    missingModes.push(mode)
  }

  if (missingModes.length === 0) return snapshots

  const rebuilt = await Promise.all(missingModes.map(async (mode) => {
    const rows = await listLeaderboardModeRowsFromD1(db, mode)
    return buildLeaderboardModeSnapshot(mode, rows, Date.now())
  }))

  await setLeaderboardModeSnapshots(kv, rebuilt)
  for (const snapshot of rebuilt) {
    snapshots.set(snapshot.mode, snapshot)
  }

  return snapshots
}

export async function rebuildLeaderboardModeSnapshot(
  db: Database,
  kv: KVNamespace,
  mode: LeaderboardMode,
  updatedAt = Date.now(),
): Promise<LeaderboardModeSnapshot> {
  const rows = await listLeaderboardModeRowsFromD1(db, mode)
  const snapshot = buildLeaderboardModeSnapshot(mode, rows, updatedAt)
  await setLeaderboardModeSnapshots(kv, [snapshot])
  return snapshot
}

export async function clearLeaderboardModeSnapshot(kv: KVNamespace, mode: LeaderboardMode): Promise<void> {
  await stateStoreMdelete(kv, [leaderboardModeSnapshotKey(mode)])
}

export async function clearAllLeaderboardModeSnapshots(kv: KVNamespace): Promise<void> {
  await stateStoreMdelete(kv, LEADERBOARD_MODES.map(mode => leaderboardModeSnapshotKey(mode)))
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
    })),
  }
}

async function setLeaderboardModeSnapshots(
  kv: KVNamespace,
  snapshots: readonly LeaderboardModeSnapshot[],
): Promise<void> {
  if (snapshots.length === 0) return

  await stateStoreMput(kv, snapshots.map(snapshot => ({
    key: leaderboardModeSnapshotKey(snapshot.mode),
    value: JSON.stringify({
      updatedAt: snapshot.updatedAt,
      rows: snapshot.rows.map(row => ({
        playerId: row.playerId,
        mu: row.mu,
        sigma: row.sigma,
        gamesPlayed: row.gamesPlayed,
        wins: row.wins,
        lastPlayedAt: row.lastPlayedAt,
      })),
    } satisfies StoredLeaderboardModeSnapshot),
  })))
}

async function listLeaderboardModeRowsFromD1(
  db: Database,
  mode: LeaderboardMode,
): Promise<LeaderboardSnapshotRow[]> {
  const rows = await db
    .select({
      playerId: playerRatings.playerId,
      mu: playerRatings.mu,
      sigma: playerRatings.sigma,
      gamesPlayed: playerRatings.gamesPlayed,
      wins: playerRatings.wins,
      lastPlayedAt: playerRatings.lastPlayedAt,
    })
    .from(playerRatings)
    .where(eq(playerRatings.mode, mode))

  return rows.map(row => ({
    playerId: row.playerId,
    mode,
    mu: row.mu,
    sigma: row.sigma,
    gamesPlayed: row.gamesPlayed,
    wins: row.wins,
    lastPlayedAt: row.lastPlayedAt ?? null,
  }))
}

function normalizeLeaderboardModeSnapshot(
  mode: LeaderboardMode,
  value: unknown,
): LeaderboardModeSnapshot | null {
  if (!value || typeof value !== 'object') return null

  const raw = value as StoredLeaderboardModeSnapshot
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
