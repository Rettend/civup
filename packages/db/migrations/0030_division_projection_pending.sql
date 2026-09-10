ALTER TABLE division_rank_states ADD COLUMN projection_pending INTEGER NOT NULL DEFAULT 0;
CREATE INDEX division_rank_states_projection_idx ON division_rank_states(guild_id, projection_pending);
