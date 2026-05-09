CREATE TABLE `player_rating_events` (
	`match_id` text NOT NULL,
	`player_id` text NOT NULL,
	`mode` text NOT NULL,
	`game_mode` text NOT NULL,
	`rating_before_mu` real NOT NULL,
	`rating_before_sigma` real NOT NULL,
	`rating_after_mu` real NOT NULL,
	`rating_after_sigma` real NOT NULL,
	`games_delta` integer DEFAULT 1 NOT NULL,
	`wins_delta` integer DEFAULT 0 NOT NULL,
	`imported_games_delta` integer DEFAULT 0 NOT NULL,
	`effective_games_delta` real DEFAULT 1 NOT NULL,
	`wins_vs_tier_1_delta` integer DEFAULT 0 NOT NULL,
	`wins_vs_tier_2_plus_delta` integer DEFAULT 0 NOT NULL,
	`match_created_at` integer NOT NULL,
	`match_completed_at` integer,
	`updated_at` integer,
	PRIMARY KEY(`match_id`, `player_id`, `mode`),
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `player_rating_events_player_scope_idx` ON `player_rating_events` (`player_id`,`mode`,`match_created_at`);
--> statement-breakpoint
CREATE INDEX `player_rating_events_match_idx` ON `player_rating_events` (`match_id`);
