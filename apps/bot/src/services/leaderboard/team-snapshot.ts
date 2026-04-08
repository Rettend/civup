import type { Database } from '@civup/db'
import type { LeaderboardMode } from '@civup/game'
import type { PlayerRating } from '@civup/rating'
import { matches, matchParticipants, playerRatings } from '@civup/db'
import { createRating } from '@civup/rating'
import { and, eq, inArray } from 'drizzle-orm'
import { getDisplaySeason } from '../season/index.ts'
import { stateStoreMdelete, stateStoreMget, stateStoreMput } from '../state/store.ts'
import { projectLineupDisplayRating } from './team-rating.ts'

export type TeamLeaderboardBucket = 'duo' | 'squad-3v3' | 'squad-4v4'

export interface TeamLeaderboardSnapshotRow {
  playerIds: string[]
  displayRating: number
  gamesPlayed: number
  wins: number
  lastPlayedAt: number | null
}

export interface TeamLeaderboardBucketSnapshot {
  bucket: TeamLeaderboardBucket
  updatedAt: number
  rows: TeamLeaderboardSnapshotRow[]
}

interface StoredTeamLeaderboardSnapshot {
  updatedAt?: unknown
  buckets?: unknown
}

interface TeamLeaderboardBucketContext {
  bucket: TeamLeaderboardBucket
  leaderboardMode: 'duo' | 'squad'
  gameMode: '2v2' | '3v3' | '4v4'
}

interface TeamLineupState {
  playerIds: string[]
  gamesPlayed: number
  wins: number
  lastPlayedAt: number | null
}

interface TeamParticipantRow {
  matchId: string
  playerId: string
  team: number | null
  placement: number | null
}

const TEAM_LEADERBOARD_SNAPSHOT_KEY = 'leaderboard:team-snapshot'

export const TEAM_LEADERBOARD_BUCKETS = ['duo', 'squad-3v3', 'squad-4v4'] as const satisfies readonly TeamLeaderboardBucket[]
export const TEAM_LEADERBOARD_MIN_GAMES = 5

const TEAM_LEADERBOARD_BUCKET_CONTEXTS: Record<TeamLeaderboardBucket, TeamLeaderboardBucketContext> = {
  'duo': {
    bucket: 'duo',
    leaderboardMode: 'duo',
    gameMode: '2v2',
  },
  'squad-3v3': {
    bucket: 'squad-3v3',
    leaderboardMode: 'squad',
    gameMode: '3v3',
  },
  'squad-4v4': {
    bucket: 'squad-4v4',
    leaderboardMode: 'squad',
    gameMode: '4v4',
  },
}

export function getTeamLeaderboardBucketContext(bucket: TeamLeaderboardBucket): TeamLeaderboardBucketContext {
  return TEAM_LEADERBOARD_BUCKET_CONTEXTS[bucket]
}

export function teamLeaderboardSnapshotKey(): string {
  return TEAM_LEADERBOARD_SNAPSHOT_KEY
}

export function teamLeaderboardBucketsForMode(mode: LeaderboardMode): TeamLeaderboardBucket[] {
  if (mode === 'duo') return ['duo']
  if (mode === 'squad') return ['squad-3v3', 'squad-4v4']
  return []
}

export async function ensureTeamLeaderboardBucketSnapshot(
  db: Database,
  kv: KVNamespace,
  bucket: TeamLeaderboardBucket,
): Promise<TeamLeaderboardBucketSnapshot> {
  const snapshots = await ensureTeamLeaderboardBucketSnapshots(db, kv, [bucket])
  return snapshots.get(bucket) ?? buildTeamLeaderboardBucketSnapshot(bucket, [], Date.now())
}

