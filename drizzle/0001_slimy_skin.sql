CREATE TABLE `reachability_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`request_key` text NOT NULL,
	`provider_job_id` text,
	`status` text NOT NULL,
	`latitude` real NOT NULL,
	`longitude` real NOT NULL,
	`duration_minutes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reachability_jobs_request_key` ON `reachability_jobs` (`request_key`);--> statement-breakpoint
CREATE INDEX `idx_reachability_jobs_expires_at` ON `reachability_jobs` (`expires_at`);