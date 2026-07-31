import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const matchMessageMappings = sqliteTable('match_message_mappings', {
  messageId: text('message_id').primaryKey(),
  matchId: text('match_id').notNull(),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'number' }).notNull(),
}, table => [
  index('match_message_mappings_match_created_idx').on(table.matchId, table.createdAt, table.messageId),
])

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

export const sessionDirectory = sqliteTable('session_directory', {
  sessionId: text('session_id').primaryKey(),
  phase: text('phase').notNull(),
  mode: text('mode').notNull(),
  guildId: text('guild_id'),
  channelId: text('channel_id').notNull(),
  hostId: text('host_id').notNull(),
  messageId: text('message_id').notNull(),
  matchId: text('match_id'),
  steamLobbyLink: text('steam_lobby_link'),
  version: integer('version', { mode: 'number' }).notNull(),
  rosterJson: text('roster_json').notNull(),
  configJson: text('config_json').notNull(),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
  lastActivityAt: integer('last_activity_at', { mode: 'number' }).notNull(),
  closedAt: integer('closed_at', { mode: 'number' }),
  /** Deadline for a retrying draft-start match creation projection. */
  draftStartDeadlineAt: integer('draft_start_deadline_at', { mode: 'number' }),
}, table => [
  index('session_directory_phase_updated_at_idx').on(table.phase, table.updatedAt),
  index('session_directory_channel_updated_at_idx').on(table.channelId, table.updatedAt),
  index('session_directory_channel_phase_updated_at_idx').on(table.channelId, table.phase, table.updatedAt),
  index('session_directory_mode_updated_at_idx').on(table.mode, table.updatedAt),
  index('session_directory_mode_phase_created_at_idx').on(table.mode, table.phase, table.createdAt),
  index('session_directory_host_id_idx').on(table.hostId),
  index('session_directory_host_phase_created_at_idx').on(table.hostId, table.phase, table.createdAt),
  index('session_directory_match_id_idx').on(table.matchId),
  index('session_directory_phase_draft_start_deadline_idx').on(table.phase, table.draftStartDeadlineAt),
])

export const matchRepairs = sqliteTable('match_repairs', {
  id: text('id').primaryKey(),
  idempotencyKey: text('idempotency_key').notNull(),
  sessionId: text('session_id'),
  matchId: text('match_id'),
  resultRevision: integer('result_revision', { mode: 'number' }).notNull().default(0),
  repairType: text('repair_type').notNull(),
  status: text('status').notNull().default('pending'),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: integer('lease_expires_at', { mode: 'number' }),
  attempts: integer('attempts', { mode: 'number' }).notNull().default(0),
  nextAttemptAt: integer('next_attempt_at', { mode: 'number' }).notNull().default(0),
  lastError: text('last_error'),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
}, table => [
  uniqueIndex('match_repairs_idempotency_key_idx').on(table.idempotencyKey),
  index('match_repairs_due_idx').on(table.status, table.nextAttemptAt, table.createdAt),
  index('match_repairs_match_revision_idx').on(table.matchId, table.resultRevision),
])

export const sessionDirectoryMembers = sqliteTable('session_directory_members', {
  sessionId: text('session_id')
    .notNull()
    .references(() => sessionDirectory.sessionId, { onDelete: 'cascade' }),
  playerId: text('player_id').notNull(),
  role: text('role').notNull().default('participant'),
  joinedAt: integer('joined_at', { mode: 'number' }).notNull(),
  leftAt: integer('left_at', { mode: 'number' }),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
}, table => [
  primaryKey({ columns: [table.sessionId, table.playerId] }),
  uniqueIndex('session_directory_members_live_player_idx')
    .on(table.playerId)
    .where(sql`${table.leftAt} is null`),
  index('session_directory_members_session_id_idx').on(table.sessionId),
  index('session_directory_members_player_id_idx').on(table.playerId),
])
