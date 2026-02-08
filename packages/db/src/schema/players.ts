import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const players = sqliteTable('players', {
  /** Discord snowflake ID */
  id: text('id').primaryKey(),
  /** Discord display name */
  displayName: text('display_name').notNull(),
  /** Discord avatar URL */
  avatarUrl: text('avatar_url'),
  /** Unix timestamp ms */
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
})
