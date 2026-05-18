# Feature Roadmap - News-sensei

_Updated: 2026-05-18_

---

## 🚨 P0 — Schema Rebuild & Lifestyle Scraper Consolidation

_Added 2026-05-18 after audit. Read this before touching anything else._

### Why this is P0

The database is currently a frankenstein. A schema audit revealed:

- **33 tables in DB, ~15 declared in `shared/schema.ts`** — Drizzle treats the ~18 undeclared tables as candidates for deletion on next `db:push`.
- **Two parallel lifestyle pipelines running** with different schemas:
  - **OLD** (active, no source code in this repo): `publications` (25) + `lifestyle_leads` (3,292, **633 high-score**) + `scrape_log` (17,261). Last write: today.
  - **NEW** (in `server/lifestyle-scanner.ts`): `lifestyle_sources` (17) + `lifestyle_articles` (2,798) + `lifestyle_scrape_log`.
  - Both populating right now. The Mac Mini scraper writes to OLD; the cron in this repo writes to NEW.
- **Three different PK conventions** in use: `varchar UUID` (`lifestyle_articles`, `leads`), `integer SERIAL` (`people`, `companies`, `publications`, `lifestyle_leads`), `integer IDENTITY` (`lifestyle_sources`, `lifestyle_scrape_log`).
- **Orphan subsystems** with real data nobody reads from the UI:
  - `contacts` (10) + `contact_notes` + `contact_tags` + `contact_relationships` + `contact_title_history` — a personal CRM
  - `model_ab_log` — leftover from the Gemma4 vs Gemini bake-off (concluded; can drop)
  - `cross_references`, `lead_feedback`, `push_subscriptions`, `pending_articles` — unclear ownership
- **Naming evolution debt**: `publications` → `lifestyle_sources`, `lifestyle_leads` → `lifestyle_articles`, `scrape_log` → `lifestyle_scrape_log`. None of these were proper renames; both live side-by-side.
- **`npm run db:push` is unsafe** in the current state — its destructive prompt offers to drop `publications` (25), `contacts` (10), `lifestyle_leads` (3,292), and `scrape_log` (17,261). Do NOT run until the rebuild lands.

### Goal of the rebuild

Single, opinionated, documented schema. One way to do each thing. PKs consistent. Tables in `schema.ts` match what's in the DB, 1:1.

### Proposed unified schema (v2)

**Core entities** (UUID PKs everywhere except small lookup tables):

| Table | Purpose | Replaces |
|---|---|---|
| `sources` | All scrape targets (news + lifestyle), discriminated by `category` | `sources` + `publications` + `lifestyle_sources` |
| `rss_feeds` | RSS subfeeds per source | (keep as-is) |
| `articles` | Raw scraped articles, pre-AI | `pending_articles` + ingest-side of `lifestyle_articles`/`lifestyle_leads` |
| `leads` | AI-analyzed leads, `category` in `('news', 'lifestyle', 'ipo')` | `leads` + `lifestyle_leads` + `lifestyle_articles` |
| `ipo_filings` | IPO-specific structured data (keep, FK to leads) | (keep) |
| `people` | Founders / executives / wealthy individuals | (keep, normalize PK to UUID) |
| `companies` | Companies mentioned | (keep, normalize PK to UUID) |
| `lead_people` | Junction: leads × people, with role/role_type | `lifestyle_lead_people` + new for news |
| `lead_companies` | Junction: leads × companies | `lifestyle_lead_companies` + new for news |
| `people_companies` | Person ↔ company employment graph | (keep) |

**User curation:**

| Table | Purpose |
|---|---|
| `saved_leads` | User's bookmarked leads with notes, LinkedIn, bio (keep) |
| `lead_feedback` | Thumbs up/down + reasons — feeds future ML scoring |

**Operational:**

| Table | Purpose | Replaces |
|---|---|---|
| `scan_runs` | One row per scan execution across all pipelines | `scan_logs` + `scrape_log` + `lifestyle_scrape_log` |
| `scanned_urls` | URL dedup hash | (keep) |
| `research_cache` | Cache for `/research` command + enrichment API calls | (keep) |
| `settings` | Singleton settings row (keep) |
| `users`, `auth_sessions`, `webauthn_credentials` | Auth (keep) |

