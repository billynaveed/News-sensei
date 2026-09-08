# Task Tracker

Current session task list with checkable progress items.

---

## Current Task: Family Trees + Blocked Persons (coverage conflicts)

**Objective:** Model SEA wealthy families as visual trees inside Sensei, let Billy mark
people as "blocked" (covered by another banker) with relationship-aware propagation
(child blocked ⇒ parents blocked for sure; siblings/spouse optional), surface ⛔ badges
on leads naming blocked people, and run a slow in-server research agent over ~2 weeks
to build trees for the top ~50 families per SEA market (SG, ID, MY, TH, PH, VN — ~300
families).

**Decisions (Billy, 2026-09-02):**
- Scope: top ~50 families per SEA market (~300 families), no HK for now
- Runtime: research worker runs inside the Sensei server via node-cron (~1 family/hour)
- Feed behavior: blocked leads stay visible with a ⛔ "Blocked — covered" badge (no
  hiding until propagation is trusted); filter option to hide later

**Approach:** Build on what exists — `people` table (has familyName/father/mother/spouse
fields + aliases), `contact_meta` side-table pattern (app role can't ALTER people —
see memory/db-superuser-ownership), Tavily/Brave `web-search.ts`, `research.ts`
(claude-sonnet-4 via gateway), node-cron `scheduler.ts`. New tables are app-role-owned
via the `ensure-*-table.ts` pattern. Blocks are ALWAYS human-applied; the agent never
auto-blocks. Every researched relationship stores its source URL + confidence.

### Data model (new tables, keyed to people.id)
- `families`: id, name, country, primaryCompanies[], description, patriarchPersonId,
  netWorthEstimate, researchStatus (pending|researching|done|failed|needs_review),
  researchAttempts, researchedAt, confidence, sourceUrls[], timestamps
- `family_members`: familyId + personId junction (unique pair) — a person can appear
  in two families (marriage)
- `family_relationships`: familyId, fromPersonId, toPersonId,
  type (parent|spouse|sibling), confidence, sourceUrl, notes. Canonical direction:
  parent→child; siblings usually derived from shared parents but storable directly
  when research only knows "sibling"
- `person_blocks`: personId (unique), reason, coveredBy (which bank/banker),
  origin (direct|propagated), originPersonId, createdAt. Unblocking a direct block
  cascade-deletes its propagated rows

### Phases
**Phase 1 — Blocking core (works today, before any research)** ✅ 2026-09-02
- [x] Schema + ensure-tables for the 4 tables (ensure-families-tables.ts, runs at boot)
- [x] POST /api/persons/:id/block (alsoBlock[]) / DELETE unblock (cascades propagated);
  GET /api/founders/blocked (names+aliases+familyId for feed matching)
- [x] Manual family/member/relationship CRUD (server/families.ts + routes)
- [x] Dashboard: ⛔ badge (red, links to family) on founder names matching blocked
  persons incl. aliases; hide-blocked filter deferred until propagation is trusted

**Phase 2 — Families tab UI** ✅ 2026-09-02
- [x] /families route: list w/ search, country chips, member/blocked counts, research badges
- [x] Family detail: generational tree (relaxation layout + measured SVG connectors;
  solid parent, dotted spouse, dashed sibling; unlinked members shown separately)
- [x] Person panel: details + relationships (add/remove) + Block/Unblock + remove-from-family
- [x] Block dialog: parents PRE-CHECKED, spouse/siblings/children opt-in, coveredBy/reason,
  shows "Block N people" count
- [x] Lead cards: blocked founder badges link to their family page

**Phase 3 — Research agent (in-server, slow burn)** ✅ 2026-09-02
- [x] Seed: `seedFamilies()` asks claude-sonnet-4 for ~50 families/market (name,
  anchor person, companies, net worth) → families rows as researchStatus=pending with
  the anchor upserted into people + family_members. Idempotent on (name, country).
  Ran 2026-09-02: 295 families (SG 50, ID 48, MY 50, TH 48, PH 49, VN 50)
- [x] `server/family-research.ts` worker: node-cron `20 * * * *` (1 family/hour) +
  a startup tick after 90s; per family 6 searches (web-search.ts) → sonnet strict
  JSON (members, relations, confidence, source URLs) → upsertPersonByName reuse →
  family_members/relationships (onConflictDoNothing; fills blank familyName/bio only);
  low confidence or <2 members ⇒ needs_review; failures retry up to 3 attempts;
  rows stuck in "researching" reset to pending at boot
- [x] Endpoints: GET /api/families/research/progress, POST .../research/seed,
  POST .../research/run (one tick now), POST /api/families/:id/research (requeue)
- [x] Families tab progress bar ("N/295 families researched", queued/review/failed, last run)
- [x] Budget guard: FAMILY_RESEARCH_DAILY_SEARCH_CAP (default 200 searches/day);
  FAMILY_RESEARCH_ENABLED=false disables; FAMILY_RESEARCH_CRON overrides cadence
