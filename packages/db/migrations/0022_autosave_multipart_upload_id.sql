ALTER TABLE `autosave_uploads` ADD `multipart_upload_id` text;
--> statement-breakpoint
ALTER TABLE `autosave_uploads` ADD `multipart_operation_id` text;
--> statement-breakpoint
ALTER TABLE `autosave_uploads` ADD `multipart_state_updated_at` integer;
--> statement-breakpoint
-- Pre-0022 non-uploaded rows have no persisted multipart id and cannot be recovered safely.
DELETE FROM `autosave_uploads` WHERE `status` <> 'uploaded';
--> statement-breakpoint
CREATE INDEX `autosave_uploads_cleanup_state_idx` ON `autosave_uploads` (`status`,`multipart_state_updated_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `autosave_uploads_active_uploader_idx` ON `autosave_uploads` (`uploader_user_id`)
WHERE `status` IN ('initializing','pending_upload','completing','cleanup_pending','cleaning');
--> statement-breakpoint
CREATE TRIGGER `autosave_uploads_object_count_quota_insert`
BEFORE INSERT ON `autosave_uploads`
WHEN (
  SELECT COUNT(*)
  FROM `autosave_uploads`
  WHERE `uploader_user_id` = NEW.`uploader_user_id`
) >= 100
BEGIN
  SELECT RAISE(ABORT, 'autosave_upload_count_quota_exceeded');
END;
--> statement-breakpoint
CREATE TRIGGER `autosave_uploads_object_count_quota_update`
BEFORE UPDATE OF `uploader_user_id` ON `autosave_uploads`
WHEN NEW.`uploader_user_id` <> OLD.`uploader_user_id`
  AND (
    SELECT COUNT(*)
    FROM `autosave_uploads`
    WHERE `uploader_user_id` = NEW.`uploader_user_id`
      AND `id` <> OLD.`id`
  ) >= 100
BEGIN
  SELECT RAISE(ABORT, 'autosave_upload_count_quota_exceeded');
END;
--> statement-breakpoint
CREATE TRIGGER `autosave_uploads_storage_quota_insert`
BEFORE INSERT ON `autosave_uploads`
WHEN COALESCE((
  SELECT SUM(`file_size_bytes`)
  FROM `autosave_uploads`
  WHERE `uploader_user_id` = NEW.`uploader_user_id`
), 0) + NEW.`file_size_bytes` > 2147483648
BEGIN
  SELECT RAISE(ABORT, 'autosave_upload_quota_exceeded');
END;
--> statement-breakpoint
CREATE TRIGGER `autosave_uploads_storage_quota_update`
BEFORE UPDATE OF `uploader_user_id`, `file_size_bytes` ON `autosave_uploads`
WHEN COALESCE((
  SELECT SUM(`file_size_bytes`)
  FROM `autosave_uploads`
  WHERE `uploader_user_id` = NEW.`uploader_user_id`
    AND `id` <> OLD.`id`
), 0) + NEW.`file_size_bytes` > 2147483648
BEGIN
  SELECT RAISE(ABORT, 'autosave_upload_quota_exceeded');
END;
