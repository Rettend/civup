import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { matches } from './matches.ts'
import { players } from './players.ts'
import { seasons } from './seasons.ts'

export const scopedPlayerRatings = sqliteTable('scoped_player_ratings', {
  statsKey: text('stats_key').notNull(),
  playerId: text('player_id').notNull().references(() => players.id),
  mode: text('mode').notNull(),
  mu: real('mu').notNull().default(25),
  sigma: real('sigma').notNull().default(8.333),
  publicRating: real('public_rating'),
  gamesPlayed: integer('games_played').notNull().default(0),
  wins: integer('wins').notNull().default(0),
  importedGames: integer('imported_games').notNull().default(0),
  effectiveGames: real('effective_games').notNull().default(0),
  winsVsTier1: integer('wins_vs_tier_1').notNull().default(0),
  winsVsTier2Plus: integer('wins_vs_tier_2_plus').notNull().default(0),
  effectiveWinsVsTier1: real('effective_wins_vs_tier_1').notNull().default(0),
  effectiveWinsVsTier2Plus: real('effective_wins_vs_tier_2_plus').notNull().default(0),
  lastPlayedAt: integer('last_played_at', { mode: 'number' }),
  updatedAt: integer('updated_at', { mode: 'number' }),
}, table => [
  primaryKey({ columns: [table.statsKey, table.playerId, table.mode] }),
  index('scoped_player_ratings_stats_mode_idx').on(table.statsKey, table.mode),
])

export const scopedPlayerRatingEvents = sqliteTable('scoped_player_rating_events', {
  statsKey: text('stats_key').notNull(),
  matchId: text('match_id').notNull().references(() => matches.id),
  playerId: text('player_id').notNull().references(() => players.id),
  mode: text('mode').notNull(),
  gameMode: text('game_mode').notNull(),
  ratingBeforeMu: real('rating_before_mu').notNull(),
  ratingBeforeSigma: real('rating_before_sigma').notNull(),
  ratingAfterMu: real('rating_after_mu').notNull(),
  ratingAfterSigma: real('rating_after_sigma').notNull(),
  publicRatingBefore: real('public_rating_before'),
  publicRatingAfter: real('public_rating_after'),
  gamesDelta: integer('games_delta').notNull().default(1),
  winsDelta: integer('wins_delta').notNull().default(0),
  importedGamesDelta: integer('imported_games_delta').notNull().default(0),
  effectiveGamesDelta: real('effective_games_delta').notNull().default(1),
  winsVsTier1Delta: integer('wins_vs_tier_1_delta').notNull().default(0),
  winsVsTier2PlusDelta: integer('wins_vs_tier_2_plus_delta').notNull().default(0),
  effectiveWinsVsTier1Delta: real('effective_wins_vs_tier_1_delta').notNull().default(0),
  effectiveWinsVsTier2PlusDelta: real('effective_wins_vs_tier_2_plus_delta').notNull().default(0),
  matchCreatedAt: integer('match_created_at', { mode: 'number' }).notNull(),
  matchCompletedAt: integer('match_completed_at', { mode: 'number' }),
  updatedAt: integer('updated_at', { mode: 'number' }),
}, table => [
  primaryKey({ columns: [table.statsKey, table.matchId, table.playerId, table.mode] }),
  index('scoped_rating_events_player_scope_idx').on(table.statsKey, table.playerId, table.mode, table.matchCreatedAt),
  index('scoped_rating_events_match_idx').on(table.statsKey, table.matchId),
])

export const scopedCivStats = sqliteTable('scoped_civ_stats', {
  statsKey: text('stats_key').notNull(),
  modeScope: text('mode_scope').notNull().default('all'),
  civId: text('civ_id').notNull(),
  picks: integer('picks', { mode: 'number' }).notNull().default(0),
  wins: integer('wins', { mode: 'number' }).notNull().default(0),
  bans: integer('bans', { mode: 'number' }).notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
}, table => [
  primaryKey({ columns: [table.statsKey, table.modeScope, table.civId] }),
  index('scoped_civ_stats_scope_idx').on(table.statsKey, table.modeScope, table.civId),
])

