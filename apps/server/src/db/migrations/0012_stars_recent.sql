CREATE TABLE "stars" (
	"user_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stars_user_id_node_id_pk" PRIMARY KEY("user_id","node_id")
);
--> statement-breakpoint
ALTER TABLE "stars" ADD CONSTRAINT "stars_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stars" ADD CONSTRAINT "stars_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stars_node_idx" ON "stars" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "nodes_owner_recent_idx" ON "nodes" USING btree ("owner_id","updated_at" DESC NULLS LAST) WHERE "nodes"."deleted_at" IS NULL AND "nodes"."type" = 'file';