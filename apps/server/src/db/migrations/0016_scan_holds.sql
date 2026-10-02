ALTER TYPE "public"."scan_status" ADD VALUE 'held';--> statement-breakpoint
ALTER TYPE "public"."scan_status" ADD VALUE 'allowed';--> statement-breakpoint
ALTER TABLE "blobs" ADD COLUMN "scanned_at" timestamp with time zone;