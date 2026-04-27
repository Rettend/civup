CREATE TABLE `session_directory` (
	`session_id` text PRIMARY KEY NOT NULL,
	`phase` text NOT NULL,
	`mode` text NOT NULL,
	`guild_id` text,
	`channel_id` text NOT NULL,
	`host_id` text NOT NULL,
	`message_id` text NOT NULL,
	`match_id` text,
	`steam_lobby_link` text,
	`version` integer NOT NULL,
	`roster_json` text NOT NULL,
	`config_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_activity_at` integer NOT NULL,
	`closed_at` integer
);
--> statement-breakpoint
CREATE INDEX `session_directory_phase_updated_at_idx` ON `session_directory` (`phase`, `updated_at`);
--> statement-breakpoint
CREATE INDEX `session_directory_channel_updated_at_idx` ON `session_directory` (`channel_id`, `updated_at`);
--> statement-breakpoint
CREATE INDEX `session_directory_mode_updated_at_idx` ON `session_directory` (`mode`, `updated_at`);
--> statement-breakpoint
CREATE INDEX `session_directory_host_id_idx` ON `session_directory` (`host_id`);
--> statement-breakpoint
CREATE INDEX `session_directory_match_id_idx` ON `session_directory` (`match_id`);
--> statement-breakpoint
CREATE TABLE `session_directory_members` (
	`session_id` text NOT NULL,
	`player_id` text NOT NULL,
	`role` text DEFAULT 'participant' NOT NULL,
	`joined_at` integer NOT NULL,
	`left_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `player_id`),
	FOREIGN KEY (`session_id`) REFERENCES `session_directory`(`session_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_directory_members_live_player_idx` ON `session_directory_members` (`player_id`) WHERE `left_at` is null;
--> statement-breakpoint
CREATE INDEX `session_directory_members_session_id_idx` ON `session_directory_members` (`session_id`);
--> statement-breakpoint
CREATE INDEX `session_directory_members_player_id_idx` ON `session_directory_members` (`player_id`);
