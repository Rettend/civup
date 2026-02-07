import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { players } from './players.ts'

/**
 * Per-mode ratings for each player.
 * Leaderboard modes: ffa, duel, teamers (2v2 + 3v3 combined).
 */
export const playerRatings = sqliteTable('player_ratings', {
  playerId: text('player_id').notNull().references(() => players.id),
  /** Leaderboard mode: 'ffa' | 'duel' | 'teamers' */
  mode: text('mode').notNull(),
  /** OpenSkill mu (mean skill estimate, default 25.0) */
  mu: real('mu').notNull().default(25.0),
  /** OpenSkill sigma (uncertainty, default 8.333) */
  sigma: real('sigma').notNull().default(8.333),
  /** Total games played in this mode */
  gamesPlayed: integer('games_played').notNull().default(0),
  /** Total wins */
  wins: integer('wins').notNull().default(0),
  /** Unix timestamp ms of last game */
  lastPlayedAt: integer('last_played_at', { mode: 'number' }),
}, table => [
  primaryKey({ columns: [table.playerId, table.mode] }),
])
