CREATE INDEX `session_directory_channel_phase_updated_at_idx` ON `session_directory` (`channel_id`,`phase`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `session_directory_mode_phase_created_at_idx` ON `session_directory` (`mode`,`phase`,`created_at`);
--> statement-breakpoint
CREATE INDEX `session_directory_host_phase_created_at_idx` ON `session_directory` (`host_id`,`phase`,`created_at`);
