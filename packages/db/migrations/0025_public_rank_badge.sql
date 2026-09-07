ALTER TABLE player_ratings ADD COLUMN public_badge integer CHECK (public_badge IN (0, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500));
--> statement-breakpoint
ALTER TABLE season_rating_states ADD COLUMN public_badge integer CHECK (public_badge IN (0, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500));
