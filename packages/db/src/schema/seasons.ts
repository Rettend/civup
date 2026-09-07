import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { players } from './players.ts'

export const seasons = sqliteTable('seasons', {
  id: text('id').primaryKey(),
  seasonNumber: integer('season_number').notNull(),
  name: text('name').notNull(),
  /** Unix timestamp ms */
  startsAt: integer('starts_at', { mode: 'number' }).notNull(),
  /** Unix timestamp ms (null = ongoing) */
  endsAt: integer('ends_at', { mode: 'number' }),
  /** Whether starting this season applied a soft reset */
  softReset: integer('soft_reset', { mode: 'boolean' }).notNull().default(true),
  /** Whether this is the active season */
  active: integer('active', { mode: 'boolean' }).notNull().default(false),
  reportingDeadline: integer('reporting_deadline'),
  finalizedAt: integer('finalized_at'),
  ratingSystem: text('rating_system', { enum: ['legacy', 'rp'] }).notNull().default('legacy'),
  resetFactor: real('reset_factor').notNull().default(0.5),
  preserveEvidence: integer('preserve_evidence', { mode: 'boolean' }).notNull().default(false),
  publicReadsEnabled: integer('public_reads_enabled', { mode: 'boolean' }).notNull().default(false),
})

export const seasonPeakRanks = sqliteTable('season_peak_ranks', {
  seasonId: text('season_id').notNull().references(() => seasons.id),
  playerId: text('player_id').notNull().references(() => players.id),
  tier: text('tier').notNull(),
  sourceMode: text('source_mode'),
  achievedAt: integer('achieved_at', { mode: 'number' }).notNull(),
}, table => [
  primaryKey({ columns: [table.seasonId, table.playerId] }),
])

export const seasonPeakModeRanks = sqliteTable('season_peak_mode_ranks', {
  seasonId: text('season_id').notNull().references(() => seasons.id),
  playerId: text('player_id').notNull().references(() => players.id),
  mode: text('mode').notNull(),
  tier: text('tier'),
  rating: integer('rating').notNull(),
  achievedAt: integer('achieved_at', { mode: 'number' }).notNull(),
}, table => [
  primaryKey({ columns: [table.seasonId, table.playerId, table.mode] }),
])
