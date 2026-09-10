import type { RankedRoleConfig } from '../ranked/roles.ts'
import type { CutoverSource, MaintenanceRow } from './cutover.ts'
import { displayRating, getLeaderboardMinGames } from '@civup/rating'
import { buildGlobalLadderSnapshots, buildLadderSnapshots } from '../ranked/role-sync.ts'
import { seasonStandingsWriteStatement } from './standings.ts'
import { CUTOVER_EVIDENCE, CUTOVER_SCOPES, maintenanceGuard, maintenanceInsert, maintenanceQuote, maintenanceRowGuards, pausedMaintenanceGuard, validateMaintenanceStatements } from './cutover.ts'

export function savedSeasonPeakRows(ratings: MaintenanceRow[], config: RankedRoleConfig, seasonId: string, at: number, playerIds?: Set<string>) {
  const globalRows = ratings.filter(row => row.mode === 'global').map(row => ({ playerId: String(row.player_id), mu: Number(row.mu), sigma: Number(row.sigma),
    ...Object.fromEntries(Object.entries(CUTOVER_EVIDENCE).map(([key, column]) => [key, Number(row[column])])), lastPlayedAt: row.last_played_at as number | null }))
  const global = buildGlobalLadderSnapshots(globalRows as Parameters<typeof buildGlobalLadderSnapshots>[0], config)
  const peaks: MaintenanceRow[] = [...global.earn.values()].filter(row => !playerIds || playerIds.has(row.playerId)).map(row => ({ season_id: seasonId, player_id: row.playerId, tier: row.tier, source_mode: null, achieved_at: at }))
  const modes: MaintenanceRow[] = []
  for (const mode of CUTOVER_SCOPES.filter(mode => mode !== 'global')) {
    const rows = ratings.filter(row => row.mode === mode).map(row => ({ playerId: String(row.player_id), mode, mu: Number(row.mu), sigma: Number(row.sigma), gamesPlayed: Number(row.games_played), lastPlayedAt: row.last_played_at as number | null }))
    const ladder = buildLadderSnapshots(rows, mode, config, getLeaderboardMinGames(mode))
    for (const row of rows) {
      if (playerIds && !playerIds.has(row.playerId)) continue
      modes.push({ season_id: seasonId, player_id: row.playerId, mode, tier: ladder.earn.get(row.playerId)?.tier ?? null, rating: Math.round(displayRating(row.mu, row.sigma)), achieved_at: at })
    }
  }
  return { peaks, modes }
}

export function peakWriteStatements(peaks: MaintenanceRow[], modes: MaintenanceRow[]): string[] {
  return [
    ...maintenanceInsert('season_peak_ranks', peaks, 'ON CONFLICT(season_id, player_id) DO UPDATE SET tier = excluded.tier, source_mode = excluded.source_mode, achieved_at = excluded.achieved_at WHERE CAST(substr(excluded.tier, 5) AS INTEGER) < CAST(substr(season_peak_ranks.tier, 5) AS INTEGER)'),
    ...maintenanceInsert('season_peak_mode_ranks', modes, 'ON CONFLICT(season_id, player_id, mode) DO UPDATE SET tier = excluded.tier, rating = excluded.rating, achieved_at = excluded.achieved_at WHERE COALESCE(CAST(substr(excluded.tier, 5) AS INTEGER), 9999) < COALESCE(CAST(substr(season_peak_mode_ranks.tier, 5) AS INTEGER), 9999) OR (excluded.tier IS season_peak_mode_ranks.tier AND excluded.rating > season_peak_mode_ranks.rating)'),
  ]
}

