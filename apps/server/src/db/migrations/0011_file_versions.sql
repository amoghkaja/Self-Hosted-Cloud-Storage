CREATE TABLE "file_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"blob_id" uuid NOT NULL,
	"size" bigint NOT NULL,
	"mime_type" text,
	"modified_at" timestamp with time zone NOT NULL,
	"modified_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "modified_by" uuid;--> statement-breakpoint
ALTER TABLE "upload_sessions" ADD COLUMN "replace_existing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_blob_id_blobs_id_fk" FOREIGN KEY ("blob_id") REFERENCES "public"."blobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_modified_by_users_id_fk" FOREIGN KEY ("modified_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_versions_node_idx" ON "file_versions" USING btree ("node_id","created_at");--> statement-breakpoint
CREATE INDEX "file_versions_blob_idx" ON "file_versions" USING btree ("blob_id");--> statement-breakpoint
CREATE INDEX "file_versions_created_idx" ON "file_versions" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "nodes" ADD CONSTRAINT "nodes_modified_by_users_id_fk" FOREIGN KEY ("modified_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;