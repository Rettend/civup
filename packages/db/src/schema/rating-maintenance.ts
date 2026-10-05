import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const ratingMaintenance = sqliteTable('rating_maintenance', {
  id: integer('id').primaryKey(),
  state: text('state', { enum: ['open', 'paused'] })
    .notNull()
    .default('open'),
  generation: integer('generation').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
})

export const ratingMutationLeases = sqliteTable('rating_mutation_leases', {
  id: text('id').primaryKey(),
  matchId: text('match_id').notNull(),
  generation: integer('generation').notNull(),
  createdAt: integer('created_at').notNull(),
})