export async function ensureTeamLeaderboardBucketSnapshots(
  db: Database,
  kv: KVNamespace,
  buckets: readonly TeamLeaderboardBucket[] = TEAM_LEADERBOARD_BUCKETS,
): Promise<Map<TeamLeaderboardBucket, TeamLeaderboardBucketSnapshot>> {
  const requestedBuckets = [...new Set(buckets.filter(isTeamLeaderboardBucket))]
  if (requestedBuckets.length === 0) return new Map()

  const [rawSnapshot] = await stateStoreMget(kv, [{
    key: teamLeaderboardSnapshotKey(),
    type: 'json',
  }])

  let snapshots = normalizeTeamLeaderboardSnapshots(rawSnapshot)
  if (!hasTeamLeaderboardBuckets(snapshots, requestedBuckets)) {
    const rebuilt = await listTeamLeaderboardBucketSnapshotsFromD1(db, TEAM_LEADERBOARD_BUCKETS)
    await setTeamLeaderboardBucketSnapshots(kv, rebuilt)
    snapshots = new Map(rebuilt.map(snapshot => [snapshot.bucket, snapshot]))
  }

  return new Map(requestedBuckets.map(bucket => [
    bucket,
    snapshots.get(bucket) ?? buildTeamLeaderboardBucketSnapshot(bucket, [], Date.now()),
  ]))
}

export async function clearTeamLeaderboardModeSnapshots(_kv: KVNamespace, _mode: 'duo' | 'squad'): Promise<void> {
  await clearTeamLeaderboardSnapshots(_kv)
}

export async function clearAllTeamLeaderboardSnapshots(kv: KVNamespace): Promise<void> {
  await clearTeamLeaderboardSnapshots(kv)
}

async function clearTeamLeaderboardSnapshots(kv: KVNamespace): Promise<void> {
  await stateStoreMdelete(kv, [teamLeaderboardSnapshotKey()])
}

