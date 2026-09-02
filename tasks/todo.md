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

**Phase 3 — Research agent (in-server, slow burn)**
- [ ] Seed script: generate ~50 seed families per market (name + anchor person +
  primary company) via claude-sonnet-4, insert as researchStatus=pending
- [ ] `family-research.ts` worker: cron ~1 family/hour; per family: 5-8 Tavily
  searches ("X family", "X children", "X wife", Forbes/Tatler profiles) →
  sonnet synthesis to strict JSON (members, relations, confidence, source URLs) →
  upsertPersonByName reuse → write members/relationships; retries w/ attempt cap;
  low confidence ⇒ needs_review
- [ ] Progress endpoint + Families tab progress bar (e.g. "212/300 researched")
- [ ] Budget guard: daily cap on Tavily calls + LLM tokens; Brave fallback

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
- [ ] Worker researches 2-3 real families end-to-end with correct trees + sources (Phase 3)
- Deployed to production 2026-09-02 03:34 UTC (build + service restart, smoke check passed).

---

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
