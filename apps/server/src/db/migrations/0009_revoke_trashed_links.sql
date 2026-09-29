-- Deleting an item now ends its public links for good; apply that to items already in the trash.
UPDATE "share_links" SET "revoked_at" = now()
WHERE "revoked_at" IS NULL
  AND "node_id" IN (SELECT "id" FROM "nodes" WHERE "deleted_at" IS NOT NULL);
