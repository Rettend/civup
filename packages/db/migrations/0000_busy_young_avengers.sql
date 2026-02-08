CREATE TABLE `match_bans` (
	`match_id` text NOT NULL,
	`civ_id` text NOT NULL,
	`banned_by` text NOT NULL,
	`phase` integer NOT NULL,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`banned_by`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `match_participants` (
	`match_id` text NOT NULL,
	`player_id` text NOT NULL,
	`team` integer,
	`civ_id` text,
	`placement` integer,
	`rating_before_mu` real,
	`rating_before_sigma` real,
	`rating_after_mu` real,
	`rating_after_sigma` real,
	FOREIGN KEY (`match_id`) REFERENCES `matches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `matches` (
	`id` text PRIMARY KEY NOT NULL,
	`game_mode` text NOT NULL,
	`status` text DEFAULT 'drafting' NOT NULL,
	`season_id` text,
	`draft_data` text,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `player_ratings` (
	`player_id` text NOT NULL,
	`mode` text NOT NULL,
	`mu` real DEFAULT 25 NOT NULL,
	`sigma` real DEFAULT 8.333 NOT NULL,
	`games_played` integer DEFAULT 0 NOT NULL,
	`wins` integer DEFAULT 0 NOT NULL,
	`last_played_at` integer,
	PRIMARY KEY(`player_id`, `mode`),
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `players` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`avatar_url` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `seasons` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer,
	`active` integer DEFAULT false NOT NULL
);
