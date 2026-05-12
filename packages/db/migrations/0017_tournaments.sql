CREATE TABLE `tournaments` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`mode` text DEFAULT '1v1' NOT NULL,
	`status` text DEFAULT 'qualifier' NOT NULL,
	`scoring` text DEFAULT 'open_win_rate' NOT NULL,
	`rematch_policy` text DEFAULT 'warn' NOT NULL,
	`min_games` integer DEFAULT 6 NOT NULL,
	`top_cut` integer DEFAULT 8 NOT NULL,
	`role_id` text,
	`created_by_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tournaments_status_updated_at_idx` ON `tournaments` (`status`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `tournament_players` (
	`tournament_id` text NOT NULL,
	`seed` integer,
	`player_id` text,
	`display_name` text NOT NULL,
	`avatar_url` text,
	`confirmed` integer DEFAULT true NOT NULL,
	`linked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`tournament_id`, `display_name`),
	FOREIGN KEY (`tournament_id`) REFERENCES `tournaments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tournament_players_tournament_seed_idx` ON `tournament_players` (`tournament_id`,`seed`) WHERE `seed` is not null;
--> statement-breakpoint
CREATE UNIQUE INDEX `tournament_players_tournament_player_idx` ON `tournament_players` (`tournament_id`,`player_id`) WHERE `player_id` is not null;
--> statement-breakpoint
CREATE INDEX `tournament_players_player_id_idx` ON `tournament_players` (`player_id`);
--> statement-breakpoint
CREATE TABLE `tournament_matches` (
	`session_id` text PRIMARY KEY NOT NULL,
	`tournament_id` text NOT NULL,
	`match_id` text,
	`stage` text DEFAULT 'qualifier' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`player_one_id` text,
	`player_two_id` text,
	`winner_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tournament_id`) REFERENCES `tournaments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`player_one_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_two_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`winner_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tournament_matches_tournament_status_idx` ON `tournament_matches` (`tournament_id`,`status`);
--> statement-breakpoint
CREATE INDEX `tournament_matches_tournament_stage_idx` ON `tournament_matches` (`tournament_id`,`stage`);
--> statement-breakpoint
CREATE INDEX `tournament_matches_match_id_idx` ON `tournament_matches` (`match_id`);
--> statement-breakpoint
CREATE INDEX `tournament_matches_player_one_idx` ON `tournament_matches` (`player_one_id`);
--> statement-breakpoint
CREATE INDEX `tournament_matches_player_two_idx` ON `tournament_matches` (`player_two_id`);
--> statement-breakpoint
CREATE TABLE `tournament_cut_pairings` (
	`id` text PRIMARY KEY NOT NULL,
	`tournament_id` text NOT NULL,
	`round` text NOT NULL,
	`seed_one` integer NOT NULL,
	`seed_two` integer NOT NULL,
	`player_one_id` text,
	`player_two_id` text,
	`session_id` text,
	`match_id` text,
	`winner_id` text,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tournament_id`) REFERENCES `tournaments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`player_one_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_two_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`winner_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tournament_cut_pairings_tournament_round_idx` ON `tournament_cut_pairings` (`tournament_id`,`round`);
--> statement-breakpoint
CREATE INDEX `tournament_cut_pairings_session_id_idx` ON `tournament_cut_pairings` (`session_id`);
--> statement-breakpoint
CREATE INDEX `tournament_cut_pairings_match_id_idx` ON `tournament_cut_pairings` (`match_id`);
