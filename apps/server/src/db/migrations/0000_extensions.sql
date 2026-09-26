-- Trigram index support for filename search. pg_trgm is a trusted extension (PG13+),
-- so the database owner can create it without superuser rights.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
