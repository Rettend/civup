import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { matches } from './matches.ts'
import { players } from './players.ts'

/**
 * Per-mode ratings for each player.
 * Leaderboard modes: duel, duo, squad, ffa.
 */
export const playerRatings = sqliteTable('player_ratings', {
  playerId: text('player_id').notNull().references(() => players.id),
  /** Leaderboard mode: 'duel' | 'duo' | 'squad' | 'ffa' */
  mode: text('mode').notNull(),
  /** OpenSkill mu (mean skill estimate, default 25.0) */
  mu: real('mu').notNull().default(25.0),
  /** OpenSkill sigma (uncertainty, default 8.333) */
  sigma: real('sigma').notNull().default(8.333),
  /** Total games played in this mode */
  gamesPlayed: integer('games_played').notNull().default(0),
  /** Total wins */
  wins: integer('wins').notNull().default(0),
  /** Imported legacy games included in this rating scope */
  importedGames: integer('imported_games').notNull().default(0),
  /** Qualification evidence after source weighting */
  effectiveGames: real('effective_games').notNull().default(0),
  /** Wins over managed Elite-ranked opponents */
  winsVsElite: integer('wins_vs_elite').notNull().default(0),
  /** Wins over managed Legion-or-better opponents */
  winsVsLegionPlus: integer('wins_vs_legion_plus').notNull().default(0),
  /** Unix timestamp ms of last game */
  lastPlayedAt: integer('last_played_at', { mode: 'number' }),
  /** Unix timestamp ms of last summary update */
  updatedAt: integer('updated_at', { mode: 'number' }),
}, table => [
  primaryKey({ columns: [table.playerId, table.mode] }),
  index('player_ratings_mode_idx').on(table.mode),
])

/** Match-by-match rating changes for each player and rating scope. */
export const playerRatingEvents = sqliteTable('player_rating_events', {
  matchId: text('match_id').notNull().references(() => matches.id),
  playerId: text('player_id').notNull().references(() => players.id),
  /** Rating scope: 'global' or a leaderboard mode. */
  mode: text('mode').notNull(),
  /** Stored match mode for audit/export without requiring a join. */
  gameMode: text('game_mode').notNull(),
  ratingBeforeMu: real('rating_before_mu').notNull(),
  ratingBeforeSigma: real('rating_before_sigma').notNull(),
  ratingAfterMu: real('rating_after_mu').notNull(),
  ratingAfterSigma: real('rating_after_sigma').notNull(),
  gamesDelta: integer('games_delta').notNull().default(1),
  winsDelta: integer('wins_delta').notNull().default(0),
  importedGamesDelta: integer('imported_games_delta').notNull().default(0),
  effectiveGamesDelta: real('effective_games_delta').notNull().default(1),
  winsVsEliteDelta: integer('wins_vs_elite_delta').notNull().default(0),
  winsVsLegionPlusDelta: integer('wins_vs_legion_plus_delta').notNull().default(0),
  matchCreatedAt: integer('match_created_at').notNull(),
  matchCompletedAt: integer('match_completed_at', { mode: 'number' }),
  updatedAt: integer('updated_at', { mode: 'number' }),
}, table => [
  primaryKey({ columns: [table.matchId, table.playerId, table.mode] }),
  index('player_rating_events_player_scope_idx').on(table.playerId, table.mode, table.matchCreatedAt),
  index('player_rating_events_match_idx').on(table.matchId),
])
