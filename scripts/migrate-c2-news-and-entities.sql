-- ============================================================================
-- C2 migration — news leads + people/companies entities  →  *_v2 tables
-- ============================================================================
-- Idempotent + transactional. Reversible: the news rows can be removed with
--   DELETE FROM leads_v2 WHERE category <> 'lifestyle';
-- and the entity tables with TRUNCATE people_v2, companies_v2, people_companies_v2.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/migrate-c2-news-and-entities.sql
--
-- Notes / known gaps (documented, not fabricated):
--  * Historical lifestyle lead<->person junctions (lifestyle_lead_people, 1237)
--    cannot be relinked: the prior lifestyle ETL did not preserve article_id on
--    leads_v2, so there is no bridge from the old lifestyle_articles id to the
--    fresh leads_v2 id. Entities still migrate; only the old edges are dropped.
--  * people.merged_into_id and companies.parent_company_id are int self-refs;
--    we null them in v2 (varchar) rather than remap — low-value history.
-- ============================================================================

BEGIN;

-- ---- C2a: News leads (v1 leads -> leads_v2), preserving id ------------------
INSERT INTO leads_v2 (
  id, category, article_id, source_id, headline, source_url, source_name,
  source_tier, published_at, region, company_names, founder_names, investors,
  matched_keywords, ai_summary, wealth_angle, key_financials, pipeline_reasoning,
  sea_connection, priority_score, priority_level, status, fetch_method,
  is_update, related_saved_lead_id, founder_linkedin_url, founder_bio,
  company_description, enrichment_data, created_at
)
SELECT
  l.id,
  COALESCE(NULLIF(l.category, ''), 'news'),
  NULL, NULL,
  l.headline,
  l.source_url,
  COALESCE(l.source_name, ''),
  l.source_tier,
  COALESCE(l.published_at, l.created_at, CURRENT_TIMESTAMP),
  COALESCE(NULLIF(l.region, ''), 'Unknown'),
  COALESCE(l.company_names, '{}'),
  COALESCE(l.founder_names, '{}'),
  l.investors,
  COALESCE(l.matched_keywords, '{}'),
  COALESCE(l.ai_summary, ''),
  l.wealth_angle,
  l.key_financials,
  l.pipeline_reasoning,
  l.sea_connection,
  COALESCE(l.priority_score, 0),
  COALESCE(NULLIF(l.priority_level, ''), 'low'),
  COALESCE(NULLIF(l.status, ''), 'new'),
  l.fetch_method,
  COALESCE(l.is_update, false),
  l.related_saved_lead_id,
  l.founder_linkedin_url,
  l.founder_bio,
  l.company_description,
  l.enrichment_data,
  COALESCE(l.created_at, CURRENT_TIMESTAMP)
FROM leads l
ON CONFLICT (id) DO NOTHING;

-- ---- C2b: People / Companies entities, int PK -> uuid PK --------------------
-- Fresh remap each run; entity tables are derived, so truncate first.
-- include the (empty) v2 junctions that FK-reference the entity tables
TRUNCATE people_companies_v2, lead_people_v2, lead_companies_v2, people_v2, companies_v2 RESTART IDENTITY;

CREATE TEMP TABLE pmap ON COMMIT DROP AS
  SELECT id AS old_id, gen_random_uuid()::varchar AS new_id FROM people;
CREATE TEMP TABLE cmap ON COMMIT DROP AS
  SELECT id AS old_id, gen_random_uuid()::varchar AS new_id FROM companies;

INSERT INTO people_v2 (
  id, full_name, first_name, last_name, family_name, aliases, photo_url, bio,
  nationality, region, city, net_worth_estimate, net_worth_source,
  wealth_generation, wealth_source, family_notes, father_name, mother_name,
  spouse_name, first_seen_at, last_mentioned_at, mention_count, enriched,
  enriched_at, enrichment_model, merged_into_id, created_at, updated_at
)
SELECT m.new_id, p.full_name, p.first_name, p.last_name, p.family_name, p.aliases,
  p.photo_url, p.bio, p.nationality, p.region, p.city, p.net_worth_estimate,
  p.net_worth_source, p.wealth_generation, p.wealth_source, p.family_notes,
  p.father_name, p.mother_name, p.spouse_name, p.first_seen_at, p.last_mentioned_at,
  p.mention_count, p.enriched, p.enriched_at, p.enrichment_model, NULL,
  p.created_at, p.updated_at
FROM people p JOIN pmap m ON m.old_id = p.id;

INSERT INTO companies_v2 (
  id, name, aliases, description, sector, sub_sector, hq_country, hq_city,
  founded_year, website, is_public, stock_ticker, stock_exchange, products_brands,
  brand_description, funding_stage, total_funding, revenue_estimate, funding_history,
  investors, parent_company_id, subsidiaries, enriched, enriched_at, enrichment_model,
  source_urls, created_at, updated_at
)
SELECT m.new_id, c.name, c.aliases, c.description, c.sector, c.sub_sector,
  c.hq_country, c.hq_city, c.founded_year, c.website, c.is_public, c.stock_ticker,
  c.stock_exchange, c.products_brands, c.brand_description, c.funding_stage,
  c.total_funding, c.revenue_estimate, c.funding_history, c.investors, NULL,
  c.subsidiaries, c.enriched, c.enriched_at, c.enrichment_model, c.source_urls,
  c.created_at, c.updated_at
FROM companies c JOIN cmap m ON m.old_id = c.id;

INSERT INTO people_companies_v2 (
  id, person_id, company_id, role, role_type, ownership_pct, is_current,
  start_year, end_year, source, created_at
)
SELECT gen_random_uuid(), pm.new_id, cm.new_id, pc.role, pc.role_type,
  pc.ownership_pct, pc.is_current, pc.start_year, pc.end_year, pc.source, pc.created_at
FROM people_companies pc
JOIN pmap pm ON pm.old_id = pc.person_id
JOIN cmap cm ON cm.old_id = pc.company_id;

-- ---- Verification (printed, then COMMIT) -----------------------------------
\echo '--- leads_v2 by category (expect news ~1632 + lifestyle 879) ---'
SELECT category, count(*) FROM leads_v2 GROUP BY 1 ORDER BY 1;
\echo '--- entity counts (expect people 642, companies 802, people_companies 547) ---'
SELECT 'people_v2' t, count(*) FROM people_v2
  UNION ALL SELECT 'companies_v2', count(*) FROM companies_v2
  UNION ALL SELECT 'people_companies_v2', count(*) FROM people_companies_v2;

COMMIT;
