<<<<<<< New base: fix: mod resolve
import type { Context, Hono } from 'hono'
import type { Env } from '../env.ts'
import { createDb, matches, matchParticipants, scopedPlayerRatings as playerRatings, players } from '@civup/db'
import { and, asc, gt, inArray, lte } from 'drizzle-orm'
import { hasAuthenticatedActivityAdminPermission, requireAuthenticatedActivity } from './auth.ts'

const EXPORT_VERSION = 2
const EXPORT_PAGE_SIZE = 50
const FREE_D1_ROWS_READ_PER_DAY = 5_000_000
const FREE_WORKER_REQUESTS_PER_DAY = 100_000
const MAX_RATINGS_PER_PAGE = 1_000
const MAX_PARTICIPANTS_PER_PAGE = 2_000
const MAX_BANS_PER_PAGE = 5_000
const MAX_CURSOR_LENGTH = 1024
const MAX_PARENT_ID_LENGTH = 256
const MAX_FUTURE_CURSOR_MS = 60_000

type ExportPhase = 'players' | 'matches'

interface ExportCursor {
  version: typeof EXPORT_VERSION
  generatedAt: number
  cutoffAt: number
  phase: ExportPhase
  lastParentId: string | null
}

interface ExportBanRow {
  matchId: string
  civId: string
  bannedBy: string
  phase: number
}

interface ExportRowUpperBounds {
  players: number
  ratings: number
  matches: number
  participants: number
  storedBans: number
}

export function registerActivityAdminRoutes(app: Hono<Env>) {
  app.get('/api/activity/admin/capabilities', (c) => {
    c.header('Cache-Control', 'no-store')
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const isAdmin = hasAuthenticatedActivityAdminPermission(c.env, auth.identity)
    return c.json({
      autosaveCatalog: isAdmin,
      playerDataExport: isAdmin,
    })
  })

  app.get('/api/activity/admin/player-data-export', async (c) => {
    c.header('Cache-Control', 'no-store')
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response
    if (!hasAuthenticatedActivityAdminPermission(c.env, auth.identity)) return c.json({ error: 'Forbidden' }, 403)

    const rawCursor = c.req.query('cursor')
    const cursor = rawCursor === undefined ? createInitialCursor() : decodeExportCursor(rawCursor)
    if (!cursor) return c.json({ error: 'Invalid player data export cursor' }, 400)

    return cursor.phase === 'players'
      ? playerExportPage(c, cursor)
      : matchExportPage(c, cursor)
  })

  app.get('/api/activity/admin/player-data-export-estimate', async (c) => {
    c.header('Cache-Control', 'no-store')
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response
    if (!hasAuthenticatedActivityAdminPermission(c.env, auth.identity)) return c.json({ error: 'Forbidden' }, 403)

    const rows = await loadExportRowUpperBounds(c.env.DB)
    const dataPageRequests = Math.max(1, Math.ceil(rows.players / EXPORT_PAGE_SIZE))
      + Math.max(1, Math.ceil(rows.matches / EXPORT_PAGE_SIZE))
    const sourceRows = rows.players + rows.ratings + rows.matches + rows.participants + rows.storedBans
    // Legacy draft JSON expands by ban count, so bracket its cost with conservative per-match multipliers.
    const d1LowEstimate = roundUpEstimate(sourceRows + rows.matches * 2)
    const d1HighEstimate = roundUpEstimate(sourceRows + rows.matches * 15 + rows.storedBans)

    return c.json({
      version: EXPORT_VERSION,
      estimatedAt: Date.now(),
      rows,
      dataPageRequests,
      workerRequests: dataPageRequests * 2,
      d1RowsRead: {
        lowEstimate: d1LowEstimate,
        highEstimate: Math.max(d1LowEstimate, d1HighEstimate),
      },
      dailyFreeAllowance: {
        workerRequests: FREE_WORKER_REQUESTS_PER_DAY,
        d1RowsRead: FREE_D1_ROWS_READ_PER_DAY,
      },
    })
  })
}

