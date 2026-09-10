CREATE TABLE division_rank_policies (
  guild_id TEXT PRIMARY KEY NOT NULL,
  season_id TEXT NOT NULL REFERENCES seasons(id),
  version TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('prepared', 'activating', 'active')),
  config_json TEXT NOT NULL,
  projection_revision INTEGER NOT NULL DEFAULT 1,
  published_revision INTEGER NOT NULL DEFAULT 0,
  member_cursor TEXT,
  member_scan_complete INTEGER NOT NULL DEFAULT 0,
  next_member_scan_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE division_rank_sources (
  player_id TEXT PRIMARY KEY NOT NULL REFERENCES players(id),
  revision INTEGER NOT NULL DEFAULT 1
);
--> statement-breakpoint
CREATE TABLE division_quality_dirty (
  guild_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  match_id TEXT NOT NULL,
  PRIMARY KEY(guild_id, player_id, match_id)
);
--> statement-breakpoint
CREATE TABLE division_quality_credits (
  guild_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  match_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  effective_games REAL NOT NULL,
  high_rank_wins REAL NOT NULL,
  elite_wins REAL NOT NULL,
  PRIMARY KEY(guild_id, player_id, match_id)
);
--> statement-breakpoint
CREATE TABLE division_rank_states (
  guild_id TEXT NOT NULL REFERENCES division_rank_policies(guild_id),
  player_id TEXT NOT NULL REFERENCES players(id),
  source_revision INTEGER NOT NULL DEFAULT -1,
  result_json TEXT,
  next_check_at INTEGER,
  desired_role_id TEXT,
  applied_role_id TEXT,
  pending INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  PRIMARY KEY (guild_id, player_id)
);
--> statement-breakpoint
CREATE INDEX division_rank_states_due_idx ON division_rank_states(guild_id, next_check_at);
--> statement-breakpoint
CREATE INDEX division_rank_states_pending_idx ON division_rank_states(guild_id, pending, retry_at);
--> statement-breakpoint
CREATE TABLE season_peak_division_ranks (
  season_id TEXT NOT NULL REFERENCES seasons(id),
  player_id TEXT NOT NULL REFERENCES players(id),
  minimum INTEGER NOT NULL,
  achieved_at INTEGER NOT NULL,
  PRIMARY KEY (season_id, player_id)
);
--> statement-breakpoint
CREATE TRIGGER division_rank_event_insert AFTER INSERT ON player_rating_events
WHEN NEW.mode = 'global' AND EXISTS(SELECT 1 FROM division_rank_policies)
BEGIN
  INSERT OR IGNORE INTO division_quality_dirty(guild_id, player_id, match_id)
    SELECT guild_id, NEW.player_id, NEW.match_id FROM division_rank_policies;
  INSERT INTO division_rank_sources(player_id, revision) VALUES(NEW.player_id, 1)
    ON CONFLICT(player_id) DO UPDATE SET revision = revision + 1;
  INSERT INTO division_rank_states(guild_id, player_id, next_check_at)
    SELECT guild_id, NEW.player_id, 0 FROM division_rank_policies WHERE 1
    ON CONFLICT(guild_id, player_id) DO UPDATE SET next_check_at = 0;
END;
--> statement-breakpoint
CREATE TRIGGER division_rank_event_update AFTER UPDATE ON player_rating_events
WHEN (NEW.mode = 'global' OR OLD.mode = 'global') AND EXISTS(SELECT 1 FROM division_rank_policies)
BEGIN
  INSERT OR IGNORE INTO division_quality_dirty(guild_id, player_id, match_id)
    SELECT guild_id, OLD.player_id, OLD.match_id FROM division_rank_policies WHERE OLD.mode = 'global';
  INSERT INTO division_rank_sources(player_id, revision)
    SELECT OLD.player_id, 1 WHERE OLD.player_id != NEW.player_id
    ON CONFLICT(player_id) DO UPDATE SET revision = revision + 1;
  UPDATE division_rank_states SET next_check_at = 0 WHERE player_id = OLD.player_id;
  INSERT OR IGNORE INTO division_quality_dirty(guild_id, player_id, match_id)
    SELECT guild_id, NEW.player_id, NEW.match_id FROM division_rank_policies;
  INSERT INTO division_rank_sources(player_id, revision) VALUES(NEW.player_id, 1)
    ON CONFLICT(player_id) DO UPDATE SET revision = revision + 1;
  INSERT INTO division_rank_states(guild_id, player_id, next_check_at)
    SELECT guild_id, NEW.player_id, 0 FROM division_rank_policies WHERE 1
    ON CONFLICT(guild_id, player_id) DO UPDATE SET next_check_at = 0;
