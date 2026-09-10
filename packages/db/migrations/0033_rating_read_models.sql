CREATE TABLE season_rating_checkpoints (
  season_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  match_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  from_history INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(season_id, sequence, player_id, mode)
);
CREATE TABLE season_checkpoint_initializations (
  season_id TEXT NOT NULL, player_id TEXT NOT NULL, mode TEXT NOT NULL,
  sequence INTEGER NOT NULL, summary TEXT NOT NULL, source_revision INTEGER NOT NULL, complete INTEGER NOT NULL,
  PRIMARY KEY(season_id, player_id, mode)
);
CREATE TABLE division_quality_initializations (
  guild_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  cursor TEXT NOT NULL DEFAULT '',
  recent TEXT NOT NULL,
  resetting INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(guild_id, player_id)
);
