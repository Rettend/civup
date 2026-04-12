import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { players } from './players.ts'

/**
 * Persistent seeded rating baselines that survive full recalculation.
 */
export const playerRatingSeeds = sqliteTable('player_rating_seeds', {
  playerId: text('player_id').notNull().references(() => players.id),
  /** Leaderboard mode: 'duel' | 'duo' | 'squad' | 'ffa' | 'red-death' */
  mode: text('mode').notNull(),
  /** Seeded OpenSkill mu */
  mu: real('mu').notNull(),
  /** Seeded OpenSkill sigma */
  sigma: real('sigma').notNull(),
  /** Allow ranked-role eligibility below the normal minimum games threshold. */
  eligibleForRanked: integer('eligible_for_ranked', { mode: 'boolean' }).notNull().default(false),
  /** Remaining new-bot games until this seed fully fades away. Null preserves the old permanent-seed behavior. */
  fadeGamesRemaining: integer('fade_games_remaining', { mode: 'number' }),
  /** Human-readable source */
  source: text('source'),
  /** Optional operator note kept with the seed. */
  note: text('note'),
  /** Unix timestamp ms */
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
  /** Unix timestamp ms */
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
}, table => [
  primaryKey({ columns: [table.playerId, table.mode] }),
  index('player_rating_seeds_mode_idx').on(table.mode),
])
