CREATE TABLE `agent_hierarchy` (
	`ancestor_id` text NOT NULL,
	`descendant_id` text NOT NULL,
	`depth` integer NOT NULL,
	PRIMARY KEY(`ancestor_id`, `descendant_id`),
	FOREIGN KEY (`ancestor_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`descendant_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_hierarchy_descendant` ON `agent_hierarchy` (`descendant_id`);--> statement-breakpoint
CREATE INDEX `idx_hierarchy_depth` ON `agent_hierarchy` (`depth`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`authority_level` integer NOT NULL,
	`capabilities` text DEFAULT '[]' NOT NULL,
	`parent_agent_id` text,
	`status` text DEFAULT 'registering' NOT NULL,
	`performance_score` real DEFAULT 0.5 NOT NULL,
	`tasks_completed` integer DEFAULT 0 NOT NULL,
	`tasks_failed` integer DEFAULT 0 NOT NULL,
	`max_concurrent_tasks` integer DEFAULT 1 NOT NULL,
	`cost_budget_usd` real,
	`cost_spent_usd` real DEFAULT 0 NOT NULL,
	`config` text DEFAULT '{}',
	`last_heartbeat` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`parent_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_agents_status` ON `agents` (`status`);--> statement-breakpoint
CREATE INDEX `idx_agents_role` ON `agents` (`role`);--> statement-breakpoint
CREATE INDEX `idx_agents_parent` ON `agents` (`parent_agent_id`);--> statement-breakpoint
CREATE TABLE `knowledge_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`knowledge_id` text NOT NULL,
	`task_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`was_helpful` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`knowledge_id`) REFERENCES `knowledge_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_knowledge_apps_knowledge` ON `knowledge_applications` (`knowledge_id`);--> statement-breakpoint
CREATE INDEX `idx_knowledge_apps_task` ON `knowledge_applications` (`task_id`);--> statement-breakpoint
CREATE TABLE `knowledge_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`domain` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`source_task_id` text,
	`source_agent_id` text NOT NULL,
	`scope` text NOT NULL,
	`relevance_score` real DEFAULT 0.5 NOT NULL,
	`confidence` real DEFAULT 0.5 NOT NULL,
	`usage_count` integer DEFAULT 0 NOT NULL,
	`upvotes` integer DEFAULT 0 NOT NULL,
	`downvotes` integer DEFAULT 0 NOT NULL,
	`outcome` text,
	`context_snapshot` text,
	`superseded_by_id` text,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`source_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`superseded_by_id`) REFERENCES `knowledge_entries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_knowledge_domain` ON `knowledge_entries` (`domain`);--> statement-breakpoint
CREATE INDEX `idx_knowledge_scope` ON `knowledge_entries` (`scope`);--> statement-breakpoint
CREATE INDEX `idx_knowledge_type` ON `knowledge_entries` (`type`);--> statement-breakpoint
CREATE INDEX `idx_knowledge_source_agent` ON `knowledge_entries` (`source_agent_id`);--> statement-breakpoint
CREATE TABLE `knowledge_votes` (
	`id` text PRIMARY KEY NOT NULL,
	`knowledge_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`vote` integer NOT NULL,
	`comment` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`knowledge_id`) REFERENCES `knowledge_entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_knowledge_votes_unique` ON `knowledge_votes` (`knowledge_id`,`agent_id`);--> statement-breakpoint
CREATE TABLE `notebooks` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`content_type` text DEFAULT 'text/plain' NOT NULL,
	`created_by_agent_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_notebooks_ns_key` ON `notebooks` (`namespace`,`key`);--> statement-breakpoint
CREATE INDEX `idx_notebooks_namespace` ON `notebooks` (`namespace`);--> statement-breakpoint
CREATE TABLE `token_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`task_id` text,
	`model` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cost_usd` real NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_token_usage_agent` ON `token_usage` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_token_usage_task` ON `token_usage` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_token_usage_created` ON `token_usage` (`created_at`);--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`decision_type` text NOT NULL,
	`task_id` text,
	`target_agent_id` text,
	`reasoning` text NOT NULL,
	`input_context` text,
	`outcome` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_decisions_agent` ON `decisions` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_decisions_task` ON `decisions` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_decisions_type` ON `decisions` (`decision_type`);--> statement-breakpoint
CREATE INDEX `idx_decisions_created` ON `decisions` (`created_at`);--> statement-breakpoint
CREATE TABLE `execution_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`root_task_id` text NOT NULL,
	`created_by_agent_id` text NOT NULL,
	`strategy` text NOT NULL,
	`plan_graph` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`root_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_exec_plans_root_task` ON `execution_plans` (`root_task_id`);--> statement-breakpoint
CREATE INDEX `idx_exec_plans_status` ON `execution_plans` (`status`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`from_agent_id` text NOT NULL,
	`to_agent_id` text,
	`task_id` text,
	`priority` integer DEFAULT 3 NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	`acknowledged_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_messages_to_agent_status` ON `messages` (`to_agent_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_messages_task` ON `messages` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_created` ON `messages` (`created_at`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`file_name` text NOT NULL,
	`file_size` integer NOT NULL,
	`mime_type` text NOT NULL,
	`s3_key` text NOT NULL,
	`s3_url` text,
	`uploaded_by` text NOT NULL,
	`channel` text NOT NULL,
	`task_id` text,
	`workflow_instance_id` text,
	`metadata` text DEFAULT '{}',
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_files_tenant` ON `files` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_files_uploaded_by` ON `files` (`uploaded_by`);--> statement-breakpoint
CREATE INDEX `idx_files_task` ON `files` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_files_created` ON `files` (`created_at`);--> statement-breakpoint
CREATE TABLE `task_dependencies` (
	`task_id` text NOT NULL,
	`depends_on_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	PRIMARY KEY(`task_id`, `depends_on_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`depends_on_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_task_deps_depends_on` ON `task_dependencies` (`depends_on_id`);--> statement-breakpoint
CREATE TABLE `task_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`level` text NOT NULL,
	`message` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_task_logs_task` ON `task_logs` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_task_logs_agent` ON `task_logs` (`agent_id`);--> statement-breakpoint
CREATE INDEX `idx_task_logs_created` ON `task_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`priority` integer DEFAULT 3 NOT NULL,
	`urgency` integer DEFAULT 3 NOT NULL,
	`assigned_agent_id` text,
	`created_by_agent_id` text,
	`delegated_by_agent_id` text,
	`parent_task_id` text,
	`execution_strategy` text,
	`dependency_ids` text DEFAULT '[]',
	`depth` integer DEFAULT 0 NOT NULL,
	`max_depth` integer DEFAULT 5 NOT NULL,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`max_retries` integer DEFAULT 3 NOT NULL,
	`escalation_agent_id` text,
	`required_capabilities` text DEFAULT '[]',
	`estimated_duration_ms` integer,
	`cost_budget_usd` real,
	`cost_spent_usd` real DEFAULT 0 NOT NULL,
	`tags` text DEFAULT '[]',
	`result` text,
	`error` text,
	`created_at` integer NOT NULL,
	`assigned_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`deadline` integer,
	FOREIGN KEY (`assigned_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`escalation_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_status` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_assigned_agent` ON `tasks` (`assigned_agent_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_parent` ON `tasks` (`parent_task_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_priority_urgency` ON `tasks` (`priority`,`urgency`);--> statement-breakpoint
CREATE INDEX `idx_tasks_created_by` ON `tasks` (`created_by_agent_id`);--> statement-breakpoint
CREATE TABLE `tenant_users` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`channel` text NOT NULL,
	`channel_user_id` text NOT NULL,
	`display_name` text,
	`role` text DEFAULT 'user' NOT NULL,
	`permissions` text DEFAULT '[]',
	`is_active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tenant_users_channel_user` ON `tenant_users` (`tenant_id`,`channel`,`channel_user_id`);--> statement-breakpoint
CREATE INDEX `idx_tenant_users_tenant` ON `tenant_users` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_tenant_users_role` ON `tenant_users` (`role`);--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`ai_config` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_tenants_status` ON `tenants` (`status`);--> statement-breakpoint
CREATE TABLE `business_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`domain` text,
	`rule_type` text NOT NULL,
	`conditions` text NOT NULL,
	`actions` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_business_rules_tenant` ON `business_rules` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_business_rules_domain` ON `business_rules` (`domain`);--> statement-breakpoint
CREATE INDEX `idx_business_rules_type` ON `business_rules` (`rule_type`);--> statement-breakpoint
CREATE TABLE `conversation_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`channel` text NOT NULL,
	`channel_user_id` text NOT NULL,
	`user_name` text,
	`user_role` text,
	`active_instance_id` text,
	`state` text DEFAULT '{}' NOT NULL,
	`last_message_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`active_instance_id`) REFERENCES `workflow_instances`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_conv_sessions_tenant` ON `conversation_sessions` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_conv_sessions_channel_user` ON `conversation_sessions` (`channel`,`channel_user_id`);--> statement-breakpoint
CREATE INDEX `idx_conv_sessions_active_instance` ON `conversation_sessions` (`active_instance_id`);--> statement-breakpoint
CREATE TABLE `form_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`schema` text NOT NULL,
	`ui_hints` text,
	`version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_form_templates_tenant` ON `form_templates` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`config` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_integrations_tenant` ON `integrations` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_integrations_type` ON `integrations` (`type`);--> statement-breakpoint
CREATE TABLE `workflow_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`instance_id` text NOT NULL,
	`stage_id` text NOT NULL,
	`approver_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`decision_reason` text,
	`auto_approved_by_rule_id` text,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`instance_id`) REFERENCES `workflow_instances`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`auto_approved_by_rule_id`) REFERENCES `business_rules`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_wf_approvals_instance` ON `workflow_approvals` (`instance_id`);--> statement-breakpoint
CREATE INDEX `idx_wf_approvals_approver` ON `workflow_approvals` (`approver_id`);--> statement-breakpoint
CREATE INDEX `idx_wf_approvals_status` ON `workflow_approvals` (`status`);--> statement-breakpoint
CREATE TABLE `workflow_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`initiated_by` text NOT NULL,
	`current_stage_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`form_data` text DEFAULT '{}' NOT NULL,
	`context_data` text DEFAULT '{}' NOT NULL,
	`task_id` text,
	`conversation_id` text,
	`channel` text,
	`history` text DEFAULT '[]' NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`template_id`) REFERENCES `workflow_templates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_wf_instances_template` ON `workflow_instances` (`template_id`);--> statement-breakpoint
CREATE INDEX `idx_wf_instances_tenant` ON `workflow_instances` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_wf_instances_status` ON `workflow_instances` (`status`);--> statement-breakpoint
CREATE INDEX `idx_wf_instances_task` ON `workflow_instances` (`task_id`);--> statement-breakpoint
CREATE TABLE `workflow_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`domain` text,
	`version` integer DEFAULT 1 NOT NULL,
	`stages` text NOT NULL,
	`trigger_config` text,
	`config` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_wf_templates_tenant_name_ver` ON `workflow_templates` (`tenant_id`,`name`,`version`);--> statement-breakpoint
CREATE INDEX `idx_wf_templates_tenant` ON `workflow_templates` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_wf_templates_domain` ON `workflow_templates` (`domain`);