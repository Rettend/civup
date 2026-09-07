import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const ratingMaintenance = sqliteTable('rating_maintenance', {
  id: integer('id').primaryKey(),
  state: text('state', { enum: ['open', 'buffering', 'draining'] }).notNull().default('open'),
  generation: integer('generation').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
})

export const ratingMutationLeases = sqliteTable('rating_mutation_leases', {
  id: text('id').primaryKey(),
  matchId: text('match_id').notNull(),
  generation: integer('generation').notNull(),
  kind: text('kind', { enum: ['rating', 'buffer'] }).notNull(),
  createdAt: integer('created_at').notNull(),
})

/** Discovery projection; the queued result itself belongs to SessionDO. */
export const bufferedReportDirectory = sqliteTable('buffered_report_directory', {
  matchId: text('match_id').primaryKey(),
  reportId: text('report_id').notNull(),
  acceptedAt: integer('accepted_at').notNull(),
}, table => [index('buffered_report_directory_accepted_idx').on(table.acceptedAt, table.matchId)])
