ALTER TABLE `match_civ_stat_contributions` ADD `source` text DEFAULT 'live' NOT NULL;
--> statement-breakpoint
ALTER TABLE `match_civ_stat_contributions` ADD `mode_scope` text DEFAULT 'all' NOT NULL;
--> statement-breakpoint
ALTER TABLE `match_civ_stat_contributions` ADD `completed_at` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `match_civ_stat_contributions` ADD `visible` integer DEFAULT true NOT NULL;
--> statement-breakpoint
UPDATE `match_civ_stat_contributions`
SET
  `completed_at` = coalesce((
    SELECT `matches`.`completed_at`
    FROM `matches`
    WHERE `matches`.`id` = `match_civ_stat_contributions`.`match_id`
  ), `updated_at`, 0),
  `mode_scope` = coalesce((
    SELECT CASE
      WHEN `matches`.`game_mode` = '1v1' THEN 'duel'
      WHEN `matches`.`game_mode` = '2v2' THEN 'duo'
      WHEN `matches`.`game_mode` IN ('3v3', '4v4', '5v5', '6v6') THEN 'squad'
      ELSE 'all'
    END
    FROM `matches`
    WHERE `matches`.`id` = `match_civ_stat_contributions`.`match_id`
  ), 'all'),
  `source` = coalesce((
    SELECT CASE
      WHEN json_valid(`matches`.`draft_data`) AND json_extract(`matches`.`draft_data`, '$.leaderDataVersion') = 'beta' THEN 'beta'
      ELSE 'live'
    END
    FROM `matches`
    WHERE `matches`.`id` = `match_civ_stat_contributions`.`match_id`
  ), 'live'),
  `visible` = CASE
    WHEN exists (
      SELECT 1
      FROM `matches`
      WHERE `matches`.`id` = `match_civ_stat_contributions`.`match_id`
        AND `matches`.`status` = 'completed'
        AND NOT coalesce(json_valid(`matches`.`draft_data`) AND json_extract(`matches`.`draft_data`, '$.leaderDataVersion') = 'beta', false)
        AND NOT coalesce(json_valid(`matches`.`draft_data`) AND json_extract(`matches`.`draft_data`, '$.redDeath') = true, false)
        AND NOT coalesce(json_valid(`matches`.`draft_data`) AND json_extract(`matches`.`draft_data`, '$.civBlitz') = true, false)
    )
    AND NOT exists (
      SELECT 1
      FROM `tournament_matches`
      WHERE `tournament_matches`.`match_id` = `match_civ_stat_contributions`.`match_id`
         OR `tournament_matches`.`session_id` = `match_civ_stat_contributions`.`match_id`
    )
  THEN true
  ELSE false
END;
--> statement-breakpoint
CREATE TABLE `civ_stats_new` (
  `mode_scope` text DEFAULT 'all' NOT NULL,
  `civ_id` text NOT NULL,
  `picks` integer DEFAULT 0 NOT NULL,
  `wins` integer DEFAULT 0 NOT NULL,
  `bans` integer DEFAULT 0 NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY(`mode_scope`, `civ_id`)
);
--> statement-breakpoint
DROP TABLE `civ_stats`;
--> statement-breakpoint
ALTER TABLE `civ_stats_new` RENAME TO `civ_stats`;
--> statement-breakpoint
CREATE INDEX `civ_stats_scope_idx` ON `civ_stats` (`mode_scope`,`civ_id`);
--> statement-breakpoint
CREATE TABLE `civ_stat_pool_totals` (
  `mode_scope` text DEFAULT 'all' NOT NULL,
  `pool_key` text NOT NULL,
  `pool_civ_ids_json` text NOT NULL,
  `completed_match_count` integer DEFAULT 0 NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY(`mode_scope`, `pool_key`)
);
--> statement-breakpoint
DELETE FROM `civ_stat_totals` WHERE `scope` = 'history-initialized';
--> statement-breakpoint
CREATE INDEX `match_civ_stat_contributions_visible_idx` ON `match_civ_stat_contributions` (`visible`,`source`,`completed_at`,`mode_scope`);
