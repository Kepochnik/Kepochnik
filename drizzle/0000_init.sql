CREATE TABLE `achievements` (
	`key` text PRIMARY KEY NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`unlocked_at` integer,
	`revealed_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `app_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `bristol_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` integer NOT NULL,
	`local_day` text NOT NULL,
	`local_hour` integer NOT NULL,
	`tz_offset` integer NOT NULL,
	`type` integer NOT NULL,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_bristol_day` ON `bristol_entries` (`local_day`);--> statement-breakpoint
CREATE INDEX `idx_bristol_live` ON `bristol_entries` (`deleted_at`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `daily_logs` (
	`local_day` text PRIMARY KEY NOT NULL,
	`bloating` integer,
	`pain` integer,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `gas_events` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` integer NOT NULL,
	`local_day` text NOT NULL,
	`local_hour` integer NOT NULL,
	`local_dow` integer NOT NULL,
	`tz_offset` integer NOT NULL,
	`source` text DEFAULT 'app' NOT NULL,
	`volume` text,
	`smell` text,
	`context` text,
	`note` text,
	`suspect` integer DEFAULT false NOT NULL,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_events_day` ON `gas_events` (`local_day`);--> statement-breakpoint
CREATE INDEX `idx_events_occurred` ON `gas_events` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_events_live` ON `gas_events` (`deleted_at`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_events_hour` ON `gas_events` (`deleted_at`,`local_hour`);--> statement-breakpoint
CREATE INDEX `idx_events_dow` ON `gas_events` (`deleted_at`,`local_dow`);--> statement-breakpoint
CREATE TABLE `leaderboard_outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_outbox_due` ON `leaderboard_outbox` (`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `meal_triggers` (
	`meal_id` text NOT NULL,
	`trigger` text NOT NULL,
	PRIMARY KEY(`meal_id`, `trigger`),
	FOREIGN KEY (`meal_id`) REFERENCES `meals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_meal_triggers_trigger` ON `meal_triggers` (`trigger`);--> statement-breakpoint
CREATE TABLE `meals` (
	`id` text PRIMARY KEY NOT NULL,
	`occurred_at` integer NOT NULL,
	`local_day` text NOT NULL,
	`local_hour` integer NOT NULL,
	`tz_offset` integer NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`note` text,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_meals_day` ON `meals` (`local_day`);--> statement-breakpoint
CREATE INDEX `idx_meals_live` ON `meals` (`deleted_at`,`occurred_at`);