**Decisions made (2026-05-18):**

1. ✅ **Contacts CRM — KILL.** Drop `contacts`, `contact_notes`, `contact_tags`, `contact_relationships`, `contact_title_history`. Archive the 10 contacts to `archive/contacts-2026-05-18.json` for reference, then `DROP TABLE ... CASCADE`. Remove the `enrichment_data` / `last_enriched_at` / `keep_in_touch_*` etc. columns from the v2 design entirely.
2. ✅ **Old lifestyle_leads — MIGRATE WITH RE-VALIDATION.** Don't bulk copy the 3,292 rows. Instead, push each through the **current** scoring/extraction pipeline (`pipeline-stages.ts`) and only keep leads that pass the new criteria. See Phase 2 below for details.

**Decisions made (continued, 2026-05-18 PM):**

3. ✅ **`cross_references` — DROP.** Generic polymorphic linkage table (source/target type+id, confidence). 0 rows. Never wired. Gone.
4. ✅ **`push_subscriptions` — DROP.** 3 rows, web push never finished. Notifications are Telegram-only.
5. ✅ **`model_ab_log` — DROP.** Gemma4 vs Gemini bake-off already summarized in `MODEL-COMPARISON-TL-DR.txt`. No further use.
6. ✅ **`pending-queue.ts` + `pending_articles` table — DROP, replace with model fallback chain.** The pending queue was a credit-exhaustion safety net (queue article → reprocess when credits return). It's dead code (nothing imports it) and obsoleted by decision #7 below.
7. ✅ **Model fallback chain (primary: Gemini 2.5 Flash Lite → fallback: Gemma 4 on OpenRouter).** When the primary model errors out (rate-limit, credits exhausted, transient 5xx), the pipeline falls back to Gemma 4 via OpenRouter instead of queuing. Gemma 4 is ~$0.04/M input tokens — effectively free at our volume — so credit exhaustion stops being a class of failure we have to engineer around. Apply this wrap to every `pipeline-stages.ts` LLM call site.

### Mac Mini scraper — DECOMMISSIONED

**Status (2026-05-18 PM):** Mac Mini node is offline. No fresh writes to OLD `lifestyle_leads` / `publications` / `scrape_log` anymore. The 3,292 historical rows are a frozen snapshot.

**Implication for v2:**
- ~~Phase 4 (Mac Mini cutover) is **skipped**.~~ No live coordination needed.
- Lifestyle ingestion runs entirely from the in-repo `server/lifestyle-scanner.ts` against `lifestyle_sources` (which becomes the unified `sources` table with `category='lifestyle'`).
- The 3,292 old rows still get migrated via the re-validation ETL in Phase 2.

