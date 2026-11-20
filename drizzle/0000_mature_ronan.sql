CREATE TABLE `room_presence` (
	`member_id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`last_seen_at` integer NOT NULL,
	`left_at` integer
);
--> statement-breakpoint
CREATE INDEX `room_presence_room_idx` ON `room_presence` (`room_id`);--> statement-breakpoint
CREATE TABLE `room_signals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`room_id` text NOT NULL,
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`kind` text NOT NULL,
	`call_id` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `room_signals_recipient_idx` ON `room_signals` (`room_id`,`to_id`,`id`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`revision` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
