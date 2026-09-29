CREATE TYPE "public"."share_link_kind" AS ENUM('view', 'upload');--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "kind" "share_link_kind" DEFAULT 'view' NOT NULL;--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "download_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "max_downloads" integer;--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "upload_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "upload_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "max_upload_bytes" bigint;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD COLUMN "link_id" uuid;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD CONSTRAINT "upload_sessions_link_id_share_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."share_links"("id") ON DELETE set null ON UPDATE no action;