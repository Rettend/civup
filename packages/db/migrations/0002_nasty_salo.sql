CREATE TABLE `season_peak_ranks` (
	`season_id` text NOT NULL,
	`player_id` text NOT NULL,
	`tier` text NOT NULL,
	`source_mode` text,
	`achieved_at` integer NOT NULL,
	PRIMARY KEY(`season_id`, `player_id`),
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `seasons` ADD `season_number` integer NOT NULL;