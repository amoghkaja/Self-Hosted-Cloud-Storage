CREATE TABLE "blob_texts" (
	"blob_id" uuid PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"words" "tsvector" GENERATED ALWAYS AS (strip(to_tsvector('simple'::regconfig, content))) STORED NOT NULL
);
--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "text_status" "stream_status" DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "blob_texts" ADD CONSTRAINT "blob_texts_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blob_texts_words_idx" ON "blob_texts" USING gin ("words");--> statement-breakpoint
-- Files already stored: the worker reads the words of those that are documents in the background
-- (and marks the rest 'none').
UPDATE "blobs" SET "text_status" = 'pending'
WHERE "id" IN (
  SELECT "blob_id" FROM "nodes"
  WHERE "blob_id" IS NOT NULL AND "size" > 0
    AND coalesce("mime_type", '') NOT LIKE 'image/%'
    AND coalesce("mime_type", '') NOT LIKE 'video/%'
    AND coalesce("mime_type", '') NOT LIKE 'audio/%'
);
