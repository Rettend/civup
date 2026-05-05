CREATE TABLE `civ_stats` (
	`civ_id` text PRIMARY KEY NOT NULL,
	`picks` integer DEFAULT 0 NOT NULL,
	`wins` integer DEFAULT 0 NOT NULL,
	`bans` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `civ_stat_totals` (
	`scope` text PRIMARY KEY NOT NULL,
	`completed_match_count` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `match_civ_stat_contributions` (
	`match_id` text PRIMARY KEY NOT NULL,
	`completed_match_count` integer DEFAULT 0 NOT NULL,
	`contributions_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE cascade
);
