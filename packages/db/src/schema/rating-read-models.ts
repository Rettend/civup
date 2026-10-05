import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const seasonRatingCheckpoints = sqliteTable(
  'season_rating_checkpoints',
  {
    seasonId: text('season_id').notNull(),
    playerId: text('player_id').notNull(),
    mode: text('mode').notNull(),
    sequence: integer('sequence').notNull(),
    matchId: text('match_id').notNull(),
    summary: text('summary').notNull(),
    version: integer('version').notNull().default(1),
    fromHistory: integer('from_history', { mode: 'boolean' }).notNull().default(false),
  },
  table => [primaryKey({ columns: [table.seasonId, table.sequence, table.playerId, table.mode] })],
)

export const divisionQualityInitializations = sqliteTable(
  'division_quality_initializations',
  {
    guildId: text('guild_id').notNull(),
    playerId: text('player_id').notNull(),
    sourceRevision: integer('source_revision').notNull(),
    cursor: text('cursor').notNull().default(''),
    recent: text('recent').notNull(),
    resetting: integer('resetting', { mode: 'boolean' }).notNull().default(false),
    complete: integer('complete', { mode: 'boolean' }).notNull().default(false),
  },
  table => [primaryKey({ columns: [table.guildId, table.playerId] })],
)

export const seasonCheckpointInitializations = sqliteTable(
  'season_checkpoint_initializations',
  {
    seasonId: text('season_id').notNull(),
    playerId: text('player_id').notNull(),
    mode: text('mode').notNull(),
    sequence: integer('sequence').notNull(),
    summary: text('summary').notNull(),
    sourceRevision: integer('source_revision').notNull(),
    complete: integer('complete', { mode: 'boolean' }).notNull(),
  },
  table => [primaryKey({ columns: [table.seasonId, table.playerId, table.mode] })],
)
