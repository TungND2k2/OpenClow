CREATE TABLE `agent_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`system_prompt` text NOT NULL,
	`capabilities` text DEFAULT '[]' NOT NULL,
	`tools` text DEFAULT '[]' NOT NULL,
	`engine` text DEFAULT 'fast-api' NOT NULL,
	`max_concurrent_tasks` integer DEFAULT 1 NOT NULL,
	`max_tool_loops` integer DEFAULT 5 NOT NULL,
	`cost_budget_usd` real,
	`auto_spawn` integer DEFAULT 0 NOT NULL,
	`auto_spawn_count` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_templates_name_unique` ON `agent_templates` (`name`);--> statement-breakpoint
CREATE INDEX `idx_templates_role` ON `agent_templates` (`role`);--> statement-breakpoint
CREATE INDEX `idx_templates_status` ON `agent_templates` (`status`);--> statement-breakpoint
ALTER TABLE `agents` ADD `template_id` text REFERENCES agent_templates(id);--> statement-breakpoint
CREATE INDEX `idx_agents_template` ON `agents` (`template_id`);