async function listTeamLeaderboardBucketSnapshotsFromD1(
  db: Database,
  buckets: readonly TeamLeaderboardBucket[],
  updatedAt = Date.now(),
): Promise<TeamLeaderboardBucketSnapshot[]> {
  const requestedBuckets = [...new Set(buckets.filter(isTeamLeaderboardBucket))]
  if (requestedBuckets.length === 0) return []

  const bucketContexts = requestedBuckets.map(bucket => getTeamLeaderboardBucketContext(bucket))
  const gameModes = [...new Set(bucketContexts.map(context => context.gameMode))]
  const contextByGameMode = new Map(bucketContexts.map(context => [context.gameMode, context]))
  const displaySeason = await getDisplaySeason(db)
  const conditions = [
    eq(matches.status, 'completed'),
    inArray(matches.gameMode, gameModes),
  ]
  if (displaySeason?.id) conditions.push(eq(matches.seasonId, displaySeason.id))

  const matchRows = await db
    .select({
      id: matches.id,
      gameMode: matches.gameMode,
      completedAt: matches.completedAt,
    })
    .from(matches)
    .where(and(...conditions))

  const participantRows = matchRows.length > 0
    ? await db
        .select({
          matchId: matchParticipants.matchId,
          playerId: matchParticipants.playerId,
          team: matchParticipants.team,
          placement: matchParticipants.placement,
        })
        .from(matchParticipants)
        .where(inArray(matchParticipants.matchId, matchRows.map(row => row.id)))
    : []

  const participantsByMatchId = new Map<string, TeamParticipantRow[]>()
  for (const participant of participantRows) {
    const current = participantsByMatchId.get(participant.matchId) ?? []
    current.push(participant)
    participantsByMatchId.set(participant.matchId, current)
  }

  const lineupsByBucket = new Map<TeamLeaderboardBucket, Map<string, TeamLineupState>>()
  for (const bucket of requestedBuckets) {
    lineupsByBucket.set(bucket, new Map())
  }

  for (const match of matchRows) {
    const bucketContext = contextByGameMode.get(match.gameMode as TeamLeaderboardBucketContext['gameMode'])
    if (!bucketContext) continue

    const lineupStates = lineupsByBucket.get(bucketContext.bucket)
    if (!lineupStates) continue

    const teamsByIndex = new Map<number, TeamParticipantRow[]>()
    for (const participant of participantsByMatchId.get(match.id) ?? []) {
      if (participant.team == null) continue
      const current = teamsByIndex.get(participant.team) ?? []
      current.push(participant)
      teamsByIndex.set(participant.team, current)
    }

    for (const participants of teamsByIndex.values()) {
      const expectedPlayers = expectedPlayerCount(bucketContext.gameMode)
      if (participants.length !== expectedPlayers) continue

      const playerIds = [...new Set(participants.map(participant => participant.playerId))].sort((a, b) => a.localeCompare(b))
      if (playerIds.length !== expectedPlayers) continue

      const lineupKey = playerIds.join(':')
      const existing = lineupStates.get(lineupKey) ?? {
        playerIds,
        gamesPlayed: 0,
        wins: 0,
        lastPlayedAt: null,
      }

      existing.gamesPlayed += 1
      if (participants[0]?.placement === 1) existing.wins += 1
      existing.lastPlayedAt = Math.max(existing.lastPlayedAt ?? 0, match.completedAt ?? 0) || null
      lineupStates.set(lineupKey, existing)
    }
  }

  const allPlayerIds = [...new Set([...lineupsByBucket.values()].flatMap(lineups => [...lineups.values()].flatMap(lineup => lineup.playerIds)))]
  const relevantModes = [...new Set(bucketContexts.map(context => context.leaderboardMode))]
  const ratingRows = allPlayerIds.length > 0
    ? await db
        .select({
          playerId: playerRatings.playerId,
          mode: playerRatings.mode,
          mu: playerRatings.mu,
          sigma: playerRatings.sigma,
        })
        .from(playerRatings)
        .where(and(
          inArray(playerRatings.playerId, allPlayerIds),
          inArray(playerRatings.mode, relevantModes),
        ))
    : []

  const ratingByPlayerAndMode = new Map(ratingRows.map(row => [`${row.mode}:${row.playerId}`, row] as const))

  return requestedBuckets.map((bucket) => {
    const bucketContext = getTeamLeaderboardBucketContext(bucket)
    const rows = [...(lineupsByBucket.get(bucket)?.values() ?? [])]
      .map((lineup) => {
        const players: PlayerRating[] = lineup.playerIds.map((playerId) => {
          const rating = ratingByPlayerAndMode.get(`${bucketContext.leaderboardMode}:${playerId}`)
          if (!rating) return createRating(playerId)
          return {
            playerId,
            mu: rating.mu,
            sigma: rating.sigma,
          }
        })

        return {
          playerIds: lineup.playerIds,
          displayRating: Math.round(projectLineupDisplayRating(players)),
          gamesPlayed: lineup.gamesPlayed,
          wins: lineup.wins,
          lastPlayedAt: lineup.lastPlayedAt,
        } satisfies TeamLeaderboardSnapshotRow
      })
      .sort(compareTeamLeaderboardRows)

    return buildTeamLeaderboardBucketSnapshot(bucket, rows, updatedAt)
  })
}

function buildTeamLeaderboardBucketSnapshot(
  bucket: TeamLeaderboardBucket,
  rows: TeamLeaderboardSnapshotRow[],
  updatedAt: number,
): TeamLeaderboardBucketSnapshot {
  return {
    bucket,
    updatedAt,
    rows: rows.map(row => ({
      playerIds: [...row.playerIds],
      displayRating: row.displayRating,
      gamesPlayed: row.gamesPlayed,
      wins: row.wins,
      lastPlayedAt: row.lastPlayedAt,
    })),
  }
}

