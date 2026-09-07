import type { PublicRatingCalibration, PublicTier } from '@civup/rating'
import { getLeaderboardMinGames, PUBLIC_RATING_FORMULA_VERSION, RANKED_ROLE_MIN_EFFECTIVE_GAMES } from '@civup/rating'
import { prepareSeasonOpening } from './opening.ts'

type Value = string | number | null
export type MaintenanceRow = Record<string, Value>
export interface CutoverSource {
  generation: number
  season: MaintenanceRow
  ratings: MaintenanceRow[]
  closingTiers: Record<string, PublicTier>
}

export const CUTOVER_EVIDENCE = {
  gamesPlayed: 'games_played', wins: 'wins', importedGames: 'imported_games', effectiveGames: 'effective_games',
  winsVsTier1: 'wins_vs_tier_1', winsVsTier2Plus: 'wins_vs_tier_2_plus',
  effectiveWinsVsTier1: 'effective_wins_vs_tier_1', effectiveWinsVsTier2Plus: 'effective_wins_vs_tier_2_plus',
} as const
export const CUTOVER_SCOPES = ['global', 'duel', 'duo', 'squad', 'ffa', 'red-death'] as const
export const maintenanceQuote = (value: string) => `'${value.replaceAll("'", "''")}'`
export const maintenanceGuard = (condition: string) => `SELECT CASE WHEN ${condition} THEN 1 ELSE json_extract('Stale season maintenance source', '$') END AS valid`

function identifier(value: string): string {
  if (!/^[a-z_][a-z_0-9]*$/.test(value)) throw new Error('Invalid maintenance SQL identifier.')
  return `"${value}"`
}

/** JSON chunks keep both the bind count and statement size bounded. */
export function maintenanceChunks(rows: MaintenanceRow[], build: (json: string) => string): string[] {
  const output: string[] = []
  let chunk: MaintenanceRow[] = []
  for (const row of rows) {
    if (Object.values(row).some(value => typeof value === 'number' && !Number.isFinite(value))) throw new Error('Non-finite maintenance value.')
    const candidate = [...chunk, row]
    if (new TextEncoder().encode(build(maintenanceQuote(JSON.stringify(candidate)))).length > 90_000) {
      if (!chunk.length) throw new Error('One maintenance row exceeds the statement limit.')
      output.push(build(maintenanceQuote(JSON.stringify(chunk))))
      chunk = [row]
    }
    else chunk = candidate
  }
  if (chunk.length) output.push(build(maintenanceQuote(JSON.stringify(chunk))))
  return output
}

export function maintenanceInsert(table: string, rows: MaintenanceRow[], suffix = ''): string[] {
  if (!rows.length) return []
  const columns = Object.keys(rows[0]!)
  if (rows.some(row => JSON.stringify(Object.keys(row)) !== JSON.stringify(columns))) throw new Error('Inconsistent maintenance row shape.')
  return maintenanceChunks(rows, json => `INSERT INTO ${identifier(table)} (${columns.map(identifier).join(',')}) SELECT ${columns.map(column => `json_extract(value, '$.${column}')`).join(',')} FROM json_each(${json}) WHERE 1 ${suffix}`)
}

export function maintenanceRowGuards(table: string, keys: string[], rows: MaintenanceRow[]): string[] {
  if (!rows.length) return []
  const columns = Object.keys(rows[0]!)
  return maintenanceChunks(rows, json => maintenanceGuard(`NOT EXISTS(SELECT 1 FROM json_each(${json}) expected LEFT JOIN ${identifier(table)} actual ON ${keys.map(key => `actual.${identifier(key)} IS json_extract(expected.value, '$.${key}')`).join(' AND ')} WHERE actual.${identifier(keys[0]!)} IS NULL OR ${columns.map(column => `actual.${identifier(column)} IS NOT json_extract(expected.value, '$.${column}')`).join(' OR ')})`))
}

export function pausedMaintenanceGuard(generation: number): string {
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('Invalid maintenance generation.')
  return maintenanceGuard(`EXISTS(SELECT 1 FROM rating_maintenance WHERE id = 1 AND state = 'paused' AND generation = ${generation}) AND NOT EXISTS(SELECT 1 FROM rating_mutation_leases)`)
}

export function validateMaintenanceStatements(statements: string[]): void {
  if (statements.length > 500 || statements.some(statement => new TextEncoder().encode(statement).length > 100_000)) throw new Error('Season maintenance exceeds atomic database limits. Do not split the cutover into partial applies.')
}

