CREATE TABLE `leaderboard_dirty_states` (
	`scope` text PRIMARY KEY NOT NULL,
	`dirty_at` integer NOT NULL,
	`reason` text
);
--> statement-breakpoint
CREATE TABLE `leaderboard_message_states` (
	`scope` text PRIMARY KEY NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `match_message_mappings` (
	`message_id` text PRIMARY KEY NOT NULL,
	`match_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