async function loadExportRowUpperBounds(d1: D1Database): Promise<ExportRowUpperBounds> {
  const row = await d1.prepare(`
    SELECT
      COALESCE((SELECT MAX(rowid) FROM players), 0) AS players,
      COALESCE((SELECT MAX(rowid) FROM scoped_player_ratings), 0) AS ratings,
      COALESCE((SELECT MAX(rowid) FROM matches), 0) AS matches,
      COALESCE((SELECT MAX(rowid) FROM match_participants), 0) AS participants,
      COALESCE((SELECT MAX(rowid) FROM match_bans), 0) AS storedBans
  `).bind().first<Record<keyof ExportRowUpperBounds, unknown>>()
  if (!row) throw new Error('Player data export estimate returned no data')

  return {
    players: parseRowUpperBound(row.players),
    ratings: parseRowUpperBound(row.ratings),
    matches: parseRowUpperBound(row.matches),
    participants: parseRowUpperBound(row.participants),
    storedBans: parseRowUpperBound(row.storedBans),
  }
}

function parseRowUpperBound(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Player data export estimate returned invalid data')
  return parsed
}

function roundUpEstimate(value: number): number {
  if (value <= 0) return 0
  const unit = 10 ** Math.max(0, Math.floor(Math.log10(value)) - 1)
  return Math.ceil(value / unit) * unit
}

async function playerExportPage(c: Context<Env>, cursor: ExportCursor) {
  const db = createDb(c.env.DB)
  const condition = cursor.lastParentId == null
    ? lte(players.createdAt, cursor.cutoffAt)
    : and(gt(players.id, cursor.lastParentId), lte(players.createdAt, cursor.cutoffAt))
  const parentRows = await db
    .select({
      id: players.id,
      displayName: players.displayName,
      createdAt: players.createdAt,
    })
    .from(players)
    .where(condition)
    .orderBy(asc(players.id))
    .limit(EXPORT_PAGE_SIZE + 1)
  const hasMore = parentRows.length > EXPORT_PAGE_SIZE
  const pageRows = parentRows.slice(0, EXPORT_PAGE_SIZE)
  const parentIds = pageRows.map(row => row.id)
  const ratingRows = parentIds.length === 0
    ? []
    : await db
        .select({
          statsKey: playerRatings.statsKey,
          playerId: playerRatings.playerId,
          mode: playerRatings.mode,
          mu: playerRatings.mu,
          sigma: playerRatings.sigma,
          gamesPlayed: playerRatings.gamesPlayed,
          wins: playerRatings.wins,
          lastPlayedAt: playerRatings.lastPlayedAt,
        })
        .from(playerRatings)
        .where(inArray(playerRatings.playerId, parentIds))
        .orderBy(asc(playerRatings.statsKey), asc(playerRatings.playerId), asc(playerRatings.mode))
        .limit(MAX_RATINGS_PER_PAGE + 1)

  if (ratingRows.length > MAX_RATINGS_PER_PAGE) {
    return c.json({ error: 'Player data export page contains too many ratings' }, 422)
  }

  const nextCursor = hasMore
    ? encodeExportCursor({ ...cursor, lastParentId: pageRows.at(-1)!.id })
    : encodeExportCursor({ ...cursor, phase: 'matches', lastParentId: null })

  return c.json({
    version: EXPORT_VERSION,
    generatedAt: cursor.generatedAt,
    cutoffAt: cursor.cutoffAt,
    phase: 'players' as const,
    players: pageRows,
    ratings: ratingRows,
    nextCursor,
  })
}

