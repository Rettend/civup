import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { players } from './players.ts'
import { seasons } from './seasons.ts'

/**
 * A match (draft + game).
 */
export const matches = sqliteTable('matches', {
  /** ULID or nanoid */
  id: text('id').primaryKey(),
  /** Game mode: ffa, 1v1, 2v2, 3v3, 4v4, 5v5, 6v6 */
  gameMode: text('game_mode').notNull(),
  /** drafting | active | completed | cancelled */
  status: text('status').notNull().default('drafting'),
  /** Imported legacy match from the old bot export. */
  isOld: integer('is_old', { mode: 'boolean' }).notNull().default(false),
  /** Reference to the season */
  seasonId: text('season_id').references(() => seasons.id),
  /** Full draft log as JSON (bans, picks, order, format used) */
  draftData: text('draft_data'),
  /** Unix timestamp ms */
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
  /** Unix timestamp ms */
  completedAt: integer('completed_at', { mode: 'number' }),
}, table => [
  index('matches_status_created_at_idx').on(table.status, table.createdAt),
  index('matches_status_completed_at_idx').on(table.status, table.completedAt),
])

/**
 * A player's participation in a match.
 */
export const matchParticipants = sqliteTable('match_participants', {
  /** Composite primary key would be (matchId, playerId) */
  matchId: text('match_id').notNull().references(() => matches.id),
  playerId: text('player_id').notNull().references(() => players.id),
  /** Team index (null for FFA) */
  team: integer('team'),
  /** Leader/civ picked during draft */
  civId: text('civ_id'),
  /** Final placement (1 = winner). Filled on result report. */
  placement: integer('placement'),
  /** Rating snapshot before the match */
  ratingBeforeMu: real('rating_before_mu'),
  ratingBeforeSigma: real('rating_before_sigma'),
  /** Rating snapshot after the match */
  ratingAfterMu: real('rating_after_mu'),
  ratingAfterSigma: real('rating_after_sigma'),
}, table => [
  index('match_participants_match_player_idx').on(table.matchId, table.playerId),
  index('match_participants_player_id_idx').on(table.playerId),
])

/**
 * A civ that was banned during a match draft.
 */
export const matchBans = sqliteTable('match_bans', {
  matchId: text('match_id').notNull().references(() => matches.id),
  civId: text('civ_id').notNull(),
  bannedBy: text('banned_by').notNull().references(() => players.id),
  /** Which ban phase (step index in draft) */
  phase: integer('phase').notNull(),
}, table => [
  index('match_bans_match_id_idx').on(table.matchId),
])