- Verified: first tick researched the Wee family (SG) → 8 members, 7 sourced edges,
  confidence high; tree renders (spouse dotted, parent lines)
- Known seed noise: a few LLM seeds mis-attribute companies/countries (e.g. a
  Malaysian entry citing a Singapore company); research pass + needs_review queue
  are where these surface. Phase 4 review UI will handle them.

**Phase 4 — Polish (after data flows)**
- [ ] needs_review queue UI; person merge/dedupe review
- [ ] "Re-research family" button; per-person lazy enrichment on view

**Verification (Phases 1-2, done 2026-09-02 on dev :5100 against live DB):**
- [x] npm run check clean; ensure-families-tables creates app-role tables at boot (no ALTER people)
- [x] Blocked test child → father auto-proposed & propagated ({"blocked":2}); person panel
  explains "Blocked because X is blocked. Covered by TestBank."
- [x] Unblock direct → propagated blocks cascade-deleted ({"removed":2})
- [x] Tree renders: 2 generations, spouse dotted line, parent connectors, red blocked nodes
- [x] Dashboard lead card shows ⛔ badge on the blocked founder only (sibling stays normal)
- [x] Test data fully cleaned (people/family/blocks/lead + temp auth session removed)
- [x] Worker researched the Wee family end-to-end with correct tree + sources (Phase 3)
- Deployed to production 2026-09-02 03:34 UTC (build + service restart, smoke check passed).

---

## 2026-09-08 — Pipeline: catch SEA deals reported by non-SEA outlets (Circle × Tazapay $400M) ✅

**Trigger:** Billy asked whether the pipeline caught Circle's $400M acquisition of Singapore's
Tazapay. It hadn't: no subscribed source ran it, and a Tazapay article from Tech in Asia had
been rejected at Stage 1 as "sea_publisher_only" (85% of weekly rejects carry that reason).

**Root causes + fixes (all verified end-to-end on dev, then deployed):**
- [x] Coverage: `fetchFromDealRadar` in adapters.ts — 6 source-independent Google News
  keyword queries ("Singapore-based" + deal terms, per-market variants, SEA founder exits),
  always on (DEAL_RADAR_ENABLED=false disables). Found 16 Tazapay articles in 2s.
- [x] Stage 1b geography rescue (`server/geo-rescue.ts`): S1 only sees headline+500 chars,
  so a SEA company whose HQ isn't in the snippet is rejected. For deal-shaped articles
  rejected on geography alone, verify the subject's HQ (research_cache → companies table →
  one web search + flash-lite read; 60 lookups/day cap) and rescue with a "[Verified: …]"
  note that flows into S6. 
- [x] Stage 2/6 subject selection: acquisitions now resolve to the TARGET (Tazapay), never
  the acquirer (Circle). companyNames[0] = subject, so S7 enriches the right company.
- [x] Stage 6 scoring: acquisition of a private target-region company = liquidity event by
  definition (85+ with named founder + price; 55-65 with nobody named). Was scoring 25.
- [x] Stage 6a founder discovery (`server/founder-discovery.ts`): for medium+ leads, look up
  the subject company's founders (2 short searches + flash-lite), put them FIRST; acquirer
  executives are excluded from founderNames. Tazapay → Rahul Shinghal (CEO, Singapore),
  Arul Kumaravel, Saroj Mishra, Kanupriya Sharda; LinkedIn found in S7.
- [x] keyFinancials / wealthAngle / seaConnection were computed by S6 but never persisted —
  now written to leads_v2.
- [x] web-search.ts: Tavily plan is over its usage limit (432 "exceeds your plan"); searchWeb
  now falls back to Brave on quota errors, breaker-open, and final failure instead of null.
- [x] `POST /api/leads/ingest-url {url}`: push any article through the full pipeline on demand.
- [x] Scraping made provider-agnostic (`server/scraper.ts`): scrape.do (trial, 1000 req/month,
  key in .env as SCRAPE_DO_API_KEY) replaces the dead ScrapingBee key (401). Used by S5 (now
  for any article with <1500 chars, not only tier1), RSS-via-proxy, homepage discovery, IDX
  IPO page, and ingest fallback. `GET /api/scraper/status` shows credits. CoinDesk (429 on
  direct fetch) = 1 credit; Tech in Asia rendered = 5 credits.
- Result: lead 8c568b5f… on the dashboard — high (85), $400M, four founders, LinkedIn.
- Not done: Debug-page panel for scraper/search quota (endpoint exists); per-source Google
  News toggle is still off in settings (radar covers the deal case).

## Completed Tasks

### [Date] - [Task Name]
**Changes Made:**
- Change 1
- Change 2

**Verification Results:**
- [What was tested and confirmed]

**Review:**
- [ ] Would a staff engineer approve this?
- [ ] Is this the elegant solution?
- [ ] Minimal code impact achieved?

---

## Backlog

- [Future tasks or ideas]

---

## Notes

**Session Context:**
- [Any important context for continuity between sessions]

**Blockers:**
- [Any blockers or dependencies]

**Questions for User:**
- [Questions that need user input]