async function matchExportPage(c: Context<Env>, cursor: ExportCursor) {
  const db = createDb(c.env.DB)
  const condition = cursor.lastParentId == null
    ? lte(matches.createdAt, cursor.cutoffAt)
    : and(gt(matches.id, cursor.lastParentId), lte(matches.createdAt, cursor.cutoffAt))
  const parentRows = await db
    .select({
      id: matches.id,
      guildId: matches.guildId,
      gameMode: matches.gameMode,
      status: matches.status,
      isOld: matches.isOld,
      seasonId: matches.seasonId,
      createdAt: matches.createdAt,
      completedAt: matches.completedAt,
      draftCompletedAt: matches.draftCompletedAt,
      cancelledAt: matches.cancelledAt,
      resultRevision: matches.resultRevision,
    })
    .from(matches)
    .where(condition)
    .orderBy(asc(matches.id))
    .limit(EXPORT_PAGE_SIZE + 1)
  const hasMore = parentRows.length > EXPORT_PAGE_SIZE
  const pageRows = parentRows.slice(0, EXPORT_PAGE_SIZE)
  const parentIds = pageRows.map(row => row.id)
  const [participantRows, banRows] = parentIds.length === 0
    ? [[], []]
    : await Promise.all([
        db
          .select({
            matchId: matchParticipants.matchId,
            playerId: matchParticipants.playerId,
            sourceGuildId: matchParticipants.sourceGuildId,
            sourceKind: matchParticipants.sourceKind,
            team: matchParticipants.team,
            civId: matchParticipants.civId,
            placement: matchParticipants.placement,
            ratingBeforeMu: matchParticipants.ratingBeforeMu,
            ratingBeforeSigma: matchParticipants.ratingBeforeSigma,
            ratingAfterMu: matchParticipants.ratingAfterMu,
            ratingAfterSigma: matchParticipants.ratingAfterSigma,
          })
          .from(matchParticipants)
          .where(inArray(matchParticipants.matchId, parentIds))
          .orderBy(asc(matchParticipants.matchId), asc(matchParticipants.team), asc(matchParticipants.playerId))
          .limit(MAX_PARTICIPANTS_PER_PAGE + 1),
        loadExportBanRows(c.env.DB, parentIds),
      ])
  if (participantRows.length > MAX_PARTICIPANTS_PER_PAGE) {
    return c.json({ error: 'Player data export page contains too many participants' }, 422)
  }
  if (banRows.length > MAX_BANS_PER_PAGE) {
    return c.json({ error: 'Player data export page contains too many bans' }, 422)
  }
  const nextCursor = hasMore
    ? encodeExportCursor({ ...cursor, lastParentId: pageRows.at(-1)!.id })
    : null

  return c.json({
    version: EXPORT_VERSION,
    generatedAt: cursor.generatedAt,
    cutoffAt: cursor.cutoffAt,
    phase: 'matches' as const,
    matches: pageRows,
    participants: participantRows,
    bans: banRows,
    nextCursor,
  })
}

function createInitialCursor(): ExportCursor {
  const now = Date.now()
  return {
    version: EXPORT_VERSION,
    generatedAt: now,
    cutoffAt: now,
    phase: 'players',
    lastParentId: null,
  }
}

function encodeExportCursor(cursor: ExportCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeExportCursor(value: string): ExportCursor | null {
  if (value.length === 0 || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) return null

  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

    const record = parsed as Record<string, unknown>
    const keys = Object.keys(record).sort()
    if (keys.join(',') !== 'cutoffAt,generatedAt,lastParentId,phase,version') return null
    if (record.version !== EXPORT_VERSION) return null
    if (record.phase !== 'players' && record.phase !== 'matches') return null
    if (!isBoundedTimestamp(record.generatedAt) || !isBoundedTimestamp(record.cutoffAt)) return null
    if (record.generatedAt !== record.cutoffAt) return null
    if (!isBoundedParentId(record.lastParentId)) return null
    if (record.phase === 'players' && record.lastParentId == null) return null

    return {
      version: EXPORT_VERSION,
      generatedAt: record.generatedAt,
      cutoffAt: record.cutoffAt,
      phase: record.phase,
      lastParentId: record.lastParentId,
    }
  }
  catch {
    return null
  }
}

