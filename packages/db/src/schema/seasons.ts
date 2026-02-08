import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const seasons = sqliteTable('seasons', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Unix timestamp ms */
  startsAt: integer('starts_at', { mode: 'number' }).notNull(),
  /** Unix timestamp ms (null = ongoing) */
  endsAt: integer('ends_at', { mode: 'number' }),
  /** Whether this is the active season */
  active: integer('active', { mode: 'boolean' }).notNull().default(false),
})
