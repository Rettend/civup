CREATE TABLE `autosave_uploads` (
  `id` text PRIMARY KEY NOT NULL,
  `uploaded_at` integer NOT NULL,
  `uploader_user_id` text NOT NULL,
  `uploader_display_name` text,
  `channel_id` text,
  `match_id` text,
  `file_name` text NOT NULL,
  `file_size_bytes` integer NOT NULL,
  `r2_key` text NOT NULL,
  `etag` text,
  `status` text DEFAULT 'uploaded' NOT NULL,
  `download_count` integer DEFAULT 0 NOT NULL,
  `parse_status` text DEFAULT 'pending' NOT NULL,
  `parse_error` text,
  `save_count` integer,
  `max_turn` integer,
  `latest_save_name` text,
  `player_count` integer,
  `game_mode` text,
  `leaders_json` text,
  `civs_json` text,
  `players_json` text,
  `map_file` text,
  `mods_json` text,
  `bbg_detected` integer DEFAULT false NOT NULL,
  `bbg_title` text,
  `bbg_version` text,
  `notes` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `autosave_uploads_r2_key_idx` ON `autosave_uploads` (`r2_key`);
--> statement-breakpoint
CREATE INDEX `autosave_uploads_uploaded_at_idx` ON `autosave_uploads` (`uploaded_at`);
--> statement-breakpoint
CREATE INDEX `autosave_uploads_uploader_idx` ON `autosave_uploads` (`uploader_user_id`,`uploaded_at`);
--> statement-breakpoint
CREATE INDEX `autosave_uploads_game_mode_idx` ON `autosave_uploads` (`game_mode`);
--> statement-breakpoint
CREATE INDEX `autosave_uploads_bbg_version_idx` ON `autosave_uploads` (`bbg_version`);
--> statement-breakpoint
CREATE INDEX `autosave_uploads_parse_status_idx` ON `autosave_uploads` (`parse_status`,`uploaded_at`);
