-- CSV files now preview as spreadsheets: convert the ones already stored.
UPDATE "blobs" SET "preview_status" = 'pending', "thumb_status" = 'pending'
WHERE "id" IN (
  SELECT "blob_id" FROM "nodes"
  WHERE "blob_id" IS NOT NULL AND ("mime_type" = 'text/csv' OR lower("name") LIKE '%.csv')
);
