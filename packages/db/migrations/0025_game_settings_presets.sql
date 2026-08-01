CREATE TABLE `game_settings_presets` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_discord_user_id` text NOT NULL,
	`owner_display_name` text,
	`name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`profile_json` text NOT NULL,
	`schema_version` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `game_settings_presets_owner_name_idx` ON `game_settings_presets` (`owner_discord_user_id`,`normalized_name`);
--> statement-breakpoint
CREATE INDEX `game_settings_presets_updated_idx` ON `game_settings_presets` (`updated_at`,`id`);
--> statement-breakpoint
CREATE INDEX `game_settings_presets_owner_updated_idx` ON `game_settings_presets` (`owner_discord_user_id`,`updated_at`);
--> statement-breakpoint
CREATE TRIGGER `game_settings_presets_owner_limit_insert`
BEFORE INSERT ON `game_settings_presets`
WHEN (SELECT COUNT(*) FROM `game_settings_presets` WHERE `owner_discord_user_id` = NEW.`owner_discord_user_id`) >= 10
BEGIN
	SELECT RAISE(ABORT, 'game settings preset owner limit');
END;
