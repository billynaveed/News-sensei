-- Adds LLM model config columns to the existing v1 settings table.
--
-- REQUIRES TABLE OWNER (in this DB, the `settings` table is owned by
-- `postgres`, not `newsuser`). Apply with:
--
--   PGPASSWORD=<postgres_pw> psql -h localhost -p 5433 -U postgres \
--     -d newssensei -f scripts/v2-add-settings-columns.sql
--
-- Not needed for Phase 2 ETL — defer to Phase 4 when withModelFallback()
-- wraps the pipeline. Safe and additive: existing app code that doesn't
-- read these columns is unaffected.

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS primary_llm_model  TEXT NOT NULL DEFAULT 'google/gemini-2.5-flash-lite',
  ADD COLUMN IF NOT EXISTS fallback_llm_model TEXT NOT NULL DEFAULT 'google/gemma-4-26b-a4b-it:free';
