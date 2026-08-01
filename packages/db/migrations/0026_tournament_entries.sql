CREATE TABLE `tournament_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`tournament_id` text NOT NULL,
	`seed` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tournament_id`) REFERENCES `tournaments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tournament_entries_tournament_seed_idx` ON `tournament_entries` (`tournament_id`,`seed`) WHERE `seed` is not null;
--> statement-breakpoint
CREATE INDEX `tournament_entries_tournament_status_idx` ON `tournament_entries` (`tournament_id`,`status`);
--> statement-breakpoint
CREATE TABLE `tournament_entry_members` (
	`entry_id` text NOT NULL,
	`tournament_id` text NOT NULL,
	`position` integer NOT NULL,
	`player_id` text,
	`display_name` text NOT NULL,
	`avatar_url` text,
	`active` integer DEFAULT true NOT NULL,
	`linked_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`entry_id`, `position`),
	FOREIGN KEY (`entry_id`) REFERENCES `tournament_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tournament_id`) REFERENCES `tournaments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`player_id`) REFERENCES `players`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tournament_entry_members_active_player_idx` ON `tournament_entry_members` (`tournament_id`,`player_id`) WHERE `active` = true and `player_id` is not null;
--> statement-breakpoint
CREATE INDEX `tournament_entry_members_player_id_idx` ON `tournament_entry_members` (`player_id`);
--> statement-breakpoint
CREATE INDEX `tournament_entry_members_tournament_entry_idx` ON `tournament_entry_members` (`tournament_id`,`entry_id`);
--> statement-breakpoint
INSERT INTO `tournament_entries` (`id`, `tournament_id`, `seed`, `status`, `created_at`, `updated_at`)
SELECT 'legacy:' || `tournament_id` || ':' || hex(`display_name`), `tournament_id`, `seed`, CASE WHEN `confirmed` THEN 'active' ELSE 'withdrawn' END, `created_at`, `updated_at`
FROM `tournament_players`;
--> statement-breakpoint
INSERT INTO `tournament_entry_members` (`entry_id`, `tournament_id`, `position`, `player_id`, `display_name`, `avatar_url`, `active`, `linked_at`, `created_at`, `updated_at`)
SELECT 'legacy:' || `tournament_id` || ':' || hex(`display_name`), `tournament_id`, 0, `player_id`, `display_name`, `avatar_url`, `confirmed`, `linked_at`, `created_at`, `updated_at`
FROM `tournament_players`;
--> statement-breakpoint
ALTER TABLE `tournament_matches` ADD `entry_one_id` text REFERENCES `tournament_entries`(`id`);
--> statement-breakpoint
ALTER TABLE `tournament_matches` ADD `entry_two_id` text REFERENCES `tournament_entries`(`id`);
--> statement-breakpoint
ALTER TABLE `tournament_matches` ADD `winner_entry_id` text REFERENCES `tournament_entries`(`id`);
--> statement-breakpoint
CREATE INDEX `tournament_matches_entry_one_idx` ON `tournament_matches` (`entry_one_id`);
--> statement-breakpoint
CREATE INDEX `tournament_matches_entry_two_idx` ON `tournament_matches` (`entry_two_id`);
--> statement-breakpoint
CREATE INDEX `tournament_matches_winner_entry_idx` ON `tournament_matches` (`winner_entry_id`);
--> statement-breakpoint
UPDATE `tournament_matches`
SET `entry_one_id` = (SELECT `entry_id` FROM `tournament_entry_members` WHERE `tournament_id` = `tournament_matches`.`tournament_id` AND `player_id` = `tournament_matches`.`player_one_id` LIMIT 1),
    `entry_two_id` = (SELECT `entry_id` FROM `tournament_entry_members` WHERE `tournament_id` = `tournament_matches`.`tournament_id` AND `player_id` = `tournament_matches`.`player_two_id` LIMIT 1),
    `winner_entry_id` = (SELECT `entry_id` FROM `tournament_entry_members` WHERE `tournament_id` = `tournament_matches`.`tournament_id` AND `player_id` = `tournament_matches`.`winner_id` LIMIT 1);
--> statement-breakpoint
ALTER TABLE `tournament_cut_pairings` ADD `entry_one_id` text REFERENCES `tournament_entries`(`id`);
--> statement-breakpoint
ALTER TABLE `tournament_cut_pairings` ADD `entry_two_id` text REFERENCES `tournament_entries`(`id`);
--> statement-breakpoint
ALTER TABLE `tournament_cut_pairings` ADD `winner_entry_id` text REFERENCES `tournament_entries`(`id`);
--> statement-breakpoint
CREATE INDEX `tournament_cut_pairings_entry_one_idx` ON `tournament_cut_pairings` (`entry_one_id`);
--> statement-breakpoint
CREATE INDEX `tournament_cut_pairings_entry_two_idx` ON `tournament_cut_pairings` (`entry_two_id`);
--> statement-breakpoint
CREATE INDEX `tournament_cut_pairings_winner_entry_idx` ON `tournament_cut_pairings` (`winner_entry_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `tournament_cut_pairings_round_seeds_idx` ON `tournament_cut_pairings` (`tournament_id`,`round`,`seed_one`,`seed_two`);
--> statement-breakpoint
UPDATE `tournament_cut_pairings`
SET `entry_one_id` = (SELECT `entry_id` FROM `tournament_entry_members` WHERE `tournament_id` = `tournament_cut_pairings`.`tournament_id` AND `player_id` = `tournament_cut_pairings`.`player_one_id` LIMIT 1),
    `entry_two_id` = (SELECT `entry_id` FROM `tournament_entry_members` WHERE `tournament_id` = `tournament_cut_pairings`.`tournament_id` AND `player_id` = `tournament_cut_pairings`.`player_two_id` LIMIT 1),
    `winner_entry_id` = (SELECT `entry_id` FROM `tournament_entry_members` WHERE `tournament_id` = `tournament_cut_pairings`.`tournament_id` AND `player_id` = `tournament_cut_pairings`.`winner_id` LIMIT 1);
