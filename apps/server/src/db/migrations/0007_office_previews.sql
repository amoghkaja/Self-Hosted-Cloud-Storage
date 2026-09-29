ALTER TABLE "blobs" ADD COLUMN "preview_status" "stream_status" DEFAULT 'none' NOT NULL;--> statement-breakpoint
-- Existing Office documents get previews (and first-page thumbnails) too.
UPDATE "blobs" SET "preview_status" = 'pending', "thumb_status" = 'pending'
WHERE "id" IN (
  SELECT "blob_id" FROM "nodes" WHERE "blob_id" IS NOT NULL AND (
    "mime_type" LIKE '%wordprocessingml%' OR "mime_type" LIKE '%spreadsheetml%'
    OR "mime_type" LIKE '%presentationml%' OR "mime_type" LIKE 'application/vnd.oasis.opendocument.%'
    OR "mime_type" IN ('application/msword', 'application/vnd.ms-excel',
                       'application/vnd.ms-powerpoint', 'application/rtf')
  )
);
