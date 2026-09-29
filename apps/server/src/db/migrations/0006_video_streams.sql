CREATE TYPE "public"."stream_status" AS ENUM('none', 'pending', 'ready', 'original', 'failed');--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "stream_status" "stream_status" DEFAULT 'none' NOT NULL;--> statement-breakpoint
-- Existing videos get streaming copies too: the worker picks up 'pending' ones on start.
UPDATE "blobs" SET "stream_status" = 'pending'
WHERE "id" IN (SELECT "blob_id" FROM "nodes" WHERE "mime_type" LIKE 'video/%' AND "blob_id" IS NOT NULL);
