CREATE TABLE "photo_comments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "photo_hearts" (
	"node_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "photo_hearts_node_id_user_id_pk" PRIMARY KEY("node_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "photo_comments" ADD CONSTRAINT "photo_comments_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_comments" ADD CONSTRAINT "photo_comments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_hearts" ADD CONSTRAINT "photo_hearts_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "photo_hearts" ADD CONSTRAINT "photo_hearts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "photo_comments_node_idx" ON "photo_comments" USING btree ("node_id","created_at");--> statement-breakpoint
CREATE INDEX "photo_comments_user_idx" ON "photo_comments" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "photo_hearts_user_idx" ON "photo_hearts" USING btree ("user_id");