**Resilience replacement (since we can't lean on Mac Mini as redundancy anymore):**
- All Gemini 2.5 Flash Lite call sites get wrapped with a `withModelFallback()` that retries on Gemma 4 (`openrouter/google/gemma-2-9b-it` or current Gemma 4 model ID) when the primary errors out.
- Implement in `pipeline-stages.ts` as a single wrapper applied per stage rather than per call site.

### Migration plan (5 phases)

**Phase 0 — Safety net (1 hour)**
- `pg_dump -h localhost -p 5433 -U newsuser newssensei > backup-pre-v2-$(date +%Y%m%d).sql`
- Tag git: `v1-final`
- Pause both lifestyle cron jobs (`server/scheduler.ts:48` + Mac Mini cron)

**Phase 1 — Define v2 schema (4-6 hours)**
- Create `shared/schema-v2.ts` with the unified design above
- Generate Drizzle migration SQL (`drizzle-kit generate`)
- Hand-edit the SQL where Drizzle can't infer (table renames, FK rewires)

**Phase 2 — ETL migration script (10-14 hours, longer due to re-validation)**
- `scripts/migrate-v1-to-v2.ts` that:
  - **Sources**: Copies `publications` + `lifestyle_sources` → unified `sources` (dedupe by slug/base_url, prefer NEW values where they differ). Mark `category='lifestyle'`.
  - **Lifestyle leads (re-validation pass)** — do NOT bulk copy. For each row in `lifestyle_leads` and `lifestyle_articles`:
    1. Build a `RawArticle` from the row (headline, url, source, fullText, region, publishedAt)
    2. Run it through Stage 1 (`passesInterestFilter`) — drop if it doesn't pass current filter prompt
    3. Run Stage 2 (`extractPrimaryCompany`) — drop if no identifiable company
    4. Run Stage 3 (`isPublicCompany`) — drop if it's a public-co article (founders already cashed out)
    5. Run Stage 4 (`checkDuplication`) — drop near-duplicates within the same migration batch
    6. Run Stage 5 (`fetchFullArticleContent`) only if `full_text` is empty — skip otherwise to save API calls
    7. Run Stage 6 (`deepAnalyzeArticle`) for full extraction + scoring
    8. Run Stage 7 (`enrichLeadWithWebSearch`) optionally for high-scorers (>= 70)
    9. Insert into unified `leads` table with `category='lifestyle'` only if final priority score >= 40 (the medium threshold)
  - Preserve `feedback`, `saved`, `dismissed` flags from old `lifestyle_leads` where set (overrides AI score — user has explicitly judged)
  - Re-link `lifestyle_lead_people` / `lifestyle_lead_companies` to new `leads` UUIDs (use a temp mapping table during migration)
  - **Scan logs**: Copy `scrape_log` + `lifestyle_scrape_log` + `scan_logs` → unified `scan_runs` straight passthrough (no re-validation)
  - **Cost & throughput estimate**: 3,292 lifestyle_leads + 2,798 lifestyle_articles = 6,090 rows × ~7 LLM calls per row through pipeline = ~42,600 Gemini 2.5 Flash Lite calls. At current OpenRouter pricing (~$0.10 / M input tokens, ~$0.40 / M output), assuming ~2k tokens in / ~500 tokens out per call: roughly **$8-15 in LLM costs** and **6-10 hours wall-clock** at moderate rate-limiting. Run overnight.
  - **Idempotent + resumable**: Maintain a `migration_progress` temp table so a crash mid-run can resume from where it stopped. Each row processed exactly once.
  - **Dry-run mode**: First pass writes to a `leads_v2_preview` table without dropping old data; review pass-rate before committing.
  - **Verification report**: At end, produces `migration-report.md` with:
    - Rows in → rows out by pipeline stage (drop reasons)
    - Pass rate per source publication
    - Sample of 20 highest-score migrated leads
    - Sample of 20 dropped leads with drop reasons (sanity check the filter isn't being too aggressive)

**Phase 3 — Code cutover (4-6 hours)**
- Repoint `server/lifestyle-scanner.ts` to write to unified `leads` table
- Repoint `server/scanner.ts` to write to unified `leads` table
- Repoint `server/routes.ts` endpoints (`/api/leads`, `/api/lifestyle-leads`) to query unified table with `category` filter
- Update `server/storage.ts` storage interface

**Phase 4 — ~~Mac Mini cutover~~ Model fallback chain (3-4 hours)**

Skipped: Mac Mini is offline; no live coordination needed.

Replacement work:
- Add `withModelFallback(primary, fallback)` helper in `server/llm.ts` (or wherever the OpenRouter client lives)
- Wrap each stage in `pipeline-stages.ts` (passesInterestFilter, extractPrimaryCompany, isPublicCompany, checkDuplication, deepAnalyzeArticle, enrichLeadWithWebSearch)
- Fallback model: Gemma 4 on OpenRouter (confirm current ID — Gemma 2 9B IT was the prior option; check OpenRouter for Gemma 4 availability)
- Log fallback events to `scan_runs` so we can see how often primary fails
- Resume lifestyle cron, monitor 24h

**Phase 5 — Drop old tables (30 min)**
- After 7 days of stable v2 operation:
  - `DROP TABLE publications, lifestyle_leads, scrape_log, lifestyle_sources, lifestyle_articles, lifestyle_scrape_log, lifestyle_lead_people, lifestyle_lead_companies CASCADE;`
  - `DROP TABLE contacts, contact_notes, contact_tags, contact_relationships, contact_title_history CASCADE;` (after JSON archive)
  - `DROP TABLE cross_references, push_subscriptions, model_ab_log, pending_articles CASCADE;`
  - (Junction tables become part of unified `lead_people` / `lead_companies`.)

### Half-applied fixes from the 2026-05-18 audit session

These changes are already committed to working files (unstaged) and are SAFE — they don't require `db:push`. They wire up the lifestyle UI to the *new* tables and clean up TS errors:

- `client/src/App.tsx` — added `<Route path="/lifestyle-leads">` and imported the page
- `client/src/components/app-sidebar.tsx` — added "Lifestyle Leads" nav entry (Sparkles icon)
- `server/routes.ts` — removed duplicate `import { eq }`; added `GET /api/lifestyle-leads` and `POST /api/lifestyle-scan` endpoints; imported `getRecentLifestyleLeads` + `scanLifestylePipeline`
- `shared/schema.ts` — fixed `LifestylePublicationType` union to match seeded values; added missing `InsertLifestyleSource` export; switched `people`, `companies`, `people_companies` to `serial()` (matches existing DB sequences exactly — no migration needed)
- `server/pending-queue.ts` — fixed broken imports (`deepAnalysis` → `deepAnalyzeArticle`); removed call to nonexistent `getDismissedLeadsByCompany`; fixed missing `publishedAt`. **Note: `pending-queue.ts` is dead code — wired nowhere. Decision needed in v2: wire it up or delete it.**

After v1→v2, the UI wiring above will need to be repointed at unified `leads` table with `category='lifestyle'` filter.

### Open questions before kicking off v2 — ALL RESOLVED (2026-05-18 PM)

1. ~~Where does the Mac Mini scraper code live?~~ ✅ **Mac Mini is offline. Phase 4 skipped. Replaced with Gemma 4 OpenRouter fallback.**
2. ~~Are the 10 contacts in the CRM tables real data you want to preserve?~~ ✅ **Drop, archive to JSON first.**
3. ~~Is the OLD `lifestyle_leads` data valuable enough to migrate?~~ ✅ **Migrate with re-validation. Keep only score >= 40.**
4. ~~Do you actually use `pending-queue.ts`'s credit-exhaustion requeue concept?~~ ✅ **No. Delete. Replaced by model fallback chain.**
5. ~~Is there any data in `cross_references`, `push_subscriptions`, `model_ab_log` worth keeping?~~ ✅ **No. Drop all three.**

**Ready to start Phase 0.**

### Effort estimate

- Phases 0-1: ~8 hours (backup, snapshot, define v2 schema)
- Phase 2: **~12 hours** (ETL with re-validation; overnight LLM run for ~6k rows; ~$8-15 in API costs)
- Phases 3-4: ~10 hours (Mac Mini coordination is the wild card)
- Phase 5: deferred week, low risk

Total: **~3-4 focused days of work** before the system is clean. The re-validation pass adds a day vs. naive copy, but means you start v2 with a vetted dataset instead of importing 3,292 rows of unknown quality.

### Phase 2 execution — how to actually run the ETL

**Status (2026-05-18):** Script + DDL written. v2 tables created in DB. Not run yet.

**Files:**
- `scripts/v2-create-tables.sql` — DDL for v2 tables (applied, idempotent)
- `scripts/v2-add-settings-columns.sql` — adds primary/fallback LLM columns to `settings` (requires `postgres` user, defer to Phase 4)
- `scripts/migrate-v1-to-v2.ts` — the ETL
- `migration_progress` table — resumability tracking (per-row stage + outcome)

**Run order:**

```bash
# 1) Sanity check on a small sample (~25 rows from each source table).
#    Costs roughly $0.05. Runs the full pipeline against real rows.
#    Writes to migration_progress but NOT to leads_v2.
tsx scripts/migrate-v1-to-v2.ts --sample 25

# 2) Inspect ./migration-report.md
#    - Are accepted leads sensible? (sample of 30 in the report)
#    - Are dropped leads being dropped for the right reasons?
#    - What's the pass rate? Expect ~5-15% based on prior bake-offs.

# 3) If sample looks good, full dry-run (still no leads_v2 writes).
#    Costs ~$8-15. Runs overnight (~6-10 hours wall-clock).
#    Resumable: if it crashes, just re-run.
tsx scripts/migrate-v1-to-v2.ts

# 4) Inspect ./migration-report.md again. If acceptable:
#    Wipe migration_progress and re-run with --commit.
#    (Or: skip the dry-run and commit directly if step 1 was convincing.)
PGPASSWORD=newspass123 psql -h localhost -p 5433 -U newsuser newssensei \
  -c "TRUNCATE migration_progress;"
tsx scripts/migrate-v1-to-v2.ts --commit

# 5) Verify
PGPASSWORD=newspass123 psql -h localhost -p 5433 -U newsuser newssensei \
  -c "SELECT category, priority_level, COUNT(*) FROM leads_v2 GROUP BY 1, 2 ORDER BY 1, 2;"
```

**Tuning knobs (top of migrate-v1-to-v2.ts):**
- `SCORE_THRESHOLD = 40` — lower to keep more, raise to be stricter
- `RATE_LIMIT_MS = 250` — sleep between LLM calls; raise if OpenRouter rate-limits
- `DEFAULT_REGIONS` — currently SEA + HK + Taiwan, hard-coded

**Cost ceiling:** if the run-rate looks too expensive, kill it (Ctrl+C). It's resumable — re-run with `--sample 100` to extrapolate cost first.

**What the ETL deliberately skips vs. live pipeline:**
- `checkDuplication` (LLM-based) — replaced with in-batch company-name set for historical import. Saves ~3,000 calls.
- `fetchFullArticleContent` — only fetched if the row's `full_text` is empty (most are populated). Saves ~5,000 calls.
- `enrichLeadWithWebSearch` — skipped entirely. Run as a separate enrichment pass later for the high-scorers if needed.

---

## 🔴 High Priority (Next 2 Weeks)

### 1. IPO Filings Scanner — HKEX & SGX (HIGH)
**Status:** Research complete, ready to build

**Goal:** Automatically detect new IPO filings on Hong Kong and Singapore stock exchanges and alert Billy via Telegram with key details.

**Data Sources:**
- **HKEX Main Board**: `https://www2.hkexnews.hk/New-Listings/New-Listing-Information/Main-Board?sc_lang=en` (plain HTML — no browser needed!)
- **HKEX GEM Board**: `https://www2.hkexnews.hk/New-Listings/New-Listing-Information/GEM?sc_lang=en`
- **HKEX Application Proofs** (pre-IPO): `https://www1.hkexnews.hk/app/appindex.html`
- **SGX IPO Prospectus**: `https://www.sgx.com/securities/ipo-prospectus` (JS-rendered — needs Playwright)
- **SGX IPO Performance**: `https://www.sgx.com/securities/ipo-performance`

**Technical Approach:**
- HKEX: HTTP fetch + HTML parsing (cheerio) on cron (every 2 hours)
- SGX: Playwright headless browser scraping on cron (every 2 hours)
- New filing detection: compare against DB of previously seen filings
- GPT-4o prospectus analysis: extract valuation, revenue, founders, underwriters, industry
- Telegram alert with summary + prospectus PDF link
- Store in `ipo_filings` table with all extracted metadata

**Key Metrics to Extract:**
- Company name, stock code, exchange
- Industry / sector
- Proposed valuation / market cap
- Revenue & profit (last FY)
- Founders / key shareholders (wealth event!)
- Underwriters / sponsors
- Expected listing date
- Lock-up expiration date

**Why High Priority:** IPO founders = new UHNW clients. First-mover advantage on relationship building.

---

### 2. Telegram `/research` Command (HIGH)
**Status:** Specification complete

**Goal:** Research any person from Telegram by typing their name.

**User Flow:**
1. Billy types: `/research John Tan` in Telegram
2. Bot searches: saved leads → news-sensei DB → web search → Clay (if integrated)
3. If multiple matches: numbered list for disambiguation
4. Returns: professional background, wealth indicators, recent news, contact approach

**Enrichment Sources (priority order):**
1. News-sensei saved leads DB
2. Clay API (if Billy provides access) — gets LinkedIn, funding, email, etc.
3. Google search + web scraping fallback
4. Brave Search API

**Data Returned:**
- Current role & company
- Previous roles, education
- Wealth indicators (funding, exits, board seats)
- Recent news mentions
- Recommended talking points

---

### 3. Clay Integration (HIGH — pending Billy's API key)
**Status:** Waiting on Clay API access

**Goal:** Use Clay as the enrichment backbone for lead data.

**Integration Points:**
- Auto-enrich when a lead is saved (LinkedIn, email, funding, tech stack)
- Power the `/research` command
- Waterfall enrichment (Clay tries 100+ providers automatically)
- Webhook: Clay pushes enriched data back to news-sensei

**What's Needed:** Billy's Clay API key + plan details (credit limits)

---

## 🟡 Medium Priority (Month 2)

### 4. Founder Enrichment Pipeline
**Status:** Design phase

**Goal:** Auto-enrich founder info when leads are saved.
- Trigger background job on lead save
- Pull: LinkedIn profile, headline, bio, experience, education
- Pull: company description, funding, investors
- Show loading state in UI, allow manual re-fetch
- Uses Clay if available, falls back to Google dorking

### 5. Lead Scoring Improvements
**Status:** Research

**Ideas:**
- ML-based scoring instead of rule-based
- Historical conversion tracking
- Learn from Billy's save/dismiss patterns
- Weight by: funding stage, geography (SG focus), industry

### 6. Authentication & Multi-User
**Status:** Planning

- Add login (currently open)
- User-specific saved leads & settings
- Team workspaces
- Role-based access

### 7. HTTPS for Dashboard
**Status:** Ready to implement

- Let's Encrypt cert for news-sensei dashboard
- Currently HTTP only

---

## 🟢 Future (Month 3+)

### 8. Browser Extension
- Chrome extension: right-click any article → "Save to News-sensei"
- Auto-extract company/founder names
- Send to backend for processing

### 9. CRM Export
- Export leads to Salesforce, HubSpot
- Sync saved leads bidirectionally

### 10. Network Graph Visualization
- Map relationships: companies ↔ founders ↔ investors
- Visual network of connections
- Identify warm intro paths

### 11. WhatsApp Notifications
- Alternative to Telegram for alerts
- Same alert format, different delivery

### 12. Email Weekly Digest
- Curated weekly summary of top leads
- IPO pipeline overview
- Wealth events calendar

---

## ✅ Completed

- ✅ Domain-based news source management
- ✅ RSS feed subcategories per source
- ✅ Global scanning method toggles (RSS, Google News, ScrapingBee)
- ✅ AI-powered lead extraction with GPT-4o
- ✅ Priority scoring system
- ✅ Telegram notifications
- ✅ Scan logs with detailed tracking
- ✅ URL deduplication
- ✅ Multi-tier filtering
- ✅ Hourly automated scans
- ✅ Saved leads with expandable detail UI
- ✅ Manual scan button (dashboard only)
- ✅ Sidebar navigation improvements

---

## Technical Debt

- [ ] TypeScript strict mode
- [ ] Unit tests for scanner logic
- [ ] Integration tests for API endpoints
- [ ] Database indexes (leads.publishedAt, leads.status)
- [ ] Pagination for leads list
- [ ] Rate limiting on API endpoints
- [ ] CSRF protection
- [ ] CI/CD pipeline
- [ ] Feature flags

---

## Ideas Backlog

- Sentiment analysis on articles
- Language support (Chinese, Malay, Japanese)
- Mobile app (React Native)
- Competitor analysis dashboard
- Market trend analysis
- Calendar integration for follow-up scheduling
- Voice assistant integration
