import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { players } from './players.ts'

export const tournaments = sqliteTable('tournaments', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  mode: text('mode').notNull().default('1v1'),
  status: text('status').notNull().default('qualifier'),
  scoring: text('scoring').notNull().default('open_win_rate'),
  rematchPolicy: text('rematch_policy').notNull().default('warn'),
  minGames: integer('min_games', { mode: 'number' }).notNull().default(6),
  topCut: integer('top_cut', { mode: 'number' }).notNull().default(8),
  roleId: text('role_id'),
  createdById: text('created_by_id').notNull(),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
}, table => [
  index('tournaments_status_updated_at_idx').on(table.status, table.updatedAt),
])

export const tournamentPlayers = sqliteTable('tournament_players', {
  tournamentId: text('tournament_id').notNull().references(() => tournaments.id, { onDelete: 'cascade' }),
  seed: integer('seed', { mode: 'number' }),
  playerId: text('player_id').references(() => players.id),
  displayName: text('display_name').notNull(),
  avatarUrl: text('avatar_url'),
  confirmed: integer('confirmed', { mode: 'boolean' }).notNull().default(true),
  linkedAt: integer('linked_at', { mode: 'number' }),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
}, table => [
  primaryKey({ columns: [table.tournamentId, table.displayName] }),
  uniqueIndex('tournament_players_tournament_seed_idx')
    .on(table.tournamentId, table.seed)
    .where(sql`${table.seed} is not null`),
  uniqueIndex('tournament_players_tournament_player_idx')
    .on(table.tournamentId, table.playerId)
    .where(sql`${table.playerId} is not null`),
  index('tournament_players_player_id_idx').on(table.playerId),
])

export const tournamentMatches = sqliteTable('tournament_matches', {
  sessionId: text('session_id').primaryKey(),
  tournamentId: text('tournament_id').notNull().references(() => tournaments.id, { onDelete: 'cascade' }),
  matchId: text('match_id'),
  stage: text('stage').notNull().default('qualifier'),
  status: text('status').notNull().default('open'),
  playerOneId: text('player_one_id').references(() => players.id),
  playerTwoId: text('player_two_id').references(() => players.id),
  winnerId: text('winner_id').references(() => players.id),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
}, table => [
  index('tournament_matches_tournament_status_idx').on(table.tournamentId, table.status),
  index('tournament_matches_tournament_stage_idx').on(table.tournamentId, table.stage),
  index('tournament_matches_match_id_idx').on(table.matchId),
  index('tournament_matches_player_one_idx').on(table.playerOneId),
  index('tournament_matches_player_two_idx').on(table.playerTwoId),
])

export const tournamentCutPairings = sqliteTable('tournament_cut_pairings', {
  id: text('id').primaryKey(),
  tournamentId: text('tournament_id').notNull().references(() => tournaments.id, { onDelete: 'cascade' }),
  round: text('round').notNull(),
  seedOne: integer('seed_one', { mode: 'number' }).notNull(),
  seedTwo: integer('seed_two', { mode: 'number' }).notNull(),
  playerOneId: text('player_one_id').references(() => players.id),
  playerTwoId: text('player_two_id').references(() => players.id),
  sessionId: text('session_id'),
  matchId: text('match_id'),
  winnerId: text('winner_id').references(() => players.id),
  status: text('status').notNull().default('scheduled'),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
}, table => [
  index('tournament_cut_pairings_tournament_round_idx').on(table.tournamentId, table.round),
  index('tournament_cut_pairings_session_id_idx').on(table.sessionId),
  index('tournament_cut_pairings_match_id_idx').on(table.matchId),
])
