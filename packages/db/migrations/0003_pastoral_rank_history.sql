CREATE TABLE `season_peak_mode_ranks` (
	`season_id` text NOT NULL,
	`player_id` text NOT NULL,
	`mode` text NOT NULL,
	`tier` text,
	`rating` integer NOT NULL,
	`achieved_at` integer NOT NULL,
	PRIMARY KEY(`season_id`, `player_id`, `mode`),
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