function isBoundedTimestamp(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= Date.now() + MAX_FUTURE_CURSOR_MS
}

function isBoundedParentId(value: unknown): value is string | null {
  return value === null || (
    typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_PARENT_ID_LENGTH
    && !/[\u0000-\u001F\u007F]/.test(value)
  )
}

async function loadExportBanRows(d1: D1Database, matchIds: string[]): Promise<ExportBanRow[]> {
  const placeholders = matchIds.map(() => '?').join(', ')
  const result = await d1.prepare(`
    WITH selected_matches AS (
      SELECT
        id,
        CASE WHEN json_valid(draft_data) THEN draft_data ELSE NULL END AS draft_data
      FROM matches
      WHERE id IN (${placeholders})
    ),
    normalized_draft_bans AS (
      SELECT
        selected_matches.id,
        selected_matches.draft_data,
        CASE WHEN ban.type = 'object' THEN ban.value ELSE NULL END AS ban_data
      FROM selected_matches
      JOIN json_each(
        selected_matches.draft_data,
        '$.state.bans'
      ) AS ban
      WHERE json_type(selected_matches.draft_data, '$.state.bans') = 'array'
    )
    SELECT
      match_id AS matchId,
      civ_id AS civId,
      banned_by AS bannedBy,
      phase
    FROM match_bans
    WHERE match_id IN (SELECT id FROM selected_matches)
    UNION
    SELECT
      normalized_draft_bans.id AS matchId,
      json_extract(normalized_draft_bans.ban_data, '$.civId') AS civId,
      json_extract(
        normalized_draft_bans.draft_data,
        CASE
          WHEN json_type(normalized_draft_bans.ban_data, '$.seatIndex') = 'integer'
            AND json_extract(normalized_draft_bans.ban_data, '$.seatIndex') >= 0
            THEN '$.state.seats[' || json_extract(normalized_draft_bans.ban_data, '$.seatIndex') || '].playerId'
          ELSE '$.__invalid'
        END
      ) AS bannedBy,
      json_extract(normalized_draft_bans.ban_data, '$.stepIndex') AS phase
    FROM normalized_draft_bans
    WHERE json_type(normalized_draft_bans.draft_data, '$.state.seats') = 'array'
      AND json_type(normalized_draft_bans.ban_data, '$.civId') = 'text'
      AND length(json_extract(normalized_draft_bans.ban_data, '$.civId')) > 0
      AND json_type(normalized_draft_bans.ban_data, '$.seatIndex') = 'integer'
      AND json_extract(normalized_draft_bans.ban_data, '$.seatIndex') >= 0
      AND json_type(normalized_draft_bans.ban_data, '$.stepIndex') = 'integer'
      AND json_extract(normalized_draft_bans.ban_data, '$.stepIndex') >= 0
      AND json_type(
        normalized_draft_bans.draft_data,
        CASE
          WHEN json_type(normalized_draft_bans.ban_data, '$.seatIndex') = 'integer'
            AND json_extract(normalized_draft_bans.ban_data, '$.seatIndex') >= 0
            THEN '$.state.seats[' || json_extract(normalized_draft_bans.ban_data, '$.seatIndex') || '].playerId'
          ELSE '$.__invalid'
        END
      ) = 'text'
      AND length(json_extract(
        normalized_draft_bans.draft_data,
        CASE
          WHEN json_type(normalized_draft_bans.ban_data, '$.seatIndex') = 'integer'
            AND json_extract(normalized_draft_bans.ban_data, '$.seatIndex') >= 0
            THEN '$.state.seats[' || json_extract(normalized_draft_bans.ban_data, '$.seatIndex') || '].playerId'
          ELSE '$.__invalid'
        END
      )) > 0
    ORDER BY matchId, phase, civId, bannedBy
    LIMIT ${MAX_BANS_PER_PAGE + 1}
  `).bind(...matchIds).all<ExportBanRow>()

  return result.results
}
|||||||
=======
import type { Context, Hono } from 'hono'
import type { Env } from '../env.ts'
import { createDb, matches, matchParticipants, playerRatings, players } from '@civup/db'
import { and, asc, gt, inArray, lte } from 'drizzle-orm'
import { hasAuthenticatedActivityAdminPermission, requireAuthenticatedActivity } from './auth.ts'

