import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const matchMessageMappings = sqliteTable('match_message_mappings', {
  messageId: text('message_id').primaryKey(),
  matchId: text('match_id').notNull(),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'number' }).notNull(),
})

export const leaderboardMessageStates = sqliteTable('leaderboard_message_states', {
  scope: text('scope').primaryKey(),
  channelId: text('channel_id').notNull(),
  messageId: text('message_id').notNull(),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
})

export const leaderboardDirtyStates = sqliteTable('leaderboard_dirty_states', {
  scope: text('scope').primaryKey(),
  dirtyAt: integer('dirty_at', { mode: 'number' }).notNull(),
  reason: text('reason'),
})
