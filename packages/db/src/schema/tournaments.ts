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

export const tournamentEntries = sqliteTable('tournament_entries', {
  id: text('id').primaryKey(),
  tournamentId: text('tournament_id').notNull().references(() => tournaments.id, { onDelete: 'cascade' }),
  seed: integer('seed', { mode: 'number' }),
  status: text('status').notNull().default('active'),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
}, table => [
  uniqueIndex('tournament_entries_tournament_seed_idx')
    .on(table.tournamentId, table.seed)
    .where(sql`${table.seed} is not null`),
  index('tournament_entries_tournament_status_idx').on(table.tournamentId, table.status),
])

export const tournamentEntryMembers = sqliteTable('tournament_entry_members', {
  entryId: text('entry_id').notNull().references(() => tournamentEntries.id, { onDelete: 'cascade' }),
  tournamentId: text('tournament_id').notNull().references(() => tournaments.id, { onDelete: 'cascade' }),
  position: integer('position', { mode: 'number' }).notNull(),
  playerId: text('player_id').references(() => players.id),
  displayName: text('display_name').notNull(),
  avatarUrl: text('avatar_url'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  linkedAt: integer('linked_at', { mode: 'number' }),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
}, table => [
  primaryKey({ columns: [table.entryId, table.position] }),
  uniqueIndex('tournament_entry_members_active_player_idx')
    .on(table.tournamentId, table.playerId)
    .where(sql`${table.active} = true and ${table.playerId} is not null`),
  index('tournament_entry_members_player_id_idx').on(table.playerId),
  index('tournament_entry_members_tournament_entry_idx').on(table.tournamentId, table.entryId),
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
  entryOneId: text('entry_one_id').references(() => tournamentEntries.id),
  entryTwoId: text('entry_two_id').references(() => tournamentEntries.id),
  winnerEntryId: text('winner_entry_id').references(() => tournamentEntries.id),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
}, table => [
  index('tournament_matches_tournament_status_idx').on(table.tournamentId, table.status),
  index('tournament_matches_tournament_stage_idx').on(table.tournamentId, table.stage),
  index('tournament_matches_match_id_idx').on(table.matchId),
  index('tournament_matches_player_one_idx').on(table.playerOneId),
  index('tournament_matches_player_two_idx').on(table.playerTwoId),
  index('tournament_matches_entry_one_idx').on(table.entryOneId),
  index('tournament_matches_entry_two_idx').on(table.entryTwoId),
  index('tournament_matches_winner_entry_idx').on(table.winnerEntryId),
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
  entryOneId: text('entry_one_id').references(() => tournamentEntries.id),
  entryTwoId: text('entry_two_id').references(() => tournamentEntries.id),
  winnerEntryId: text('winner_entry_id').references(() => tournamentEntries.id),
  status: text('status').notNull().default('scheduled'),
  createdAt: integer('created_at', { mode: 'number' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'number' }).notNull(),
}, table => [
  index('tournament_cut_pairings_tournament_round_idx').on(table.tournamentId, table.round),
  uniqueIndex('tournament_cut_pairings_round_seeds_idx').on(table.tournamentId, table.round, table.seedOne, table.seedTwo),
  index('tournament_cut_pairings_session_id_idx').on(table.sessionId),
  index('tournament_cut_pairings_match_id_idx').on(table.matchId),
  index('tournament_cut_pairings_entry_one_idx').on(table.entryOneId),
  index('tournament_cut_pairings_entry_two_idx').on(table.entryTwoId),
  index('tournament_cut_pairings_winner_entry_idx').on(table.winnerEntryId),
])