END;
--> statement-breakpoint
CREATE TRIGGER division_rank_event_delete AFTER DELETE ON player_rating_events
WHEN OLD.mode = 'global' AND EXISTS(SELECT 1 FROM division_rank_policies)
BEGIN
  INSERT OR IGNORE INTO division_quality_dirty(guild_id, player_id, match_id)
    SELECT guild_id, OLD.player_id, OLD.match_id FROM division_rank_policies;
  INSERT INTO division_rank_sources(player_id, revision) VALUES(OLD.player_id, 1)
    ON CONFLICT(player_id) DO UPDATE SET revision = revision + 1;
  UPDATE division_rank_states SET next_check_at = 0 WHERE player_id = OLD.player_id;
END;
--> statement-breakpoint
CREATE TRIGGER division_rank_match_status AFTER UPDATE OF status ON matches
WHEN NEW.status != OLD.status AND EXISTS(SELECT 1 FROM division_rank_policies)
BEGIN
  INSERT OR IGNORE INTO division_quality_dirty(guild_id, player_id, match_id)
    SELECT p.guild_id, e.player_id, e.match_id FROM division_rank_policies p JOIN player_rating_events e ON e.match_id = NEW.id AND e.mode = 'global';
  INSERT INTO division_rank_sources(player_id, revision)
    SELECT player_id, 1 FROM player_rating_events WHERE match_id = NEW.id AND mode = 'global'
    ON CONFLICT(player_id) DO UPDATE SET revision = revision + 1;
  UPDATE division_rank_states SET next_check_at = 0
    WHERE player_id IN (SELECT player_id FROM player_rating_events WHERE match_id = NEW.id AND mode = 'global');
END;
--> statement-breakpoint
CREATE TRIGGER division_rank_report_date_insert AFTER INSERT ON season_match_reports
WHEN EXISTS(SELECT 1 FROM division_rank_policies)
BEGIN
  INSERT OR IGNORE INTO division_quality_dirty(guild_id, player_id, match_id)
    SELECT p.guild_id, e.player_id, e.match_id FROM division_rank_policies p JOIN player_rating_events e ON e.match_id = NEW.match_id AND e.mode = 'global';
  INSERT INTO division_rank_sources(player_id, revision)
    SELECT player_id, 1 FROM player_rating_events WHERE match_id = NEW.match_id AND mode = 'global'
    ON CONFLICT(player_id) DO UPDATE SET revision = revision + 1;
  UPDATE division_rank_states SET next_check_at = 0
    WHERE player_id IN (SELECT player_id FROM player_rating_events WHERE match_id = NEW.match_id AND mode = 'global');
END;
--> statement-breakpoint
CREATE TRIGGER division_rank_report_date_update AFTER UPDATE OF accepted_at ON season_match_reports
WHEN NEW.accepted_at IS NOT OLD.accepted_at AND EXISTS(SELECT 1 FROM division_rank_policies)
BEGIN
  INSERT OR IGNORE INTO division_quality_dirty(guild_id, player_id, match_id)
    SELECT p.guild_id, e.player_id, e.match_id FROM division_rank_policies p JOIN player_rating_events e ON e.match_id = NEW.match_id AND e.mode = 'global';
  INSERT INTO division_rank_sources(player_id, revision)
    SELECT player_id, 1 FROM player_rating_events WHERE match_id = NEW.match_id AND mode = 'global'
    ON CONFLICT(player_id) DO UPDATE SET revision = revision + 1;
  UPDATE division_rank_states SET next_check_at = 0
    WHERE player_id IN (SELECT player_id FROM player_rating_events WHERE match_id = NEW.match_id AND mode = 'global');
END;
--> statement-breakpoint
CREATE TRIGGER division_rank_report_date_delete AFTER DELETE ON season_match_reports
WHEN EXISTS(SELECT 1 FROM division_rank_policies)
BEGIN
  INSERT OR IGNORE INTO division_quality_dirty(guild_id, player_id, match_id)
    SELECT p.guild_id, e.player_id, e.match_id FROM division_rank_policies p JOIN player_rating_events e ON e.match_id = OLD.match_id AND e.mode = 'global';
  INSERT INTO division_rank_sources(player_id, revision)
    SELECT player_id, 1 FROM player_rating_events WHERE match_id = OLD.match_id AND mode = 'global'
    ON CONFLICT(player_id) DO UPDATE SET revision = revision + 1;
  UPDATE division_rank_states SET next_check_at = 0
    WHERE player_id IN (SELECT player_id FROM player_rating_events WHERE match_id = OLD.match_id AND mode = 'global');
END;
