CREATE TABLE "album_folders" (
	"album_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"folder_id" uuid NOT NULL,
	CONSTRAINT "album_folders_album_id_user_id_pk" PRIMARY KEY("album_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "album_people" (
	"album_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "album_people_album_id_user_id_pk" PRIMARY KEY("album_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "albums" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"note" text,
	"created_by" uuid,
	"cover_node_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "albums_dates_check" CHECK ("albums"."end_date" IS NULL OR "albums"."end_date" >= "albums"."start_date")
);
--> statement-breakpoint
ALTER TABLE "album_folders" ADD CONSTRAINT "album_folders_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_folders" ADD CONSTRAINT "album_folders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_folders" ADD CONSTRAINT "album_folders_folder_id_nodes_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_people" ADD CONSTRAINT "album_people_album_id_albums_id_fk" FOREIGN KEY ("album_id") REFERENCES "public"."albums"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "album_people" ADD CONSTRAINT "album_people_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "albums" ADD CONSTRAINT "albums_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "albums" ADD CONSTRAINT "albums_cover_node_id_nodes_id_fk" FOREIGN KEY ("cover_node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "album_folders_folder_key" ON "album_folders" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "album_people_user_idx" ON "album_people" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "albums_start_idx" ON "albums" USING btree ("start_date");