CREATE TABLE public_rating_decay_policies (
  version TEXT PRIMARY KEY NOT NULL,
  enabled_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE leaderboard_decay_schedules (
  mode TEXT PRIMARY KEY NOT NULL,
  next_decay_at INTEGER,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
INSERT INTO public_rating_decay_policies(version, enabled_at)
VALUES ('rp-decay-v1', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
--> statement-breakpoint
ALTER TABLE season_rating_states ADD COLUMN public_decay TEXT;
--> statement-breakpoint
ALTER TABLE player_ratings ADD COLUMN public_decay TEXT;
--> statement-breakpoint
ALTER TABLE player_rating_events ADD COLUMN public_decay_before TEXT;
--> statement-breakpoint
ALTER TABLE player_rating_events ADD COLUMN public_decay_after TEXT;
--> statement-breakpoint
ALTER TABLE player_rating_events ADD COLUMN public_decay_delta REAL NOT NULL DEFAULT 0;
--> statement-breakpoint
INSERT INTO leaderboard_dirty_states(scope, dirty_at, reason)
SELECT 'player:' || mode, CAST(strftime('%s', 'now') AS INTEGER) * 1000, 'season-stats-and-decay'
FROM (SELECT 'duel' AS mode UNION ALL SELECT 'duo' UNION ALL SELECT 'squad' UNION ALL SELECT 'ffa' UNION ALL SELECT 'red-death')
WHERE EXISTS (SELECT 1 FROM seasons WHERE active = 1 AND rating_system = 'rp')
ON CONFLICT(scope) DO UPDATE SET dirty_at=excluded.dirty_at, reason=excluded.reason;
