CREATE TABLE civ_release_projections (
  id TEXT PRIMARY KEY NOT NULL,
  config TEXT NOT NULL,
  cursor TEXT NOT NULL DEFAULT '',
  initialized INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  live_count INTEGER NOT NULL DEFAULT 0,
  aggregates TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE civ_release_members (
  release_id TEXT NOT NULL,
  match_id TEXT NOT NULL,
  source TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  contribution TEXT NOT NULL,
  selected INTEGER NOT NULL,
  PRIMARY KEY(release_id, match_id)
);
CREATE INDEX civ_release_members_sample_idx ON civ_release_members(release_id, source, completed_at, match_id);
CREATE TABLE civ_release_dirty (
  release_id TEXT NOT NULL,
  match_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(release_id, match_id)
);
CREATE TRIGGER civ_release_insert AFTER INSERT ON match_civ_stat_contributions BEGIN
  INSERT INTO civ_release_dirty(release_id, match_id) SELECT id, NEW.match_id FROM civ_release_projections WHERE true
    ON CONFLICT(release_id, match_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER civ_release_update AFTER UPDATE ON match_civ_stat_contributions
WHEN OLD.completed_match_count IS NOT NEW.completed_match_count OR OLD.contributions_json IS NOT NEW.contributions_json
  OR OLD.source IS NOT NEW.source OR OLD.mode_scope IS NOT NEW.mode_scope OR OLD.completed_at IS NOT NEW.completed_at
  OR OLD.visible IS NOT NEW.visible BEGIN
  INSERT INTO civ_release_dirty(release_id, match_id) SELECT id, NEW.match_id FROM civ_release_projections WHERE true
    ON CONFLICT(release_id, match_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER civ_release_delete AFTER DELETE ON match_civ_stat_contributions BEGIN
  INSERT INTO civ_release_dirty(release_id, match_id) SELECT id, OLD.match_id FROM civ_release_projections WHERE true
    ON CONFLICT(release_id, match_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER civ_release_match_update AFTER UPDATE OF status, created_at, draft_data ON matches
WHEN (OLD.status IS NOT NEW.status OR OLD.created_at IS NOT NEW.created_at OR OLD.draft_data IS NOT NEW.draft_data)
  AND EXISTS(SELECT 1 FROM match_civ_stat_contributions WHERE match_id=NEW.id) BEGIN
  INSERT INTO civ_release_dirty(release_id, match_id) SELECT id, NEW.id FROM civ_release_projections WHERE true
    ON CONFLICT(release_id, match_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER civ_release_tournament_insert AFTER INSERT ON tournament_matches BEGIN
  INSERT INTO civ_release_dirty(release_id, match_id) SELECT id, NEW.match_id FROM civ_release_projections WHERE NEW.match_id IS NOT NULL
    ON CONFLICT(release_id, match_id) DO UPDATE SET revision=revision+1;
  INSERT INTO civ_release_dirty(release_id, match_id) SELECT id, NEW.session_id FROM civ_release_projections WHERE NEW.session_id IS NOT NULL
    ON CONFLICT(release_id, match_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER civ_release_tournament_delete AFTER DELETE ON tournament_matches BEGIN
  INSERT INTO civ_release_dirty(release_id, match_id) SELECT id, OLD.match_id FROM civ_release_projections WHERE OLD.match_id IS NOT NULL
    ON CONFLICT(release_id, match_id) DO UPDATE SET revision=revision+1;
  INSERT INTO civ_release_dirty(release_id, match_id) SELECT id, OLD.session_id FROM civ_release_projections WHERE OLD.session_id IS NOT NULL
    ON CONFLICT(release_id, match_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER civ_release_tournament_update AFTER UPDATE OF match_id, session_id ON tournament_matches BEGIN
  INSERT INTO civ_release_dirty(release_id, match_id)
    SELECT p.id, j.value FROM civ_release_projections p, json_each(json_array(OLD.match_id, OLD.session_id, NEW.match_id, NEW.session_id)) j WHERE j.value IS NOT NULL
    ON CONFLICT(release_id, match_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER civ_release_match_delete BEFORE DELETE ON matches BEGIN
  INSERT INTO civ_release_dirty(release_id, match_id) SELECT id, OLD.id FROM civ_release_projections WHERE true
    ON CONFLICT(release_id, match_id) DO UPDATE SET revision=revision+1;
END;
-- Wake all scopes even when eligibility changes outside the report projection path.
CREATE TRIGGER civ_release_dirty_insert AFTER INSERT ON civ_release_dirty BEGIN
  INSERT INTO leaderboard_dirty_states(scope, dirty_at, reason)
    SELECT value, cast(unixepoch('subsec')*1000 AS INTEGER), 'release-contribution' FROM json_each('["civ:all","civ:duel","civ:duo","civ:squad"]') WHERE true
    ON CONFLICT(scope) DO UPDATE SET dirty_at=max(dirty_at,excluded.dirty_at), reason=excluded.reason;
END;
CREATE TRIGGER civ_release_dirty_update AFTER UPDATE ON civ_release_dirty BEGIN
  INSERT INTO leaderboard_dirty_states(scope, dirty_at, reason)
    SELECT value, cast(unixepoch('subsec')*1000 AS INTEGER), 'release-contribution' FROM json_each('["civ:all","civ:duel","civ:duo","civ:squad"]') WHERE true
    ON CONFLICT(scope) DO UPDATE SET dirty_at=max(dirty_at,excluded.dirty_at), reason=excluded.reason;
END;
