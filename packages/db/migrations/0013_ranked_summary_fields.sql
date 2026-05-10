ALTER TABLE `player_ratings` ADD `imported_games` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `player_ratings` ADD `effective_games` real DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `player_ratings` ADD `wins_vs_tier_1` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `player_ratings` ADD `wins_vs_tier_2_plus` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `player_ratings` ADD `updated_at` integer;
