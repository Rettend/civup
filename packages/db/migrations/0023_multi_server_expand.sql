ALTER TABLE `matches` ADD `guild_id` text;
--> statement-breakpoint
ALTER TABLE `matches` ADD `draft_completed_at` integer;
--> statement-breakpoint
ALTER TABLE `matches` ADD `cancelled_at` integer;
--> statement-breakpoint
ALTER TABLE `matches` ADD `result_revision` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `match_participants` ADD `source_guild_id` text;
--> statement-breakpoint
ALTER TABLE `match_participants` ADD `source_kind` text;
--> statement-breakpoint
ALTER TABLE `session_directory` ADD `draft_start_deadline_at` integer;
--> statement-breakpoint
CREATE INDEX `matches_guild_status_completed_at_idx` ON `matches` (`guild_id`,`status`,`completed_at`);
--> statement-breakpoint
CREATE INDEX `matches_guild_mode_created_at_idx` ON `matches` (`guild_id`,`game_mode`,`created_at`);
--> statement-breakpoint
CREATE INDEX `matches_status_draft_completed_at_idx` ON `matches` (`status`,`draft_completed_at`);
--> statement-breakpoint
CREATE INDEX `matches_status_cancelled_at_idx` ON `matches` (`status`,`cancelled_at`);
--> statement-breakpoint
CREATE INDEX `session_directory_phase_draft_start_deadline_idx` ON `session_directory` (`phase`,`draft_start_deadline_at`);
--> statement-breakpoint
CREATE TABLE `scoped_player_ratings` (
  `stats_key` text NOT NULL, `player_id` text NOT NULL, `mode` text NOT NULL,
  `mu` real DEFAULT 25 NOT NULL, `sigma` real DEFAULT 8.333 NOT NULL,
  `games_played` integer DEFAULT 0 NOT NULL, `wins` integer DEFAULT 0 NOT NULL,
  `imported_games` integer DEFAULT 0 NOT NULL, `effective_games` real DEFAULT 0 NOT NULL,
  `wins_vs_tier_1` integer DEFAULT 0 NOT NULL, `wins_vs_tier_2_plus` integer DEFAULT 0 NOT NULL,
  `effective_wins_vs_tier_1` real DEFAULT 0 NOT NULL, `effective_wins_vs_tier_2_plus` real DEFAULT 0 NOT NULL,
  `last_played_at` integer, `updated_at` integer,
  PRIMARY KEY (`stats_key`,`player_id`,`mode`),
  FOREIGN KEY (`player_id`) REFERENCES `players`(`id`)
);
--> statement-breakpoint
CREATE INDEX `scoped_player_ratings_stats_mode_idx` ON `scoped_player_ratings` (`stats_key`,`mode`);
--> statement-breakpoint
CREATE TABLE `scoped_player_rating_events` (
  `stats_key` text NOT NULL, `match_id` text NOT NULL, `player_id` text NOT NULL, `mode` text NOT NULL,
  `game_mode` text NOT NULL, `rating_before_mu` real NOT NULL, `rating_before_sigma` real NOT NULL,
  `rating_after_mu` real NOT NULL, `rating_after_sigma` real NOT NULL,
  `games_delta` integer DEFAULT 1 NOT NULL, `wins_delta` integer DEFAULT 0 NOT NULL,
  `imported_games_delta` integer DEFAULT 0 NOT NULL, `effective_games_delta` real DEFAULT 1 NOT NULL,
  `wins_vs_tier_1_delta` integer DEFAULT 0 NOT NULL, `wins_vs_tier_2_plus_delta` integer DEFAULT 0 NOT NULL,
  `effective_wins_vs_tier_1_delta` real DEFAULT 0 NOT NULL, `effective_wins_vs_tier_2_plus_delta` real DEFAULT 0 NOT NULL,
  `match_created_at` integer NOT NULL, `match_completed_at` integer, `updated_at` integer,
  PRIMARY KEY (`stats_key`,`match_id`,`player_id`,`mode`),
  FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`), FOREIGN KEY (`player_id`) REFERENCES `players`(`id`)
);
--> statement-breakpoint
CREATE INDEX `scoped_rating_events_player_scope_idx` ON `scoped_player_rating_events` (`stats_key`,`player_id`,`mode`,`match_created_at`);
--> statement-breakpoint
CREATE INDEX `scoped_rating_events_match_idx` ON `scoped_player_rating_events` (`stats_key`,`match_id`);
--> statement-breakpoint
CREATE TABLE `scoped_civ_stats` (
  `stats_key` text NOT NULL, `mode_scope` text DEFAULT 'all' NOT NULL, `civ_id` text NOT NULL,
  `picks` integer DEFAULT 0 NOT NULL, `wins` integer DEFAULT 0 NOT NULL, `bans` integer DEFAULT 0 NOT NULL,
  `updated_at` integer NOT NULL, PRIMARY KEY (`stats_key`,`mode_scope`,`civ_id`)
);
--> statement-breakpoint
CREATE INDEX `scoped_civ_stats_scope_idx` ON `scoped_civ_stats` (`stats_key`,`mode_scope`,`civ_id`);
--> statement-breakpoint
CREATE TABLE `scoped_civ_stat_pool_totals` (
  `stats_key` text NOT NULL, `mode_scope` text DEFAULT 'all' NOT NULL, `pool_key` text NOT NULL,
  `pool_civ_ids_json` text NOT NULL, `completed_match_count` integer DEFAULT 0 NOT NULL, `updated_at` integer NOT NULL,
  PRIMARY KEY (`stats_key`,`mode_scope`,`pool_key`)
);
--> statement-breakpoint
CREATE TABLE `scoped_civ_stat_totals` (
  `stats_key` text NOT NULL, `scope` text NOT NULL, `completed_match_count` integer DEFAULT 0 NOT NULL,
  `updated_at` integer NOT NULL, PRIMARY KEY (`stats_key`,`scope`)
);
--> statement-breakpoint
CREATE TABLE `scoped_match_civ_stat_contributions` (
  `stats_key` text NOT NULL, `match_id` text NOT NULL, `completed_match_count` integer DEFAULT 0 NOT NULL,
  `contributions_json` text NOT NULL, `source` text DEFAULT 'live' NOT NULL, `mode_scope` text DEFAULT 'all' NOT NULL,
  `completed_at` integer DEFAULT 0 NOT NULL, `visible` integer DEFAULT true NOT NULL, `updated_at` integer NOT NULL,
  PRIMARY KEY (`stats_key`,`match_id`), FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `scoped_match_civ_visible_idx` ON `scoped_match_civ_stat_contributions` (`stats_key`,`visible`,`source`,`completed_at`,`mode_scope`);
--> statement-breakpoint
CREATE TABLE `scoped_player_civ_stats` (
  `stats_key` text NOT NULL, `season_id` text DEFAULT '' NOT NULL, `game_mode` text NOT NULL,
  `player_id` text NOT NULL, `civ_id` text NOT NULL, `picks` integer DEFAULT 0 NOT NULL,
  `wins` integer DEFAULT 0 NOT NULL, `updated_at` integer NOT NULL,
  PRIMARY KEY (`stats_key`,`season_id`,`game_mode`,`player_id`,`civ_id`),
  FOREIGN KEY (`player_id`) REFERENCES `players`(`id`)
);
--> statement-breakpoint
CREATE INDEX `scoped_player_civ_player_idx` ON `scoped_player_civ_stats` (`stats_key`,`player_id`,`season_id`,`game_mode`,`civ_id`);
--> statement-breakpoint
CREATE INDEX `scoped_player_civ_civ_idx` ON `scoped_player_civ_stats` (`stats_key`,`civ_id`,`season_id`,`game_mode`,`player_id`);
--> statement-breakpoint
CREATE TABLE `scoped_match_player_civ_stat_contributions` (
  `stats_key` text NOT NULL, `match_id` text NOT NULL, `contributions_json` text NOT NULL, `updated_at` integer NOT NULL,
  PRIMARY KEY (`stats_key`,`match_id`), FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `scoped_season_peak_ranks` (
  `stats_key` text NOT NULL, `season_id` text NOT NULL, `player_id` text NOT NULL, `tier` text NOT NULL,
  `source_mode` text, `achieved_at` integer NOT NULL, PRIMARY KEY (`stats_key`,`season_id`,`player_id`),
  FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`), FOREIGN KEY (`player_id`) REFERENCES `players`(`id`)
);
--> statement-breakpoint
CREATE TABLE `scoped_season_peak_mode_ranks` (
  `stats_key` text NOT NULL, `season_id` text NOT NULL, `player_id` text NOT NULL, `mode` text NOT NULL,
  `tier` text, `rating` integer NOT NULL, `achieved_at` integer NOT NULL,
  PRIMARY KEY (`stats_key`,`season_id`,`player_id`,`mode`),
  FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`), FOREIGN KEY (`player_id`) REFERENCES `players`(`id`)
);
--> statement-breakpoint
CREATE TABLE `match_repairs` (
  `id` text PRIMARY KEY NOT NULL, `idempotency_key` text NOT NULL, `session_id` text, `match_id` text,
  `result_revision` integer DEFAULT 0 NOT NULL, `repair_type` text NOT NULL, `status` text DEFAULT 'pending' NOT NULL,
  `lease_owner` text, `lease_expires_at` integer, `attempts` integer DEFAULT 0 NOT NULL,
  `next_attempt_at` integer DEFAULT 0 NOT NULL, `last_error` text, `created_at` integer NOT NULL, `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `match_repairs_idempotency_key_idx` ON `match_repairs` (`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `match_repairs_due_idx` ON `match_repairs` (`status`,`next_attempt_at`,`created_at`);
--> statement-breakpoint
CREATE INDEX `match_repairs_match_revision_idx` ON `match_repairs` (`match_id`,`result_revision`);
