CREATE TYPE "public"."node_type" AS ENUM('folder', 'file');--> statement-breakpoint
CREATE TYPE "public"."share_permission" AS ENUM('view', 'edit');--> statement-breakpoint
CREATE TYPE "public"."thumb_status" AS ENUM('none', 'pending', 'ready', 'failed', 'unsupported');--> statement-breakpoint
CREATE TYPE "public"."upload_status" AS ENUM('uploading', 'finalizing', 'completed', 'aborted', 'expired');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'member');--> statement-breakpoint
CREATE TYPE "public"."volume_status" AS ENUM('active', 'draining', 'readonly', 'retired');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"ip" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "blobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"volume_id" uuid NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text,
	"thumb_status" "thumb_status" DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text,
	"role" "user_role" DEFAULT 'member' NOT NULL,
	"quota_bytes" bigint,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nodes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"parent_id" uuid,
	"type" "node_type" NOT NULL,
	"name" text NOT NULL,
	"blob_id" uuid,
	"size" bigint DEFAULT 0 NOT NULL,
	"mime_type" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"trash_root_id" uuid
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "share_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"token_enc" text NOT NULL,
	"password_hash" text,
	"allow_download" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_accessed_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shares" (
	"id" uuid PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"grantee_id" uuid NOT NULL,
	"permission" "share_permission" NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "storage_volumes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"status" "volume_status" DEFAULT 'active' NOT NULL,
	"capacity_limit_bytes" bigint,
	"reserve_bytes" bigint DEFAULT 0 NOT NULL,
	"status_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upload_chunks" (
	"upload_id" uuid NOT NULL,
	"idx" integer NOT NULL,
	CONSTRAINT "upload_chunks_upload_id_idx_pk" PRIMARY KEY("upload_id","idx")
);
--> statement-breakpoint
CREATE TABLE "upload_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"charge_user_id" uuid NOT NULL,
	"parent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"size" bigint NOT NULL,
	"mime_type" text NOT NULL,
	"chunk_size" integer NOT NULL,
	"total_chunks" integer NOT NULL,
	"received_count" integer DEFAULT 0 NOT NULL,
	"volume_id" uuid NOT NULL,
	"blob_id" uuid NOT NULL,
	"node_id" uuid,
	"status" "upload_status" DEFAULT 'uploading' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'member' NOT NULL,
	"quota_bytes" bigint,
	"used_bytes" bigint DEFAULT 0 NOT NULL,
	"reserved_bytes" bigint DEFAULT 0 NOT NULL,
	"root_node_id" uuid,
	"totp_secret_enc" text,
	"totp_enabled" boolean DEFAULT false NOT NULL,
	"totp_last_step" bigint,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_usage_nonneg" CHECK ("users"."used_bytes" >= 0 AND "users"."reserved_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blobs" ADD CONSTRAINT "blobs_volume_id_storage_volumes_id_fk" FOREIGN KEY ("volume_id") REFERENCES "public"."storage_volumes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_used_by_users_id_fk" FOREIGN KEY ("used_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_parent_id_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_grantee_id_users_id_fk" FOREIGN KEY ("grantee_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_chunks" ADD CONSTRAINT "upload_chunks_upload_id_upload_sessions_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."upload_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_charge_user_id_users_id_fk" FOREIGN KEY ("charge_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_volume_id_storage_volumes_id_fk" FOREIGN KEY ("volume_id") REFERENCES "public"."storage_volumes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "blobs_volume_idx" ON "blobs" USING btree ("volume_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invites_token_hash_key" ON "invites" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_parent_name_key" ON "nodes" USING btree ("parent_id",lower("name")) WHERE "nodes"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "nodes_owner_root_key" ON "nodes" USING btree ("owner_id") WHERE "nodes"."parent_id" IS NULL;--> statement-breakpoint
CREATE INDEX "nodes_children_idx" ON "nodes" USING btree ("parent_id","type",lower("name"),"id") WHERE "nodes"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "nodes_trash_root_idx" ON "nodes" USING btree ("trash_root_id");--> statement-breakpoint
CREATE INDEX "nodes_owner_deleted_idx" ON "nodes" USING btree ("owner_id","deleted_at");--> statement-breakpoint
CREATE INDEX "nodes_blob_idx" ON "nodes" USING btree ("blob_id");--> statement-breakpoint
CREATE INDEX "nodes_name_trgm_idx" ON "nodes" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "share_links_token_hash_key" ON "share_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "share_links_node_idx" ON "share_links" USING btree ("node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shares_node_grantee_key" ON "shares" USING btree ("node_id","grantee_id");--> statement-breakpoint
CREATE INDEX "shares_grantee_idx" ON "shares" USING btree ("grantee_id");--> statement-breakpoint
CREATE UNIQUE INDEX "storage_volumes_path_key" ON "storage_volumes" USING btree ("path");--> statement-breakpoint
CREATE INDEX "upload_sessions_user_status_idx" ON "upload_sessions" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "upload_sessions_status_expires_idx" ON "upload_sessions" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");