export function openingPlayers(source: CutoverSource) {
  return source.ratings.map((row) => {
    const mode = String(row.mode)
    const mu = Number(row.mu)
    const sigma = Number(row.sigma)
    if (!CUTOVER_SCOPES.includes(mode as typeof CUTOVER_SCOPES[number]) || row.public_rating != null) throw new Error('Opening source must contain only legacy rating scopes.')
    const evidence = Object.fromEntries(Object.entries(CUTOVER_EVIDENCE).map(([key, column]) => {
      if (typeof row[column] !== 'number' || !Number.isFinite(row[column]) || row[column]! < 0) throw new Error(`Invalid ${column} in opening source.`)
      return [key, row[column]!]
    })) as Record<string, number>
    const qualified = mode === 'global' ? evidence.effectiveGames! >= RANKED_ROLE_MIN_EFFECTIVE_GAMES : evidence.gamesPlayed! >= getLeaderboardMinGames(mode as Exclude<typeof CUTOVER_SCOPES[number], 'global'>)
    return { playerId: String(row.player_id), mode, mu, sigma, hiddenScore: mu - 0.75 * sigma, qualified,
      closingTier: mode === 'global' && qualified ? source.closingTiers[String(row.player_id)] ?? null : null,
      evidence, seasonGames: evidence.gamesPlayed!, seasonWins: evidence.wins!, lastPlayedAt: row.last_played_at == null ? null : Number(row.last_played_at),
    }
  })
}