const EXPORT_VERSION = 1
const EXPORT_PAGE_SIZE = 50
const FREE_D1_ROWS_READ_PER_DAY = 5_000_000
const FREE_WORKER_REQUESTS_PER_DAY = 100_000
const MAX_RATINGS_PER_PAGE = 1_000
const MAX_PARTICIPANTS_PER_PAGE = 2_000
const MAX_BANS_PER_PAGE = 5_000
const MAX_CURSOR_LENGTH = 1024
const MAX_PARENT_ID_LENGTH = 256
const MAX_FUTURE_CURSOR_MS = 60_000

type ExportPhase = 'players' | 'matches'

interface ExportCursor {
  version: typeof EXPORT_VERSION
  generatedAt: number
  cutoffAt: number
  phase: ExportPhase
  lastParentId: string | null
}

interface ExportBanRow {
  matchId: string
  civId: string
  bannedBy: string
  phase: number
}

interface ExportRowUpperBounds {
  players: number
  ratings: number
  matches: number
  participants: number
  storedBans: number
}

export function registerActivityAdminRoutes(app: Hono<Env>) {
  app.get('/api/activity/admin/capabilities', (c) => {
    c.header('Cache-Control', 'no-store')
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response

    const isAdmin = hasAuthenticatedActivityAdminPermission(c.env, auth.identity)
    return c.json({
      autosaveCatalog: isAdmin,
      playerDataExport: isAdmin,
    })
  })

  app.get('/api/activity/admin/player-data-export', async (c) => {
    c.header('Cache-Control', 'no-store')
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response
    if (!hasAuthenticatedActivityAdminPermission(c.env, auth.identity)) return c.json({ error: 'Forbidden' }, 403)

    const rawCursor = c.req.query('cursor')
    const cursor = rawCursor === undefined ? createInitialCursor() : decodeExportCursor(rawCursor)
    if (!cursor) return c.json({ error: 'Invalid player data export cursor' }, 400)

    return cursor.phase === 'players'
      ? playerExportPage(c, cursor)
      : matchExportPage(c, cursor)
  })

  app.get('/api/activity/admin/player-data-export-estimate', async (c) => {
    c.header('Cache-Control', 'no-store')
    const auth = requireAuthenticatedActivity(c)
    if (!auth.ok) return auth.response
    if (!hasAuthenticatedActivityAdminPermission(c.env, auth.identity)) return c.json({ error: 'Forbidden' }, 403)

    const rows = await loadExportRowUpperBounds(c.env.DB)
    const dataPageRequests = Math.max(1, Math.ceil(rows.players / EXPORT_PAGE_SIZE))
      + Math.max(1, Math.ceil(rows.matches / EXPORT_PAGE_SIZE))
    const sourceRows = rows.players + rows.ratings + rows.matches + rows.participants + rows.storedBans
    // Legacy draft JSON expands by ban count, so bracket its cost with conservative per-match multipliers.
    const d1LowEstimate = roundUpEstimate(sourceRows + rows.matches * 2)
    const d1HighEstimate = roundUpEstimate(sourceRows + rows.matches * 15 + rows.storedBans)

    return c.json({
      version: EXPORT_VERSION,
      estimatedAt: Date.now(),
      rows,
      dataPageRequests,
      workerRequests: dataPageRequests * 2,
      d1RowsRead: {
        lowEstimate: d1LowEstimate,
        highEstimate: Math.max(d1LowEstimate, d1HighEstimate),
      },
      dailyFreeAllowance: {
        workerRequests: FREE_WORKER_REQUESTS_PER_DAY,
        d1RowsRead: FREE_D1_ROWS_READ_PER_DAY,
      },
    })
  })
}

