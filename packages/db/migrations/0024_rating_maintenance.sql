CREATE TABLE rating_maintenance (
  id integer PRIMARY KEY CHECK (id = 1),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'buffering', 'draining')),
  generation integer NOT NULL DEFAULT 0,
  updated_at integer NOT NULL
);
--> statement-breakpoint
INSERT INTO rating_maintenance(id, state, generation, updated_at) VALUES (1, 'open', 0, 0);
--> statement-breakpoint
CREATE TABLE rating_mutation_leases (
  id text PRIMARY KEY NOT NULL,
  match_id text NOT NULL,
  generation integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('rating', 'buffer')),
  created_at integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE buffered_report_directory (
  match_id text PRIMARY KEY NOT NULL,
  report_id text NOT NULL,
  accepted_at integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX buffered_report_directory_accepted_idx ON buffered_report_directory(accepted_at, match_id);