export const scopedCivStatPoolTotals = sqliteTable('scoped_civ_stat_pool_totals', {
  statsKey: text('stats_key').notNull(),
  modeScope: text('mode_scope').notNull().default('all'),
  poolKey: text('pool_key').notNull(),
  poolCivIdsJson: text('pool_civ_ids_json').notNull(),
  completedMatchCount: integer('completed_match_count', { mode: 'number' }).notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
}, table => [primaryKey({ columns: [table.statsKey, table.modeScope, table.poolKey] })])

export const scopedCivStatTotals = sqliteTable('scoped_civ_stat_totals', {
  statsKey: text('stats_key').notNull(),
  scope: text('scope').notNull(),
  completedMatchCount: integer('completed_match_count', { mode: 'number' }).notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
}, table => [primaryKey({ columns: [table.statsKey, table.scope] })])

export const scopedMatchCivStatContributions = sqliteTable('scoped_match_civ_stat_contributions', {
  statsKey: text('stats_key').notNull(),
  matchId: text('match_id').notNull().references(() => matches.id, { onDelete: 'cascade' }),
  completedMatchCount: integer('completed_match_count', { mode: 'number' }).notNull().default(0),
  contributionsJson: text('contributions_json').notNull(),
  source: text('source').notNull().default('live'),
  modeScope: text('mode_scope').notNull().default('all'),
  completedAt: integer('completed_at', { mode: 'number' }).notNull().default(0),
  visible: integer('visible', { mode: 'boolean' }).notNull().default(true),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
}, table => [
  primaryKey({ columns: [table.statsKey, table.matchId] }),
  index('scoped_match_civ_visible_idx').on(table.statsKey, table.visible, table.source, table.completedAt, table.modeScope),
])

export const scopedPlayerCivStats = sqliteTable('scoped_player_civ_stats', {
  statsKey: text('stats_key').notNull(),
  seasonId: text('season_id').notNull().default(''),
  gameMode: text('game_mode').notNull(),
  playerId: text('player_id').notNull().references(() => players.id),
  civId: text('civ_id').notNull(),
  picks: integer('picks', { mode: 'number' }).notNull().default(0),
  wins: integer('wins', { mode: 'number' }).notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
}, table => [
  primaryKey({ columns: [table.statsKey, table.seasonId, table.gameMode, table.playerId, table.civId] }),
  index('scoped_player_civ_player_idx').on(table.statsKey, table.playerId, table.seasonId, table.gameMode, table.civId),
  index('scoped_player_civ_civ_idx').on(table.statsKey, table.civId, table.seasonId, table.gameMode, table.playerId),
])

export const scopedMatchPlayerCivStatContributions = sqliteTable('scoped_match_player_civ_stat_contributions', {
  statsKey: text('stats_key').notNull(),
  matchId: text('match_id').notNull().references(() => matches.id, { onDelete: 'cascade' }),
  contributionsJson: text('contributions_json').notNull(),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
}, table => [primaryKey({ columns: [table.statsKey, table.matchId] })])

export const scopedSeasonPeakRanks = sqliteTable('scoped_season_peak_ranks', {
  statsKey: text('stats_key').notNull(),
  seasonId: text('season_id').notNull().references(() => seasons.id),
  playerId: text('player_id').notNull().references(() => players.id),
  tier: text('tier').notNull(),
  sourceMode: text('source_mode'),
  achievedAt: integer('achieved_at', { mode: 'number' }).notNull(),
}, table => [primaryKey({ columns: [table.statsKey, table.seasonId, table.playerId] })])

export const scopedSeasonPeakModeRanks = sqliteTable('scoped_season_peak_mode_ranks', {
  statsKey: text('stats_key').notNull(),
  seasonId: text('season_id').notNull().references(() => seasons.id),
  playerId: text('player_id').notNull().references(() => players.id),
  mode: text('mode').notNull(),
  tier: text('tier'),
  rating: integer('rating').notNull(),
  achievedAt: integer('achieved_at', { mode: 'number' }).notNull(),
}, table => [primaryKey({ columns: [table.statsKey, table.seasonId, table.playerId, table.mode] })])
