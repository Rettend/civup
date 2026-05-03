import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { matches } from './matches.ts'

export const civStats = sqliteTable('civ_stats', {
  civId: text('civ_id').primaryKey(),
  picks: integer('picks', { mode: 'number' }).notNull().default(0),
  wins: integer('wins', { mode: 'number' }).notNull().default(0),
  bans: integer('bans', { mode: 'number' }).notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
})

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
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
})
