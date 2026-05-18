-- News-sensei v2 schema — CREATE TABLE statements.
--
-- Mirrors shared/schema-v2.ts. Tables use `_v2` suffix so they coexist
-- with v1 tables during migration. After Phase 5 cutover:
--   DROP TABLE <v1 tables>;
--   ALTER TABLE <table>_v2 RENAME TO <table>;
--
-- Apply this file ONCE before running the ETL:
--   PGPASSWORD=newspass123 psql -h localhost -p 5433 -U newsuser \
--     -d newssensei -f scripts/v2-create-tables.sql
--
-- Idempotent: every CREATE uses IF NOT EXISTS.

BEGIN;

-- ============================================================================
-- Sources (unified: news + lifestyle, discriminated by category)
-- ============================================================================
CREATE TABLE IF NOT EXISTS sources_v2 (
  id                       VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  category                 TEXT NOT NULL CHECK (category IN ('news', 'lifestyle')),
  name                     TEXT NOT NULL,
  slug                     TEXT NOT NULL UNIQUE,
  domain                   TEXT NOT NULL,
  base_url                 TEXT NOT NULL,
  region                   TEXT,
  tier                     TEXT CHECK (tier IN ('tier1', 'tier2', 'tier3')),
  use_scrapingbee_for_rss  BOOLEAN NOT NULL DEFAULT FALSE,
  use_premium_scraping     BOOLEAN NOT NULL DEFAULT FALSE,
  publication_type         TEXT CHECK (publication_type IN ('luxury_magazine', 'business_magazine', 'newspaper', 'blog')),
  feed_url                 TEXT,
  scrape_config            JSONB,
  check_interval_min       INTEGER DEFAULT 240,
  last_checked             TIMESTAMP,
  error_message            TEXT,
  error_count              INTEGER NOT NULL DEFAULT 0,
  status                   TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error')),
  active                   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sources_v2_category ON sources_v2(category);
CREATE INDEX IF NOT EXISTS idx_sources_v2_active   ON sources_v2(active);

CREATE TABLE IF NOT EXISTS rss_feeds_v2 (
  id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id   VARCHAR NOT NULL REFERENCES sources_v2(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- Articles (raw scraped, pre-AI)
-- ============================================================================
CREATE TABLE IF NOT EXISTS articles_v2 (
  id                  VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id           VARCHAR REFERENCES sources_v2(id),
  url                 TEXT NOT NULL UNIQUE,
  url_hash            TEXT NOT NULL,
  title               TEXT NOT NULL,
  snippet             TEXT,
  image_url           TEXT,
  published_at        TIMESTAMP,
  full_text           TEXT,
  region              TEXT,
  fetch_method        TEXT,
  pipeline_status     TEXT NOT NULL DEFAULT 'pending'
                      CHECK (pipeline_status IN ('pending', 'filtering', 'filtered_out', 'extracting', 'extracted', 'failed')),
  filter_reason       TEXT,
  filter_confidence   REAL,
  created_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_articles_v2_pipeline_status ON articles_v2(pipeline_status);
CREATE INDEX IF NOT EXISTS idx_articles_v2_url_hash        ON articles_v2(url_hash);

-- ============================================================================
-- People & companies (entity graph, UUID PKs in v2)
-- ============================================================================
CREATE TABLE IF NOT EXISTS people_v2 (
  id                 VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name          TEXT NOT NULL,
  first_name         TEXT,
  last_name          TEXT,
  family_name        TEXT,
  aliases            TEXT[],
  photo_url          TEXT,
  bio                TEXT,
  nationality        TEXT,
  region             TEXT,
  city               TEXT,
  net_worth_estimate TEXT,
  net_worth_source   TEXT,
  wealth_generation  TEXT,
  wealth_source      TEXT,
  family_notes       TEXT,
  father_name        TEXT,
  mother_name        TEXT,
  spouse_name        TEXT,
  first_seen_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_mentioned_at  TIMESTAMP,
  mention_count      INTEGER DEFAULT 1,
  enriched           BOOLEAN DEFAULT FALSE,
  enriched_at        TIMESTAMP,
  enrichment_model   TEXT,
  merged_into_id     VARCHAR,
  created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_people_v2_full_name ON people_v2(LOWER(full_name));

CREATE TABLE IF NOT EXISTS companies_v2 (
  id                 VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  name               TEXT NOT NULL,
  aliases            TEXT[],
  description        TEXT,
  sector             TEXT,
  sub_sector         TEXT,
  hq_country         TEXT,
  hq_city            TEXT,
  founded_year       INTEGER,
  website            TEXT,
  is_public          BOOLEAN,
  stock_ticker       TEXT,
  stock_exchange     TEXT,
  products_brands    TEXT[],
  brand_description  TEXT,
  funding_stage      TEXT,
  total_funding      TEXT,
  revenue_estimate   TEXT,
  funding_history    JSONB,
  investors          TEXT[],
  parent_company_id  VARCHAR,
  subsidiaries       TEXT[],
  enriched           BOOLEAN DEFAULT FALSE,
  enriched_at        TIMESTAMP,
  enrichment_model   TEXT,
  source_urls        TEXT[],
  created_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_companies_v2_name ON companies_v2(LOWER(name));

CREATE TABLE IF NOT EXISTS people_companies_v2 (
  id            VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id     VARCHAR NOT NULL REFERENCES people_v2(id) ON DELETE CASCADE,
  company_id    VARCHAR NOT NULL REFERENCES companies_v2(id) ON DELETE CASCADE,
  role          TEXT,
  role_type     TEXT,
  ownership_pct REAL,
  is_current    BOOLEAN DEFAULT TRUE,
  start_year    INTEGER,
  end_year      INTEGER,
  source        TEXT,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- Leads (unified: news, lifestyle, ipo)
-- ============================================================================
CREATE TABLE IF NOT EXISTS leads_v2 (
  id                      VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  category                TEXT NOT NULL CHECK (category IN ('news', 'lifestyle', 'ipo')),
  article_id              VARCHAR REFERENCES articles_v2(id),
  source_id               VARCHAR REFERENCES sources_v2(id),

  headline                TEXT NOT NULL,
  source_url              TEXT NOT NULL,
  source_name             TEXT NOT NULL,
  source_tier             TEXT CHECK (source_tier IN ('tier1', 'tier2', 'tier3')),
  published_at            TIMESTAMP NOT NULL,
  region                  TEXT NOT NULL,

  company_names           TEXT[] NOT NULL,
  founder_names           TEXT[] NOT NULL,
  investors               TEXT[],
  matched_keywords        TEXT[] NOT NULL,
  ai_summary              TEXT NOT NULL,
  wealth_angle            TEXT,
  key_financials          JSONB,
  pipeline_reasoning      TEXT,
  sea_connection          TEXT,

  event_type              TEXT,
  banker_angle            TEXT,
  relevance_score         INTEGER,

  priority_score          INTEGER NOT NULL,
  priority_level          TEXT NOT NULL CHECK (priority_level IN ('high', 'medium', 'low')),

  status                  TEXT NOT NULL DEFAULT 'new'
                          CHECK (status IN ('new', 'reviewed', 'saved', 'contacted', 'dismissed')),
  fetch_method            TEXT,

  is_update               BOOLEAN DEFAULT FALSE,
  related_saved_lead_id   VARCHAR,

  analyzed_by_model       TEXT,

  founder_linkedin_url    TEXT,
  founder_bio             TEXT,
  company_description     TEXT,
  enrichment_data         JSONB,

  created_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_leads_v2_category       ON leads_v2(category);
CREATE INDEX IF NOT EXISTS idx_leads_v2_status         ON leads_v2(status);
CREATE INDEX IF NOT EXISTS idx_leads_v2_priority_score ON leads_v2(priority_score DESC);
CREATE INDEX IF NOT EXISTS idx_leads_v2_published_at   ON leads_v2(published_at DESC);

CREATE TABLE IF NOT EXISTS lead_people_v2 (
  id              VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         VARCHAR NOT NULL REFERENCES leads_v2(id) ON DELETE CASCADE,
  person_id       VARCHAR NOT NULL REFERENCES people_v2(id) ON DELETE CASCADE,
  role            TEXT,
  role_type       TEXT,
  mention_context TEXT
);

CREATE TABLE IF NOT EXISTS lead_companies_v2 (
  id              VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         VARCHAR NOT NULL REFERENCES leads_v2(id) ON DELETE CASCADE,
  company_id      VARCHAR NOT NULL REFERENCES companies_v2(id) ON DELETE CASCADE,
  mention_context TEXT
);

-- ============================================================================
-- IPO filings
-- ============================================================================
CREATE TABLE IF NOT EXISTS ipo_filings_v2 (
  id                 VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id            VARCHAR REFERENCES leads_v2(id),
  exchange           TEXT NOT NULL CHECK (exchange IN ('hkex_main', 'hkex_gem', 'sgx', 'idx', 'pse')),
  stock_code         TEXT NOT NULL,
  company_name       TEXT NOT NULL,
  industry           TEXT,
  proposed_valuation TEXT,
  revenue            TEXT,
  profit             TEXT,
  founders           TEXT,
  underwriters       TEXT,
  sponsors           TEXT,
  prospectus_url     TEXT,
  listing_date       TEXT,
  filing_date        TEXT,
  lockup_expiration  TEXT,
  raw_data           JSONB,
  alert_sent         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- User curation
-- ============================================================================
CREATE TABLE IF NOT EXISTS saved_leads_v2 (
  id                    VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id               VARCHAR NOT NULL REFERENCES leads_v2(id) ON DELETE CASCADE,
  saved_at              TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  founder_linkedin_url  TEXT,
  founder_bio           TEXT,
  company_description   TEXT,
  notes                 TEXT,
  research_data         JSONB,
  article_summary       TEXT
);

CREATE TABLE IF NOT EXISTS lead_feedback_v2 (
  id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     VARCHAR NOT NULL REFERENCES leads_v2(id) ON DELETE CASCADE,
  verdict     TEXT NOT NULL CHECK (verdict IN ('thumbs_up', 'thumbs_down')),
  reason      TEXT,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- Operational
-- ============================================================================
CREATE TABLE IF NOT EXISTS scan_runs_v2 (
  id                    VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
  run_type              TEXT NOT NULL CHECK (run_type IN ('news', 'lifestyle', 'ipo')),
  started_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at          TIMESTAMP,
  duration_ms           INTEGER,
  articles_scanned      INTEGER NOT NULL DEFAULT 0,
  matches_found         INTEGER NOT NULL DEFAULT 0,
  new_leads             INTEGER NOT NULL DEFAULT 0,
  duplicates_skipped    INTEGER NOT NULL DEFAULT 0,
  primary_model_calls   INTEGER NOT NULL DEFAULT 0,
  fallback_model_calls  INTEGER NOT NULL DEFAULT 0,
  sources_searched      JSONB,
  articles_processed    JSONB,
  errors                TEXT[]
);
CREATE INDEX IF NOT EXISTS idx_scan_runs_v2_started_at ON scan_runs_v2(started_at DESC);

-- NOTE: settings columns for LLM model config (primary_llm_model,
-- fallback_llm_model) are added separately in scripts/v2-add-settings-columns.sql
-- That file requires the table owner (often `postgres`, not `newsuser`).
-- Settings columns aren't needed for Phase 2 ETL — defer until Phase 4.

-- ============================================================================
-- Migration progress tracking (used by scripts/migrate-v1-to-v2.ts)
-- ============================================================================
CREATE TABLE IF NOT EXISTS migration_progress (
  source_table    TEXT NOT NULL,
  source_id       TEXT NOT NULL,
  stage           TEXT NOT NULL,
  outcome         TEXT NOT NULL CHECK (outcome IN ('passed', 'dropped', 'failed', 'inserted')),
  drop_reason     TEXT,
  target_lead_id  VARCHAR,
  cost_usd        REAL,
  duration_ms     INTEGER,
  processed_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source_table, source_id)
);
CREATE INDEX IF NOT EXISTS idx_migration_progress_outcome ON migration_progress(outcome);
CREATE INDEX IF NOT EXISTS idx_migration_progress_stage   ON migration_progress(stage);

COMMIT;
