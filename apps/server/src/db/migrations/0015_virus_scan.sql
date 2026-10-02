CREATE TYPE "public"."scan_status" AS ENUM('pending', 'clean', 'infected', 'skipped');--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "scan_status" "scan_status" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "scan_signature" text;--> statement-breakpoint
CREATE INDEX "blobs_scan_idx" ON "blobs" USING btree ("scan_status") WHERE "blobs"."scan_status" IN ('pending', 'infected');