export function prepareSeasonFinalization(input: {
  source: CutoverSource, config: RankedRoleConfig, generation: number, season: MaintenanceRow,
  states: MaintenanceRow[], reports: MaintenanceRow[], events: MaintenanceRow[], now: number,
}) {
  const { season, now } = input
  const seasonId = String(season.id)
  if (season.id !== input.source.season.id || season.active !== 0 || season.rating_system !== 'legacy' || season.isolated_ratings_enabled !== 1
    || season.finalized_at != null || typeof season.reporting_deadline !== 'number' || now < season.reporting_deadline) throw new Error('Wait for the closed legacy season reporting deadline before finalization.')
  const ratings = new Map(input.source.ratings.map(row => [`${row.player_id}:${row.mode}`, { ...row }]))
  const peaks = savedSeasonPeakRows([...ratings.values()], input.config, seasonId, Number(season.ends_at))
  const writes = peakWriteStatements(peaks.peaks, peaks.modes)
  const evidenceDeltas = Object.entries(CUTOVER_EVIDENCE).map(([, column]) => [column, column === 'games_played' ? 'games_delta' : `${column}_delta`] as const)
  const usedEvents = new Set<MaintenanceRow>()
  for (const report of [...input.reports].sort((a, b) => Number(a.sequence) - Number(b.sequence))) {
    if (report.season_id !== seasonId || report.cancelled_at != null || Number(report.accepted_at) > season.reporting_deadline) throw new Error('Unexpected late report identity, cancellation, or deadline.')
    const events = input.events.filter(event => event.match_id === report.match_id)
    if (events.length < 4 || events.length % 2 !== 0) throw new Error('Incomplete late-report rating scopes.')
    const players = new Set(events.map(event => String(event.player_id)))
    if (events.length !== players.size * 2 || [...players].some(id => events.filter(event => event.player_id === id && event.mode === 'global').length !== 1)) throw new Error('Incomplete late-report player chains.')
    for (const event of events) {
      if (event.season_id !== seasonId || usedEvents.has(event)) throw new Error('Unexpected late rating event.')
      usedEvents.add(event)
      const key = `${event.player_id}:${event.mode}`
      let row = ratings.get(key)
      if (!row) {
        row = { player_id: event.player_id!, mode: event.mode!, mu: 25, sigma: 25 / 3, last_played_at: null, ...Object.fromEntries(Object.values(CUTOVER_EVIDENCE).map(column => [column, 0])) }
        ratings.set(key, row)
      }
      if (row.mu !== event.rating_before_mu || row.sigma !== event.rating_before_sigma) throw new Error('Late history does not connect to the frozen closing source.')
      row.mu = event.rating_after_mu!
      row.sigma = event.rating_after_sigma!
      for (const [column, delta] of evidenceDeltas) row[column] = Number(row[column]) + Number(event[delta])
      if (!event.imported_games_delta) row.last_played_at = Math.max(Number(row.last_played_at ?? 0), Number(report.accepted_at))
    }
    const earned = savedSeasonPeakRows([...ratings.values()], input.config, seasonId, Number(report.accepted_at), players)
    writes.push(...peakWriteStatements(earned.peaks, earned.modes))
  }
  if (usedEvents.size !== input.events.length || ratings.size !== input.states.length) throw new Error('Late event/state coverage disagrees.')
  for (const state of input.states) {
    const row = ratings.get(`${state.player_id}:${state.mode}`)
    const evidence = JSON.parse(String(state.evidence)) as Record<string, number>
    if (!row || row.mu !== state.mu || row.sigma !== state.sigma || row.last_played_at !== state.last_played_at
      || Object.entries(CUTOVER_EVIDENCE).some(([key, column]) => row[column] !== evidence[key])) throw new Error('Late replay disagrees with saved season ratings or evidence.')
  }
  const qSeason = maintenanceQuote(seasonId)
  const savedStandingsGuard = maintenanceGuard(`EXISTS(SELECT 1 FROM season_standing_snapshots saved JOIN seasons s ON s.id = saved.season_id WHERE saved.season_id = ${qSeason} AND saved.revision = s.standings_revision AND saved.finalized_at = ${now})`)
  const { standings_revision: _revision, ...finalSeason } = season
  const statements = [pausedMaintenanceGuard(input.generation), ...maintenanceRowGuards('seasons', ['id'], [season]),
    maintenanceGuard(`(SELECT count(*) FROM season_rating_states WHERE season_id = ${qSeason}) = ${input.states.length} AND (SELECT count(*) FROM season_match_reports WHERE season_id = ${qSeason}) = ${input.reports.length}`),
    ...maintenanceRowGuards('season_rating_states', ['season_id', 'player_id', 'mode'], input.states),
    ...maintenanceRowGuards('season_match_reports', ['match_id'], input.reports),
    ...maintenanceRowGuards('player_rating_events', ['match_id', 'player_id', 'mode'], input.events),
    ...writes, `UPDATE seasons SET finalized_at = ${now} WHERE id = ${qSeason}`, seasonStandingsWriteStatement(seasonId), savedStandingsGuard,
  ]
  validateMaintenanceStatements(statements)
  const verification = [
    ...maintenanceRowGuards('seasons', ['id'], [{ ...finalSeason, finalized_at: now }]),
    savedStandingsGuard,
    ...maintenanceRowGuards('season_rating_states', ['season_id', 'player_id', 'mode'], input.states),
  ]
  validateMaintenanceStatements(verification)
  return { statements, verification, conservativeEstimatedWrites: (peaks.peaks.length + peaks.modes.length + input.events.length * 2 + 2) * 16, productionEstimateValidated: false }
}
