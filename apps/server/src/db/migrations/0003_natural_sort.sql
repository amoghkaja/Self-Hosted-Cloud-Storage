-- Natural name order for folder listings: case-insensitive via lower(), digits compared as
-- numbers ("IMG_2" before "IMG_10"). ICU ships with PostgreSQL builds that support it (the
-- official images do). Creating a collation needs only CREATE rights on the schema.
CREATE COLLATION IF NOT EXISTS "natural" (provider = icu, locale = 'und-u-kn-true');--> statement-breakpoint
DROP INDEX "nodes_children_idx";--> statement-breakpoint
CREATE INDEX "nodes_children_idx" ON "nodes" USING btree ("parent_id","type",(lower("name") COLLATE "natural"),"id") WHERE "nodes"."deleted_at" IS NULL;