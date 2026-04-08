CREATE TABLE `player_rating_seeds` (
	`player_id` text NOT NULL,
	`mode` text NOT NULL,
	`mu` real NOT NULL,
	`sigma` real NOT NULL,
	`eligible_for_ranked` integer DEFAULT false NOT NULL,
	`source` text,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`player_id`, `mode`),
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `player_rating_seeds_mode_idx` ON `player_rating_seeds` (`mode`);
