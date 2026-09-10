CREATE INDEX division_rank_states_player_idx ON division_rank_states(player_id);
CREATE INDEX division_rank_states_retry_idx ON division_rank_states(guild_id, retry_at, next_check_at);
