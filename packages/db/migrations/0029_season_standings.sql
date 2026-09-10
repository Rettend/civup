ALTER TABLE seasons ADD COLUMN standings_revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE season_standing_snapshots (
  season_id TEXT PRIMARY KEY NOT NULL REFERENCES seasons(id),
  revision INTEGER NOT NULL,
  version INTEGER NOT NULL,
  finalized_at INTEGER,
  payload TEXT NOT NULL
);

CREATE TRIGGER season_standings_metadata AFTER UPDATE OF active, finalized_at, rating_system, public_reads_enabled ON seasons
WHEN OLD.active IS NOT NEW.active OR OLD.finalized_at IS NOT NEW.finalized_at OR OLD.rating_system IS NOT NEW.rating_system OR OLD.public_reads_enabled IS NOT NEW.public_reads_enabled
BEGIN
  UPDATE seasons SET standings_revision = standings_revision + 1 WHERE id = NEW.id;
END;

CREATE TRIGGER season_standings_rating_insert AFTER INSERT ON season_rating_states BEGIN
  UPDATE seasons SET standings_revision = standings_revision + 1 WHERE id = NEW.season_id AND active = 0;
END;
CREATE TRIGGER season_standings_rating_update AFTER UPDATE ON season_rating_states BEGIN
  UPDATE seasons SET standings_revision = standings_revision + 1 WHERE id IN (OLD.season_id, NEW.season_id) AND active = 0;
END;
CREATE TRIGGER season_standings_rating_delete AFTER DELETE ON season_rating_states BEGIN
  UPDATE seasons SET standings_revision = standings_revision + 1 WHERE id = OLD.season_id AND active = 0;
END;

CREATE TRIGGER season_standings_peak_insert AFTER INSERT ON season_peak_ranks BEGIN
  UPDATE seasons SET standings_revision = standings_revision + 1 WHERE id = NEW.season_id AND active = 0;
END;
CREATE TRIGGER season_standings_peak_update AFTER UPDATE ON season_peak_ranks BEGIN
  UPDATE seasons SET standings_revision = standings_revision + 1 WHERE id IN (OLD.season_id, NEW.season_id) AND active = 0;
END;
CREATE TRIGGER season_standings_peak_delete AFTER DELETE ON season_peak_ranks BEGIN
  UPDATE seasons SET standings_revision = standings_revision + 1 WHERE id = OLD.season_id AND active = 0;
END;

CREATE TRIGGER season_standings_mode_peak_insert AFTER INSERT ON season_peak_mode_ranks BEGIN
  UPDATE seasons SET standings_revision = standings_revision + 1 WHERE id = NEW.season_id AND active = 0;
END;
CREATE TRIGGER season_standings_mode_peak_update AFTER UPDATE ON season_peak_mode_ranks BEGIN
  UPDATE seasons SET standings_revision = standings_revision + 1 WHERE id IN (OLD.season_id, NEW.season_id) AND active = 0;
END;
CREATE TRIGGER season_standings_mode_peak_delete AFTER DELETE ON season_peak_mode_ranks BEGIN
  UPDATE seasons SET standings_revision = standings_revision + 1 WHERE id = OLD.season_id AND active = 0;
END;

CREATE TRIGGER season_standings_division_peak_insert AFTER INSERT ON season_peak_division_ranks BEGIN
  UPDATE seasons SET standings_revision = standings_revision + 1 WHERE id = NEW.season_id AND active = 0;
END;
CREATE TRIGGER season_standings_division_peak_update AFTER UPDATE ON season_peak_division_ranks BEGIN
  UPDATE seasons SET standings_revision = standings_revision + 1 WHERE id IN (OLD.season_id, NEW.season_id) AND active = 0;
END;
CREATE TRIGGER season_standings_division_peak_delete AFTER DELETE ON season_peak_division_ranks BEGIN
  UPDATE seasons SET standings_revision = standings_revision + 1 WHERE id = OLD.season_id AND active = 0;
END;