export function prepareSeasonCutover(source: CutoverSource, input: {
  seasonId: string, seasonNumber: number, name: string, cutoff: number, resetFactor: number,
  sourceDigest: string, calibrations: PublicRatingCalibration[],
}) {
  const sourceId = String(source.season.id)
  if (source.season.active !== 1 || source.season.ends_at != null || source.season.rating_system !== 'legacy' || source.season.isolated_ratings_enabled !== 0
    || source.season.starts_at == null || Number(source.season.starts_at) >= input.cutoff) throw new Error('Cutover requires one open, non-isolated legacy source season.')
  if (!Number.isSafeInteger(input.seasonNumber) || input.seasonNumber !== Number(source.season.season_number) + 1 || !input.name.trim()) throw new Error('Invalid next season identity.')
  if (source.ratings.some(row => row.updated_at != null && Number(row.updated_at) >= input.cutoff)) throw new Error('The source contains rating writes at or after the cutoff. Choose an approved cutoff after admitted writers finish.')
  if (input.calibrations.length !== CUTOVER_SCOPES.length || CUTOVER_SCOPES.some(scope => !input.calibrations.some(row => row.scope === scope))) throw new Error('Supply reviewed calibrations for every rated scope, including currently sparse modes.')
  const opening = prepareSeasonOpening({ ...input, players: openingPlayers(source), sourceSeasonId: sourceId, seasonId: input.seasonId })
  const qSource = maintenanceQuote(sourceId)
  const qNext = maintenanceQuote(input.seasonId)
  const statements = [pausedMaintenanceGuard(source.generation),
    maintenanceGuard(`(SELECT count(*) FROM seasons WHERE active = 1) = 1 AND NOT EXISTS(SELECT 1 FROM seasons WHERE id = ${qNext} OR rating_system = 'rp')
      AND (SELECT count(*) FROM player_ratings) = ${source.ratings.length}
      AND NOT EXISTS(SELECT 1 FROM season_rating_states) AND NOT EXISTS(SELECT 1 FROM public_rating_seeds)
      AND NOT EXISTS(SELECT 1 FROM season_match_reports) AND NOT EXISTS(SELECT 1 FROM matches WHERE season_id IS NULL)
      AND NOT EXISTS(SELECT 1 FROM player_rating_events WHERE match_created_at >= ${input.cutoff})`),
    ...maintenanceRowGuards('seasons', ['id'], [source.season]),
    ...maintenanceRowGuards('player_ratings', ['player_id', 'mode'], source.ratings),
    ...maintenanceInsert('seasons', [{ id: input.seasonId, season_number: input.seasonNumber, name: input.name, starts_at: input.cutoff,
      ends_at: null, soft_reset: 1, active: 1, reporting_deadline: null, finalized_at: null, rating_system: 'rp', reset_factor: input.resetFactor,
      preserve_evidence: 1, public_reads_enabled: 0, isolated_ratings_enabled: 1 }]),
    `UPDATE seasons SET active = 0, ends_at = ${input.cutoff}, reporting_deadline = ${opening.reportingDeadline}, preserve_evidence = 1, isolated_ratings_enabled = 1 WHERE id = ${qSource}`,
    ...maintenanceInsert('public_rating_calibrations', input.calibrations.map(row => ({ version: row.version, scope: row.scope, source_digest: row.sourceDigest, calibration: JSON.stringify(row), created_at: input.cutoff }))),
    ...maintenanceInsert('season_rating_configurations', input.calibrations.map(row => ({ season_id: input.seasonId, mode: row.scope, formula_version: PUBLIC_RATING_FORMULA_VERSION, calibration_version: row.version }))),
    ...maintenanceInsert('season_rating_states', [...opening.closingStates, ...opening.openingStates].map(row => ({ season_id: row.seasonId, player_id: row.playerId, mode: row.mode,
      mu: row.mu, sigma: row.sigma, public_rating: row.publicRating, managed_tier: 'managedTier' in row ? row.managedTier : null,
      season_games: row.seasonGames, season_wins: row.seasonWins, evidence: JSON.stringify(row.evidence), last_played_at: row.lastPlayedAt, revision: row.revision, updated_at: row.updatedAt }))),
    ...maintenanceInsert('public_rating_seeds', opening.seeds.map(row => ({ season_id: row.seasonId, player_id: row.playerId, mode: row.mode, rating: row.rating,
      hidden_mu: row.hiddenMu, hidden_sigma: row.hiddenSigma, source_mu: row.sourceMu, source_sigma: row.sourceSigma, source_hidden_score: row.sourceHiddenScore,
      effective_at: row.effectiveAt, last_played_at: row.lastPlayedAt, source_season_id: row.sourceSeasonId, formula_version: row.formulaVersion,
      calibration_version: row.calibrationVersion, seed_version: row.seedVersion, closing_tier: row.closingTier, guard_reason: row.guardReason, evidence: JSON.stringify(row.evidence) }))),
    `UPDATE player_ratings SET mu = (SELECT hidden_mu FROM public_rating_seeds s WHERE s.season_id = ${qNext} AND s.player_id = player_ratings.player_id AND s.mode = player_ratings.mode), sigma = (SELECT hidden_sigma FROM public_rating_seeds s WHERE s.season_id = ${qNext} AND s.player_id = player_ratings.player_id AND s.mode = player_ratings.mode), public_rating = (SELECT rating FROM public_rating_seeds s WHERE s.season_id = ${qNext} AND s.player_id = player_ratings.player_id AND s.mode = player_ratings.mode), updated_at = ${input.cutoff}`,
    `UPDATE matches SET season_id = ${qNext} WHERE season_id = ${qSource} AND created_at >= ${input.cutoff}`,
  ]
  validateMaintenanceStatements(statements)
  const verification = [
    ...maintenanceRowGuards('public_rating_seeds', ['season_id', 'player_id', 'mode'], opening.seeds.map(seed => ({ season_id: seed.seasonId, player_id: seed.playerId, mode: seed.mode,
      rating: seed.rating, hidden_mu: seed.hiddenMu, hidden_sigma: seed.hiddenSigma, source_mu: seed.sourceMu, source_sigma: seed.sourceSigma,
      formula_version: seed.formulaVersion, calibration_version: seed.calibrationVersion, seed_version: seed.seedVersion, evidence: JSON.stringify(seed.evidence) }))),
    ...maintenanceRowGuards('season_rating_states', ['season_id', 'player_id', 'mode'], [...opening.closingStates, ...opening.openingStates].map(row => ({ season_id: row.seasonId, player_id: row.playerId, mode: row.mode,
      mu: row.mu, sigma: row.sigma, public_rating: row.publicRating, season_games: row.seasonGames, season_wins: row.seasonWins,
      evidence: JSON.stringify(row.evidence), last_played_at: row.lastPlayedAt, revision: 0 }))),
    ...maintenanceRowGuards('player_ratings', ['player_id', 'mode'], source.ratings.map(row => {
      const seed = opening.seeds.find(seed => seed.playerId === row.player_id && seed.mode === row.mode)!
      return { ...row, mu: seed.hiddenMu, sigma: seed.hiddenSigma, public_rating: seed.rating, updated_at: input.cutoff }
    })),
  ]
  validateMaintenanceStatements(verification)
  return { ...opening, statements, verification, conservativeEstimatedWrites: (source.ratings.length * 4 + input.calibrations.length * 2 + 2) * 8,
    estimateNote: 'Unvalidated conservative rating-row estimate; add eight writes per reassigned draft before apply.', publicReadsEnabled: false }
}
