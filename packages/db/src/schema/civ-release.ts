import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const civReleaseProjections = sqliteTable('civ_release_projections', {
  id: text('id').primaryKey(),
  config: text('config').notNull(),
  cursor: text('cursor').notNull().default(''),
  initialized: integer('initialized', { mode: 'boolean' }).notNull().default(false),
  revision: integer('revision').notNull().default(0),
  liveCount: integer('live_count').notNull().default(0),
  aggregates: text('aggregates').notNull().default('{}'),
})
export const civReleaseMembers = sqliteTable(
  'civ_release_members',
  {
    releaseId: text('release_id').notNull(),
    matchId: text('match_id').notNull(),
    source: text('source').notNull(),
    completedAt: integer('completed_at').notNull(),
    contribution: text('contribution').notNull(),
    selected: integer('selected', { mode: 'boolean' }).notNull(),
  },
  table => [
    primaryKey({ columns: [table.releaseId, table.matchId] }),
    index('civ_release_members_sample_idx').on(table.releaseId, table.source, table.completedAt, table.matchId),
  ],
)
export const civReleaseDirty = sqliteTable(
  'civ_release_dirty',
  {
    releaseId: text('release_id').notNull(),
    matchId: text('match_id').notNull(),
    revision: integer('revision').notNull().default(1),
  },
  table => [primaryKey({ columns: [table.releaseId, table.matchId] })],
)
