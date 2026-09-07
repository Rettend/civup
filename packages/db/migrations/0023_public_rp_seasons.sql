-- Single-server RP/season expansion. This does not require the archived multi-server migration.
ALTER TABLE seasons ADD reporting_deadline integer;
--> statement-breakpoint
ALTER TABLE seasons ADD finalized_at integer;
--> statement-breakpoint
ALTER TABLE seasons ADD rating_system text NOT NULL DEFAULT 'legacy' CHECK (rating_system IN ('legacy', 'rp'));
--> statement-breakpoint
ALTER TABLE seasons ADD reset_factor real NOT NULL DEFAULT 0.5 CHECK (reset_factor >= 0 AND reset_factor <= 1);
--> statement-breakpoint
ALTER TABLE seasons ADD preserve_evidence integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE seasons ADD public_reads_enabled integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE seasons ADD isolated_ratings_enabled integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE player_ratings ADD public_rating real CHECK (public_rating >= 0);
--> statement-breakpoint
ALTER TABLE player_rating_events ADD season_id text REFERENCES seasons(id);
--> statement-breakpoint
ALTER TABLE player_rating_events ADD public_sequence integer;
--> statement-breakpoint
ALTER TABLE player_rating_events ADD public_rating_before real CHECK (public_rating_before >= 0);
--> statement-breakpoint
ALTER TABLE player_rating_events ADD public_rating_after real CHECK (public_rating_after >= 0);
--> statement-breakpoint
ALTER TABLE player_rating_events ADD public_formula_version text;
--> statement-breakpoint
ALTER TABLE player_rating_events ADD public_calibration_version text;
--> statement-breakpoint
CREATE INDEX player_rating_events_season_chain_idx ON player_rating_events(season_id, player_id, mode, public_sequence);
--> statement-breakpoint
CREATE INDEX matches_season_created_idx ON matches(season_id, created_at, id);
--> statement-breakpoint
CREATE TABLE public_rating_calibrations (
  version text PRIMARY KEY NOT NULL,
  scope text NOT NULL,
  source_digest text NOT NULL,
  calibration text NOT NULL CHECK (json_valid(calibration)),
  created_at integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE public_rating_seeds (
  season_id text NOT NULL REFERENCES seasons(id),
  player_id text NOT NULL REFERENCES players(id),
  mode text NOT NULL,
  rating real NOT NULL CHECK (rating >= 0),
  hidden_mu real NOT NULL,
  hidden_sigma real NOT NULL CHECK (hidden_sigma > 0),
  source_mu real NOT NULL,
  source_sigma real NOT NULL CHECK (source_sigma > 0),
  source_hidden_score real NOT NULL,
  effective_at integer NOT NULL,
  last_played_at integer,
  source_season_id text REFERENCES seasons(id),
  formula_version text NOT NULL,
  calibration_version text NOT NULL REFERENCES public_rating_calibrations(version),
  seed_version text NOT NULL,
  closing_tier text,
  guard_reason text,
  evidence text NOT NULL CHECK (json_valid(evidence)),
  PRIMARY KEY (season_id, player_id, mode)
);
--> statement-breakpoint
CREATE TABLE season_rating_states (
  season_id text NOT NULL REFERENCES seasons(id),
  player_id text NOT NULL REFERENCES players(id),
  mode text NOT NULL,
  mu real NOT NULL,
  sigma real NOT NULL CHECK (sigma > 0),
  public_rating real CHECK (public_rating >= 0),
  managed_tier text,
  season_games integer NOT NULL DEFAULT 0 CHECK (season_games >= 0),
  season_wins integer NOT NULL DEFAULT 0 CHECK (season_wins >= 0),
  evidence text NOT NULL CHECK (json_valid(evidence)),
  last_played_at integer,
  revision integer NOT NULL DEFAULT 0,
  updated_at integer NOT NULL,
  PRIMARY KEY (season_id, player_id, mode)
);
--> statement-breakpoint
CREATE INDEX season_rating_states_mode_idx ON season_rating_states(season_id, mode);
--> statement-breakpoint
CREATE TABLE season_match_reports (
  sequence integer PRIMARY KEY AUTOINCREMENT,
  match_id text NOT NULL REFERENCES matches(id),
  season_id text NOT NULL REFERENCES seasons(id),
  accepted_at integer NOT NULL,
  opponent_tiers text NOT NULL DEFAULT '{}' CHECK (json_valid(opponent_tiers)),
  cancelled_at integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX season_match_reports_match_idx ON season_match_reports(match_id);
--> statement-breakpoint
CREATE INDEX season_match_reports_season_idx ON season_match_reports(season_id, sequence);
--> statement-breakpoint
CREATE TABLE season_rating_configurations (
  season_id text NOT NULL REFERENCES seasons(id),
  mode text NOT NULL,
  formula_version text NOT NULL,
  calibration_version text NOT NULL REFERENCES public_rating_calibrations(version),
  PRIMARY KEY (season_id, mode)
);
--> statement-breakpoint
CREATE TRIGGER season_rating_configurations_immutable_update BEFORE UPDATE ON season_rating_configurations
BEGIN SELECT RAISE(ABORT, 'Season rating configuration is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER season_rating_configurations_immutable_delete BEFORE DELETE ON season_rating_configurations
BEGIN SELECT RAISE(ABORT, 'Season rating configuration is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER public_rating_seeds_immutable_update BEFORE UPDATE ON public_rating_seeds
BEGIN SELECT RAISE(ABORT, 'Opening rating seeds are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER public_rating_seeds_immutable_delete BEFORE DELETE ON public_rating_seeds
BEGIN SELECT RAISE(ABORT, 'Opening rating seeds are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER public_rating_calibrations_immutable_update BEFORE UPDATE ON public_rating_calibrations
BEGIN SELECT RAISE(ABORT, 'Recorded calibrations are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER public_rating_calibrations_immutable_delete BEFORE DELETE ON public_rating_calibrations
BEGIN SELECT RAISE(ABORT, 'Recorded calibrations are immutable'); END;
