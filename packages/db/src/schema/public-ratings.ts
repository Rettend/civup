import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { players } from './players.ts'
import { seasons } from './seasons.ts'
import { matches } from './matches.ts'

export const publicRatingCalibrations = sqliteTable('public_rating_calibrations', {
  version: text('version').primaryKey(),
  scope: text('scope').notNull(),
  sourceDigest: text('source_digest').notNull(),
  calibration: text('calibration', { mode: 'json' }).$type<{
    version: string
    scope: string
    sourceDigest: string
    population: number
    anchors: readonly { hiddenScore: number, target: number }[]
  }>().notNull(),
  createdAt: integer('created_at').notNull(),
})

export const publicRatingSeeds = sqliteTable('public_rating_seeds', {
  seasonId: text('season_id').notNull().references(() => seasons.id),
  playerId: text('player_id').notNull().references(() => players.id),
  mode: text('mode').notNull(),
  rating: real('rating').notNull(),
  hiddenMu: real('hidden_mu').notNull(),
  hiddenSigma: real('hidden_sigma').notNull(),
  sourceMu: real('source_mu').notNull(),
  sourceSigma: real('source_sigma').notNull(),
  sourceHiddenScore: real('source_hidden_score').notNull(),
  effectiveAt: integer('effective_at').notNull(),
  lastPlayedAt: integer('last_played_at'),
  sourceSeasonId: text('source_season_id').references(() => seasons.id),
  formulaVersion: text('formula_version').notNull(),
  calibrationVersion: text('calibration_version').notNull().references(() => publicRatingCalibrations.version),
  seedVersion: text('seed_version').notNull(),
  closingTier: text('closing_tier'),
  guardReason: text('guard_reason'),
  evidence: text('evidence', { mode: 'json' }).$type<Record<string, number>>().notNull(),
}, table => [primaryKey({ columns: [table.seasonId, table.playerId, table.mode] })])

export const seasonRatingStates = sqliteTable('season_rating_states', {
  seasonId: text('season_id').notNull().references(() => seasons.id),
  playerId: text('player_id').notNull().references(() => players.id),
  mode: text('mode').notNull(),
  mu: real('mu').notNull(),
  sigma: real('sigma').notNull(),
  publicRating: real('public_rating'),
  managedTier: text('managed_tier'),
  seasonGames: integer('season_games').notNull().default(0),
  seasonWins: integer('season_wins').notNull().default(0),
  evidence: text('evidence', { mode: 'json' }).$type<Record<string, number>>().notNull(),
  lastPlayedAt: integer('last_played_at'),
  revision: integer('revision').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
}, table => [
  primaryKey({ columns: [table.seasonId, table.playerId, table.mode] }),
  index('season_rating_states_mode_idx').on(table.seasonId, table.mode),
])

export const seasonMatchReports = sqliteTable('season_match_reports', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }),
  matchId: text('match_id').notNull().references(() => matches.id),
  seasonId: text('season_id').notNull().references(() => seasons.id),
  acceptedAt: integer('accepted_at').notNull(),
  opponentTiers: text('opponent_tiers', { mode: 'json' }).$type<Record<string, string>>().notNull().default({}),
  cancelledAt: integer('cancelled_at'),
}, table => [
  uniqueIndex('season_match_reports_match_idx').on(table.matchId),
  index('season_match_reports_season_idx').on(table.seasonId, table.sequence),
])

export const seasonRatingConfigurations = sqliteTable('season_rating_configurations', {
  seasonId: text('season_id').notNull().references(() => seasons.id),
  mode: text('mode').notNull(),
  formulaVersion: text('formula_version').notNull(),
  calibrationVersion: text('calibration_version').notNull().references(() => publicRatingCalibrations.version),
}, table => [primaryKey({ columns: [table.seasonId, table.mode] })])
