import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { players } from './players.ts'
import { seasons } from './seasons.ts'

export const divisionQualityDirty = sqliteTable(
  'division_quality_dirty',
  {
    guildId: text('guild_id').notNull(),
    playerId: text('player_id').notNull(),
    matchId: text('match_id').notNull(),
  },
  table => [primaryKey({ columns: [table.guildId, table.playerId, table.matchId] })],
)

export const divisionQualityCredits = sqliteTable(
  'division_quality_credits',
  {
    guildId: text('guild_id').notNull(),
    playerId: text('player_id').notNull(),
    matchId: text('match_id').notNull(),
    at: integer('at').notNull(),
    effectiveGames: real('effective_games').notNull(),
    highRankWins: real('high_rank_wins').notNull(),
    eliteWins: real('elite_wins').notNull(),
  },
  table => [primaryKey({ columns: [table.guildId, table.playerId, table.matchId] })],
)

export const divisionRankPolicies = sqliteTable('division_rank_policies', {
  guildId: text('guild_id').primaryKey(),
  seasonId: text('season_id')
    .notNull()
    .references(() => seasons.id),
  version: text('version').notNull(),
  phase: text('phase', { enum: ['prepared', 'activating', 'active'] }).notNull(),
  configJson: text('config_json').notNull(),
  projectionRevision: integer('projection_revision').notNull().default(1),
  publishedRevision: integer('published_revision').notNull().default(0),
  memberCursor: text('member_cursor'),
  memberScanComplete: integer('member_scan_complete', { mode: 'boolean' }).notNull().default(false),
  nextMemberScanAt: integer('next_member_scan_at').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
})

export const seasonPeakDivisionRanks = sqliteTable(
  'season_peak_division_ranks',
  {
    seasonId: text('season_id')
      .notNull()
      .references(() => seasons.id),
    playerId: text('player_id')
      .notNull()
      .references(() => players.id),
    minimum: integer('minimum').notNull(),
    achievedAt: integer('achieved_at').notNull(),
  },
  table => [primaryKey({ columns: [table.seasonId, table.playerId] })],
)

export const divisionRankSources = sqliteTable('division_rank_sources', {
  playerId: text('player_id')
    .primaryKey()
    .references(() => players.id),
  revision: integer('revision').notNull().default(1),
})

export const divisionRankStates = sqliteTable(
  'division_rank_states',
  {
    guildId: text('guild_id')
      .notNull()
      .references(() => divisionRankPolicies.guildId),
    playerId: text('player_id')
      .notNull()
      .references(() => players.id),
    sourceRevision: integer('source_revision').notNull().default(-1),
    resultJson: text('result_json'),
    nextCheckAt: integer('next_check_at'),
    desiredRoleId: text('desired_role_id'),
    appliedRoleId: text('applied_role_id'),
    pending: integer('pending', { mode: 'boolean' }).notNull().default(false),
    projectionPending: integer('projection_pending', { mode: 'boolean' }).notNull().default(false),
    retryAt: integer('retry_at').notNull().default(0),
    lastError: text('last_error'),
  },
  table => [
    primaryKey({ columns: [table.guildId, table.playerId] }),
    index('division_rank_states_due_idx').on(table.guildId, table.nextCheckAt),
    index('division_rank_states_player_idx').on(table.playerId),
    index('division_rank_states_retry_idx').on(table.guildId, table.retryAt, table.nextCheckAt),
    index('division_rank_states_projection_idx').on(table.guildId, table.projectionPending),
    index('division_rank_states_pending_idx').on(table.guildId, table.pending, table.retryAt),
  ],
)
