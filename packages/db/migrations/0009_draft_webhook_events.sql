CREATE TABLE `processed_draft_webhook_events` (
	`event_id` text PRIMARY KEY NOT NULL,
	`match_id` text NOT NULL,
	`outcome` text NOT NULL,
	`event_kind` text NOT NULL,
	`event_sequence` integer,
	`claimed_at` integer NOT NULL,
	`processed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `processed_draft_webhook_events_match_id_idx` ON `processed_draft_webhook_events` (`match_id`);
--> statement-breakpoint
CREATE INDEX `processed_draft_webhook_events_processed_at_idx` ON `processed_draft_webhook_events` (`processed_at`);