async function loadExportRowUpperBounds(d1: D1Database): Promise<ExportRowUpperBounds> {
  const row = await d1.prepare(`
    SELECT
      COALESCE((SELECT MAX(rowid) FROM players), 0) AS players,
      COALESCE((SELECT MAX(rowid) FROM player_ratings), 0) AS ratings,
      COALESCE((SELECT MAX(rowid) FROM matches), 0) AS matches,
      COALESCE((SELECT MAX(rowid) FROM match_participants), 0) AS participants,
      COALESCE((SELECT MAX(rowid) FROM match_bans), 0) AS storedBans
  `).bind().first<Record<keyof ExportRowUpperBounds, unknown>>()
  if (!row) throw new Error('Player data export estimate returned no data')

  return {
    players: parseRowUpperBound(row.players),
    ratings: parseRowUpperBound(row.ratings),
    matches: parseRowUpperBound(row.matches),
    participants: parseRowUpperBound(row.participants),
    storedBans: parseRowUpperBound(row.storedBans),
  }
}

function parseRowUpperBound(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Player data export estimate returned invalid data')
  return parsed
}

function roundUpEstimate(value: number): number {
  if (value <= 0) return 0
  const unit = 10 ** Math.max(0, Math.floor(Math.log10(value)) - 1)
  return Math.ceil(value / unit) * unit
}

async function playerExportPage(c: Context<Env>, cursor: ExportCursor) {
  const db = createDb(c.env.DB)
  const condition = cursor.lastParentId == null
    ? lte(players.createdAt, cursor.cutoffAt)
    : and(gt(players.id, cursor.lastParentId), lte(players.createdAt, cursor.cutoffAt))
  const parentRows = await db
    .select({
      id: players.id,
      displayName: players.displayName,
      createdAt: players.createdAt,
    })
    .from(players)
    .where(condition)
    .orderBy(asc(players.id))
    .limit(EXPORT_PAGE_SIZE + 1)
  const hasMore = parentRows.length > EXPORT_PAGE_SIZE
  const pageRows = parentRows.slice(0, EXPORT_PAGE_SIZE)
  const parentIds = pageRows.map(row => row.id)
  const ratingRows = parentIds.length === 0
    ? []
    : await db
        .select({
          playerId: playerRatings.playerId,
          mode: playerRatings.mode,
          mu: playerRatings.mu,
          sigma: playerRatings.sigma,
          gamesPlayed: playerRatings.gamesPlayed,
          wins: playerRatings.wins,
          lastPlayedAt: playerRatings.lastPlayedAt,
        })
        .from(playerRatings)
        .where(inArray(playerRatings.playerId, parentIds))
        .orderBy(asc(playerRatings.playerId), asc(playerRatings.mode))
        .limit(MAX_RATINGS_PER_PAGE + 1)

  if (ratingRows.length > MAX_RATINGS_PER_PAGE) {
    return c.json({ error: 'Player data export page contains too many ratings' }, 422)
  }

  const nextCursor = hasMore
    ? encodeExportCursor({ ...cursor, lastParentId: pageRows.at(-1)!.id })
    : encodeExportCursor({ ...cursor, phase: 'matches', lastParentId: null })

  return c.json({
    version: EXPORT_VERSION,
    generatedAt: cursor.generatedAt,
    cutoffAt: cursor.cutoffAt,
    phase: 'players' as const,
    players: pageRows,
    ratings: ratingRows,
    nextCursor,
  })
}

