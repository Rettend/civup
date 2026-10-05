import type { Database } from '@civup/db'
import type { LeaderboardMode } from '@civup/game'
import { and, eq, sql } from 'drizzle-orm'
import { seasonStandingSnapshots, seasons } from '@civup/db'
import { LEADERBOARD_MODES } from '@civup/game'
import {
  DEFAULT_MU,
  DEFAULT_SIGMA,
  DISPLAY_RATING_BASE,
  DISPLAY_RATING_SCALE,
  getLeaderboardMinGames,
  RANKED_ROLE_MIN_EFFECTIVE_GAMES,
  RANKED_ROLE_Z_MULTIPLIER,
  Z_MULTIPLIER,
} from '@civup/rating'

const VERSION = 2
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`

export interface SeasonStandings {
  modes: Array<{
    playerId: string
    mode: LeaderboardMode
    rating: number
    position: number | null
    peakTier: string | null
    peakRating: number | null
  }>
  peaks: Array<{ playerId: string; tier: string; divisionMinimum: number | null }>
  graphScores: Array<{ playerId: string; mode: string; score: number; lastPlayedAt: number | null; qualified: number }>
}

export function historicalModeRankLabel(
  standing: SeasonStandings['modes'][number] | undefined,
  seasonNumber: number,
  roleIds?: Record<string, string | null>,
  unrankedRoleId?: string | null,
  labels?: Record<string, string>,
): string | null {
  const tier = standing?.peakTier
  if (!tier) return standing?.position == null ? (unrankedRoleId ? `<@&${unrankedRoleId}>` : 'Unranked') : null
  const roleId = roleIds?.[tier]
  if (roleId) return `<@&${roleId}>`
  return labels?.[tier] ?? `S${seasonNumber} Role ${tier.slice(4)}`
}

/** A single statement saves positions and recorded peaks from the same database revision. */
export function seasonStandingsWriteStatement(seasonId: string): string {
  return `INSERT INTO season_standing_snapshots(season_id, revision, version, finalized_at, payload)
    ${seasonStandingsSelectStatement(seasonId)}
    ON CONFLICT(season_id) DO UPDATE SET revision = excluded.revision, version = excluded.version, finalized_at = excluded.finalized_at, payload = excluded.payload`
}

export function prepareSeasonStandingsWrite(db: Database, seasonId: string) {
  return db
    .insert(seasonStandingSnapshots)
    .select(sql.raw(seasonStandingsSelectStatement(seasonId)))
    .onConflictDoUpdate({
      target: seasonStandingSnapshots.seasonId,
      set: {
        revision: sql`excluded.revision`,
        version: sql`excluded.version`,
        finalizedAt: sql`excluded.finalized_at`,
        payload: sql`excluded.payload`,
      },
    })
}

function seasonStandingsSelectStatement(seasonId: string): string {
  const eligible = LEADERBOARD_MODES.filter(mode => mode !== 'red-death')
    .map(
      mode =>
        `(r.mode = ${quote(mode)} AND coalesce(json_extract(r.evidence, '$.gamesPlayed'), r.season_games) >= ${getLeaderboardMinGames(mode)})`,
    )
    .join(' OR ')
  const legacyRating = `${DISPLAY_RATING_BASE} + ${DISPLAY_RATING_SCALE} * ((r.mu - ${Z_MULTIPLIER} * r.sigma) - (${DEFAULT_MU} - ${Z_MULTIPLIER} * ${DEFAULT_SIGMA}))`
  return `WITH source AS (
      SELECT r.player_id, r.mode, CASE WHEN s.rating_system = 'rp' THEN r.public_rating ELSE ${legacyRating} END AS rating,
        (${eligible}) AS eligible, p.tier AS peak_tier, p.rating AS peak_rating
      FROM season_rating_states r JOIN seasons s ON s.id = r.season_id
      LEFT JOIN season_peak_mode_ranks p ON p.season_id = r.season_id AND p.player_id = r.player_id AND p.mode = r.mode
      WHERE r.season_id = ${quote(seasonId)} AND r.mode IN ('duel', 'duo', 'squad', 'ffa')
    ), graph_scores AS (
      SELECT r.player_id, r.mode, r.last_played_at,
        CASE WHEN r.mode='global' THEN ${DISPLAY_RATING_BASE} + ${DISPLAY_RATING_SCALE} * (r.mu - ${RANKED_ROLE_Z_MULTIPLIER} * r.sigma - ${DEFAULT_MU}) ELSE ${legacyRating} END AS score,
        (r.mode='global' OR coalesce(json_extract(r.evidence,'$.gamesPlayed'),0)>=10) AS qualified
      FROM season_rating_states r JOIN seasons s ON s.id=r.season_id WHERE s.rating_system!='rp' AND r.season_id=${quote(seasonId)} AND ((r.mode='global' AND coalesce(json_extract(r.evidence,'$.effectiveGames'),0)>=${RANKED_ROLE_MIN_EFFECTIVE_GAMES}) OR (${eligible}))
      ORDER BY score DESC, coalesce(r.last_played_at,0) DESC, r.player_id ASC
    ), ranked AS (
      SELECT *, CASE WHEN eligible THEN row_number() OVER (PARTITION BY mode ORDER BY eligible DESC, rating DESC, player_id ASC) END AS position FROM source
    )
    SELECT s.id, s.standings_revision, ${VERSION}, s.finalized_at,
      json_object('modes', json((SELECT json_group_array(json_object('playerId', player_id, 'mode', mode, 'rating', rating,
        'position', position, 'peakTier', peak_tier, 'peakRating', peak_rating)) FROM ranked)),
        'peaks', json((SELECT json_group_array(json_object('playerId', p.player_id, 'tier', p.tier, 'divisionMinimum', d.minimum))
          FROM season_peak_ranks p LEFT JOIN season_peak_division_ranks d ON d.season_id = p.season_id AND d.player_id = p.player_id
           WHERE p.season_id = s.id)),
         'graphScores', json((SELECT json_group_array(json_object('playerId',player_id,'mode',mode,'score',score,'lastPlayedAt',last_played_at,'qualified',qualified)) FROM graph_scores)))
    FROM seasons s WHERE s.id = ${quote(seasonId)} AND s.active = 0
      AND (s.rating_system != 'rp' OR s.public_reads_enabled = 1)
      AND NOT EXISTS (SELECT 1 FROM source WHERE rating IS NULL)
      AND NOT EXISTS (SELECT 1 FROM season_standing_snapshots saved WHERE saved.season_id = s.id AND saved.revision = s.standings_revision AND saved.version = ${VERSION})`
}

export async function loadSeasonStandings(
  db: Database,
  kv: KVNamespace | undefined,
  seasonId: string,
): Promise<SeasonStandings | null> {
  const [season] = await db
    .select({
      revision: seasons.standingsRevision,
      active: seasons.active,
      ratingSystem: seasons.ratingSystem,
      enabled: seasons.publicReadsEnabled,
    })
    .from(seasons)
    .where(eq(seasons.id, seasonId))
    .limit(1)
  if (!season || season.active || (season.ratingSystem === 'rp' && !season.enabled)) return null
  const key = `leaderboard:season-snapshot:v${VERSION}:${seasonId}:${season.revision}`
  const cached = (await kv?.get(key, 'json')) as
    | { seasonId?: string; revision?: number; version?: number; data?: SeasonStandings }
    | null
    | undefined
  if (
    cached?.seasonId === seasonId &&
    cached.revision === season.revision &&
    cached.version === VERSION &&
    validStandings(cached.data)
  )
    return cached.data

  const [saved] = await db
    .select()
    .from(seasonStandingSnapshots)
    .where(and(eq(seasonStandingSnapshots.seasonId, seasonId), eq(seasonStandingSnapshots.version, VERSION)))
    .limit(1)
  // A concurrent late report can advance the source while this request is loading it.
  if (!saved || saved.revision < season.revision)
    throw new Error('Season standings are not ready. Please try again shortly.')
  const data: unknown = JSON.parse(saved.payload)
  if (!validStandings(data)) throw new Error('Saved season standings are incomplete.')
  const savedKey = `leaderboard:season-snapshot:v${VERSION}:${seasonId}:${saved.revision}`
  await kv?.put(
    savedKey,
    JSON.stringify({ seasonId, revision: saved.revision, version: VERSION, data }),
    saved.finalizedAt == null ? { expirationTtl: 86_400 } : undefined,
  )
  return data
}

/** Maintenance only: publish one changed closed season, independently of public reads. */
export async function refreshHistoricalStandings(db: Database): Promise<boolean> {
  const [season] = await db
    .select({ id: seasons.id, revision: seasons.standingsRevision })
    .from(seasons)
    .where(sql`${seasons.active}=0
    and (${seasons.ratingSystem}!='rp' or ${seasons.publicReadsEnabled}=1)
    and not exists(select 1 from season_standing_snapshots saved where saved.season_id=${seasons.id} and saved.revision=${seasons.standingsRevision} and saved.version=${VERSION})`)
    .orderBy(seasons.startsAt)
    .limit(1)
  if (!season) return false
  await db.run(sql.raw(seasonStandingsWriteStatement(season.id)))
  const [saved] = await db
    .select({ revision: seasonStandingSnapshots.revision })
    .from(seasonStandingSnapshots)
    .where(and(eq(seasonStandingSnapshots.seasonId, season.id), eq(seasonStandingSnapshots.version, VERSION)))
    .limit(1)
  if (!saved || saved.revision < season.revision)
    throw new Error('Historical standings contain incomplete source ratings.')
  return true
}

function validStandings(value: unknown): value is SeasonStandings {
  if (!value || typeof value !== 'object') return false
  const data = value as SeasonStandings
  return (
    Array.isArray(data.modes) &&
    Array.isArray(data.peaks) &&
    Array.isArray(data.graphScores) &&
    data.modes.every(
      row =>
        row != null &&
        typeof row.playerId === 'string' &&
        ['duel', 'duo', 'squad', 'ffa'].includes(row.mode) &&
        Number.isFinite(row.rating) &&
        (row.position === null || (Number.isSafeInteger(row.position) && row.position > 0)),
    ) &&
    data.peaks.every(row => row != null && typeof row.playerId === 'string' && typeof row.tier === 'string')
  )
}
