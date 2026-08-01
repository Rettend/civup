ALTER TABLE `scoped_player_ratings` ADD `public_rating` real;
--> statement-breakpoint
ALTER TABLE `player_ratings` ADD `public_rating` real;
--> statement-breakpoint
ALTER TABLE `scoped_player_rating_events` ADD `public_rating_before` real;
--> statement-breakpoint
ALTER TABLE `scoped_player_rating_events` ADD `public_rating_after` real;
--> statement-breakpoint
ALTER TABLE `player_rating_events` ADD `public_rating_before` real;
--> statement-breakpoint
ALTER TABLE `player_rating_events` ADD `public_rating_after` real;
