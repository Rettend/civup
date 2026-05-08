ALTER TABLE `player_ratings` ADD `imported_games` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `player_ratings` ADD `effective_games` real DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `player_ratings` ADD `unique_opponents` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `player_ratings` ADD `updated_at` integer;