async function matchExportPage(c: Context<Env>, cursor: ExportCursor) {
  const db = createDb(c.env.DB)
  const condition = cursor.lastParentId == null
    ? lte(matches.createdAt, cursor.cutoffAt)
    : and(gt(matches.id, cursor.lastParentId), lte(matches.createdAt, cursor.cutoffAt))
  const parentRows = await db
    .select({
      id: matches.id,
      gameMode: matches.gameMode,
      status: matches.status,
      isOld: matches.isOld,
      seasonId: matches.seasonId,
      createdAt: matches.createdAt,
      completedAt: matches.completedAt,
    })
    .from(matches)
    .where(condition)
    .orderBy(asc(matches.id))
    .limit(EXPORT_PAGE_SIZE + 1)
  const hasMore = parentRows.length > EXPORT_PAGE_SIZE
  const pageRows = parentRows.slice(0, EXPORT_PAGE_SIZE)
  const parentIds = pageRows.map(row => row.id)
  const [participantRows, banRows] = parentIds.length === 0
    ? [[], []]
    : await Promise.all([
        db
          .select({
            matchId: matchParticipants.matchId,
            playerId: matchParticipants.playerId,
            team: matchParticipants.team,
            civId: matchParticipants.civId,
            placement: matchParticipants.placement,
            ratingBeforeMu: matchParticipants.ratingBeforeMu,
            ratingBeforeSigma: matchParticipants.ratingBeforeSigma,
            ratingAfterMu: matchParticipants.ratingAfterMu,
            ratingAfterSigma: matchParticipants.ratingAfterSigma,
          })
          .from(matchParticipants)
          .where(inArray(matchParticipants.matchId, parentIds))
          .orderBy(asc(matchParticipants.matchId), asc(matchParticipants.team), asc(matchParticipants.playerId))
          .limit(MAX_PARTICIPANTS_PER_PAGE + 1),
        loadExportBanRows(c.env.DB, parentIds),
      ])
  if (participantRows.length > MAX_PARTICIPANTS_PER_PAGE) {
    return c.json({ error: 'Player data export page contains too many participants' }, 422)
  }
  if (banRows.length > MAX_BANS_PER_PAGE) {
    return c.json({ error: 'Player data export page contains too many bans' }, 422)
  }
  const nextCursor = hasMore
    ? encodeExportCursor({ ...cursor, lastParentId: pageRows.at(-1)!.id })
    : null

  return c.json({
    version: EXPORT_VERSION,
    generatedAt: cursor.generatedAt,
    cutoffAt: cursor.cutoffAt,
    phase: 'matches' as const,
    matches: pageRows,
    participants: participantRows,
    bans: banRows,
    nextCursor,
  })
}

function createInitialCursor(): ExportCursor {
  const now = Date.now()
  return {
    version: EXPORT_VERSION,
    generatedAt: now,
    cutoffAt: now,
    phase: 'players',
    lastParentId: null,
  }
}

function encodeExportCursor(cursor: ExportCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeExportCursor(value: string): ExportCursor | null {
  if (value.length === 0 || value.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) return null

  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
    const binary = atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

    const record = parsed as Record<string, unknown>
    const keys = Object.keys(record).sort()
    if (keys.join(',') !== 'cutoffAt,generatedAt,lastParentId,phase,version') return null
    if (record.version !== EXPORT_VERSION) return null
    if (record.phase !== 'players' && record.phase !== 'matches') return null
    if (!isBoundedTimestamp(record.generatedAt) || !isBoundedTimestamp(record.cutoffAt)) return null
    if (record.generatedAt !== record.cutoffAt) return null
    if (!isBoundedParentId(record.lastParentId)) return null
    if (record.phase === 'players' && record.lastParentId == null) return null

    return {
      version: EXPORT_VERSION,
      generatedAt: record.generatedAt,
      cutoffAt: record.cutoffAt,
      phase: record.phase,
      lastParentId: record.lastParentId,
    }
  }
  catch {
    return null
  }
}

function isBoundedTimestamp(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= Date.now() + MAX_FUTURE_CURSOR_MS
}

