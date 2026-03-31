CREATE INDEX `matches_status_created_at_idx` ON `matches` (`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `matches_status_completed_at_idx` ON `matches` (`status`,`completed_at`);
--> statement-breakpoint
CREATE INDEX `match_participants_match_player_idx` ON `match_participants` (`match_id`,`player_id`);
--> statement-breakpoint
CREATE INDEX `match_participants_player_id_idx` ON `match_participants` (`player_id`);
--> statement-breakpoint
CREATE INDEX `match_bans_match_id_idx` ON `match_bans` (`match_id`);
--> statement-breakpoint
CREATE INDEX `player_ratings_mode_idx` ON `player_ratings` (`mode`);