async function setTeamLeaderboardBucketSnapshots(
  kv: KVNamespace,
  snapshots: readonly TeamLeaderboardBucketSnapshot[],
): Promise<void> {
  await stateStoreMput(kv, [{
    key: teamLeaderboardSnapshotKey(),
    value: JSON.stringify({
      updatedAt: Math.max(0, ...snapshots.map(snapshot => snapshot.updatedAt)),
      buckets: Object.fromEntries(snapshots.map(snapshot => [snapshot.bucket, snapshot.rows.map(row => ({
        playerIds: [...row.playerIds],
        displayRating: row.displayRating,
        gamesPlayed: row.gamesPlayed,
        wins: row.wins,
        lastPlayedAt: row.lastPlayedAt,
      }))])),
    } satisfies StoredTeamLeaderboardSnapshot),
  }])
}

function normalizeTeamLeaderboardSnapshots(value: unknown): Map<TeamLeaderboardBucket, TeamLeaderboardBucketSnapshot> {
  if (!value || typeof value !== 'object') return new Map()

  const raw = value as StoredTeamLeaderboardSnapshot
  if (!raw.buckets || typeof raw.buckets !== 'object') return new Map()

  const updatedAt = typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
    ? Math.round(raw.updatedAt)
    : 0

  const snapshots = new Map<TeamLeaderboardBucket, TeamLeaderboardBucketSnapshot>()
  const rawBuckets = raw.buckets as Record<string, unknown>

  for (const bucket of TEAM_LEADERBOARD_BUCKETS) {
    const rawRows = rawBuckets[bucket]
    if (!Array.isArray(rawRows)) continue

    const rows = rawRows
      .map(normalizeTeamLeaderboardSnapshotRow)
      .filter((row): row is TeamLeaderboardSnapshotRow => row !== null)

    snapshots.set(bucket, buildTeamLeaderboardBucketSnapshot(bucket, rows, updatedAt))
  }

  return snapshots
}

function normalizeTeamLeaderboardSnapshotRow(value: unknown): TeamLeaderboardSnapshotRow | null {
  if (!value || typeof value !== 'object') return null

  const raw = value as Record<string, unknown>
  const playerIds = normalizePlayerIds(raw.playerIds)
  const displayRating = normalizeFiniteNumber(raw.displayRating)
  const gamesPlayed = normalizeNonNegativeInteger(raw.gamesPlayed)
  const wins = normalizeNonNegativeInteger(raw.wins)
  if (!playerIds || displayRating == null || gamesPlayed == null || wins == null) return null

  return {
    playerIds,
    displayRating: Math.round(displayRating),
    gamesPlayed,
    wins,
    lastPlayedAt: normalizeNullableTimestamp(raw.lastPlayedAt),
  }
}

function hasTeamLeaderboardBuckets(
  snapshots: Map<TeamLeaderboardBucket, TeamLeaderboardBucketSnapshot>,
  buckets: readonly TeamLeaderboardBucket[],
): boolean {
  return buckets.every(bucket => snapshots.has(bucket))
}

function normalizePlayerIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const playerIds = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return playerIds.length === value.length ? playerIds : null
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

function compareTeamLeaderboardRows(left: TeamLeaderboardSnapshotRow, right: TeamLeaderboardSnapshotRow): number {
  const ratingDiff = right.displayRating - left.displayRating
  if (ratingDiff !== 0) return ratingDiff

  const gamesDiff = right.gamesPlayed - left.gamesPlayed
  if (gamesDiff !== 0) return gamesDiff

  const winsDiff = right.wins - left.wins
  if (winsDiff !== 0) return winsDiff

  const lastPlayedDiff = (right.lastPlayedAt ?? 0) - (left.lastPlayedAt ?? 0)
  if (lastPlayedDiff !== 0) return lastPlayedDiff

  return left.playerIds.join(':').localeCompare(right.playerIds.join(':'))
}

function expectedPlayerCount(gameMode: TeamLeaderboardBucketContext['gameMode']): number {
  if (gameMode === '2v2') return 2
  if (gameMode === '3v3') return 3
  return 4
}

function isTeamLeaderboardBucket(value: unknown): value is TeamLeaderboardBucket {
  return typeof value === 'string' && TEAM_LEADERBOARD_BUCKETS.includes(value as TeamLeaderboardBucket)
}
