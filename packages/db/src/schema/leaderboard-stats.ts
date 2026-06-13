import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { matches } from './matches.ts'
import { players } from './players.ts'

export const civStats = sqliteTable('civ_stats', {
  modeScope: text('mode_scope').notNull().default('all'),
  civId: text('civ_id').notNull(),
  picks: integer('picks', { mode: 'number' }).notNull().default(0),
  wins: integer('wins', { mode: 'number' }).notNull().default(0),
  bans: integer('bans', { mode: 'number' }).notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
}, table => [
  primaryKey({ columns: [table.modeScope, table.civId] }),
  index('civ_stats_scope_idx').on(table.modeScope, table.civId),
])

export const civStatPoolTotals = sqliteTable('civ_stat_pool_totals', {
  modeScope: text('mode_scope').notNull().default('all'),
  poolKey: text('pool_key').notNull(),
  poolCivIdsJson: text('pool_civ_ids_json').notNull(),
  completedMatchCount: integer('completed_match_count', { mode: 'number' }).notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
}, table => [
  primaryKey({ columns: [table.modeScope, table.poolKey] }),
])

export const civStatTotals = sqliteTable('civ_stat_totals', {
  scope: text('scope').primaryKey(),
  completedMatchCount: integer('completed_match_count', { mode: 'number' }).notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
})

export const matchCivStatContributions = sqliteTable('match_civ_stat_contributions', {
  matchId: text('match_id')
    .primaryKey()
    .references(() => matches.id, { onDelete: 'cascade' }),
  completedMatchCount: integer('completed_match_count', { mode: 'number' }).notNull().default(0),
  contributionsJson: text('contributions_json').notNull(),
  source: text('source').notNull().default('live'),
  modeScope: text('mode_scope').notNull().default('all'),
  completedAt: integer('completed_at', { mode: 'number' }).notNull().default(0),
  visible: integer('visible', { mode: 'boolean' }).notNull().default(true),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
}, table => [
  index('match_civ_stat_contributions_visible_idx').on(table.visible, table.source, table.completedAt, table.modeScope),
])

export const playerCivStats = sqliteTable('player_civ_stats', {
  seasonId: text('season_id').notNull().default(''),
  gameMode: text('game_mode').notNull(),
  playerId: text('player_id').notNull().references(() => players.id),
  civId: text('civ_id').notNull(),
  picks: integer('picks', { mode: 'number' }).notNull().default(0),
  wins: integer('wins', { mode: 'number' }).notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
}, table => [
  primaryKey({ columns: [table.seasonId, table.gameMode, table.playerId, table.civId] }),
  index('player_civ_stats_player_context_idx').on(table.playerId, table.seasonId, table.gameMode, table.civId),
  index('player_civ_stats_civ_context_idx').on(table.civId, table.seasonId, table.gameMode, table.playerId),
])

export const matchPlayerCivStatContributions = sqliteTable('match_player_civ_stat_contributions', {
  matchId: text('match_id')
    .primaryKey()
    .references(() => matches.id, { onDelete: 'cascade' }),
  contributionsJson: text('contributions_json').notNull(),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
})
