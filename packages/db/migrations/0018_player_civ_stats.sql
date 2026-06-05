CREATE TABLE `player_civ_stats` (
	`season_id` text DEFAULT '' NOT NULL,
	`game_mode` text NOT NULL,
	`player_id` text NOT NULL,
	`civ_id` text NOT NULL,
	`picks` integer DEFAULT 0 NOT NULL,
	`wins` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`season_id`, `game_mode`, `player_id`, `civ_id`),
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `player_civ_stats_player_context_idx` ON `player_civ_stats` (`player_id`, `season_id`, `game_mode`, `civ_id`);
--> statement-breakpoint
CREATE INDEX `player_civ_stats_civ_context_idx` ON `player_civ_stats` (`civ_id`, `season_id`, `game_mode`, `player_id`);
--> statement-breakpoint
CREATE TABLE `match_player_civ_stat_contributions` (
	`match_id` text PRIMARY KEY NOT NULL,
	`contributions_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE cascade
);
