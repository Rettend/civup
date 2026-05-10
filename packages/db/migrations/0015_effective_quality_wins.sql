ALTER TABLE `player_ratings` ADD `effective_wins_vs_tier_1` real DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `player_ratings` ADD `effective_wins_vs_tier_2_plus` real DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `player_rating_events` ADD `effective_wins_vs_tier_1_delta` real DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `player_rating_events` ADD `effective_wins_vs_tier_2_plus_delta` real DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `player_rating_events`
SET
  `effective_wins_vs_tier_1_delta` = `wins_vs_tier_1_delta` * `effective_games_delta` / COALESCE((
    SELECT CASE
      WHEN `self`.`team` IS NULL THEN 1
      ELSE (
        SELECT COUNT(*)
        FROM `match_participants` AS `teammate`
        WHERE `teammate`.`match_id` = `self`.`match_id`
          AND `teammate`.`team` = `self`.`team`
      )
    END
    FROM `match_participants` AS `self`
    WHERE `self`.`match_id` = `player_rating_events`.`match_id`
      AND `self`.`player_id` = `player_rating_events`.`player_id`
    LIMIT 1
  ), 1),
  `effective_wins_vs_tier_2_plus_delta` = `wins_vs_tier_2_plus_delta` * `effective_games_delta` / COALESCE((
    SELECT CASE
      WHEN `self`.`team` IS NULL THEN 1
      ELSE (
        SELECT COUNT(*)
        FROM `match_participants` AS `teammate`
        WHERE `teammate`.`match_id` = `self`.`match_id`
          AND `teammate`.`team` = `self`.`team`
      )
    END
    FROM `match_participants` AS `self`
    WHERE `self`.`match_id` = `player_rating_events`.`match_id`
      AND `self`.`player_id` = `player_rating_events`.`player_id`
    LIMIT 1
  ), 1);
--> statement-breakpoint
UPDATE `player_ratings`
SET
  `effective_wins_vs_tier_1` = COALESCE((
    SELECT SUM(`player_rating_events`.`effective_wins_vs_tier_1_delta`)
    FROM `player_rating_events`
    WHERE `player_rating_events`.`player_id` = `player_ratings`.`player_id`
      AND `player_rating_events`.`mode` = `player_ratings`.`mode`
  ), 0),
  `effective_wins_vs_tier_2_plus` = COALESCE((
    SELECT SUM(`player_rating_events`.`effective_wins_vs_tier_2_plus_delta`)
    FROM `player_rating_events`
    WHERE `player_rating_events`.`player_id` = `player_ratings`.`player_id`
      AND `player_rating_events`.`mode` = `player_ratings`.`mode`
  ), 0);