function isBoundedParentId(value: unknown): value is string | null {
  return value === null || (
    typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_PARENT_ID_LENGTH
    && !/[\u0000-\u001F\u007F]/.test(value)
  )
}

async function loadExportBanRows(d1: D1Database, matchIds: string[]): Promise<ExportBanRow[]> {
  const placeholders = matchIds.map(() => '?').join(', ')
  const result = await d1.prepare(`
    WITH selected_matches AS (
      SELECT
        id,
        CASE WHEN json_valid(draft_data) THEN draft_data ELSE NULL END AS draft_data
      FROM matches
      WHERE id IN (${placeholders})
    ),
    normalized_draft_bans AS (
      SELECT
        selected_matches.id,
        selected_matches.draft_data,
        CASE WHEN ban.type = 'object' THEN ban.value ELSE NULL END AS ban_data
      FROM selected_matches
      JOIN json_each(
        selected_matches.draft_data,
        '$.state.bans'
      ) AS ban
      WHERE json_type(selected_matches.draft_data, '$.state.bans') = 'array'
    )
    SELECT
      match_id AS matchId,
      civ_id AS civId,
      banned_by AS bannedBy,
      phase
    FROM match_bans
    WHERE match_id IN (SELECT id FROM selected_matches)
    UNION
    SELECT
      normalized_draft_bans.id AS matchId,
      json_extract(normalized_draft_bans.ban_data, '$.civId') AS civId,
      json_extract(
        normalized_draft_bans.draft_data,
        CASE
          WHEN json_type(normalized_draft_bans.ban_data, '$.seatIndex') = 'integer'
            AND json_extract(normalized_draft_bans.ban_data, '$.seatIndex') >= 0
            THEN '$.state.seats[' || json_extract(normalized_draft_bans.ban_data, '$.seatIndex') || '].playerId'
          ELSE '$.__invalid'
        END
      ) AS bannedBy,
      json_extract(normalized_draft_bans.ban_data, '$.stepIndex') AS phase
    FROM normalized_draft_bans
    WHERE json_type(normalized_draft_bans.draft_data, '$.state.seats') = 'array'
      AND json_type(normalized_draft_bans.ban_data, '$.civId') = 'text'
      AND length(json_extract(normalized_draft_bans.ban_data, '$.civId')) > 0
      AND json_type(normalized_draft_bans.ban_data, '$.seatIndex') = 'integer'
      AND json_extract(normalized_draft_bans.ban_data, '$.seatIndex') >= 0
      AND json_type(normalized_draft_bans.ban_data, '$.stepIndex') = 'integer'
      AND json_extract(normalized_draft_bans.ban_data, '$.stepIndex') >= 0
      AND json_type(
        normalized_draft_bans.draft_data,
        CASE
          WHEN json_type(normalized_draft_bans.ban_data, '$.seatIndex') = 'integer'
            AND json_extract(normalized_draft_bans.ban_data, '$.seatIndex') >= 0
            THEN '$.state.seats[' || json_extract(normalized_draft_bans.ban_data, '$.seatIndex') || '].playerId'
          ELSE '$.__invalid'
        END
      ) = 'text'
      AND length(json_extract(
        normalized_draft_bans.draft_data,
        CASE
          WHEN json_type(normalized_draft_bans.ban_data, '$.seatIndex') = 'integer'
            AND json_extract(normalized_draft_bans.ban_data, '$.seatIndex') >= 0
            THEN '$.state.seats[' || json_extract(normalized_draft_bans.ban_data, '$.seatIndex') || '].playerId'
          ELSE '$.__invalid'
        END
      )) > 0
    ORDER BY matchId, phase, civId, bannedBy
    LIMIT ${MAX_BANS_PER_PAGE + 1}
  `).bind(...matchIds).all<ExportBanRow>()

  return result.results
}
>>>>>>> Current commit: chore: cleanup and simplify setup
