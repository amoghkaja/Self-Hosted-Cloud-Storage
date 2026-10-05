ALTER TABLE "blobs" ADD COLUMN "info_status" "stream_status" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "taken_at" timestamp;--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "latitude" double precision;--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "longitude" double precision;--> statement-breakpoint
-- Photos and videos already stored: the worker reads their dates and places in the background.
UPDATE "blobs" SET "info_status" = 'pending'
WHERE "id" IN (
  SELECT "blob_id" FROM "nodes"
  WHERE "blob_id" IS NOT NULL AND ("mime_type" LIKE 'image/%' OR "mime_type" LIKE 'video/%')
);
