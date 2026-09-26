# Task Tracker

Current session task list with checkable progress items.

---

## 2026-09-25 — Card scanner: usability fixes from Billy's first real scan ✅

**Billy's report:** "It says Ready but it's not obvious what to do next. I can see a picture
of it... I'm not really sure what to do next."

**Diagnosis (measured, not guessed):** his uncropped phone photo rendered 597px tall and
pushed everything below it — on a 900px screen the Save button sat at y=1669, so the edit
form and every action were off-screen with nothing above the fold hinting they existed.
"Ready" was a state, not an instruction.

- [x] Review panel now LEADS with a sticky action header (name, role, Save contact + icon
  buttons for re-read / vCard / discard). Save moved from y=1669 to y=571
- [x] Card photo is a click-to-enlarge thumbnail inside the panel header, beside the parsed
  name — reviewing a card is a comparison task, so the photo and the fields belong together
- [x] Status labels say what to do: "Check & save", "Needs a fix", "Couldn't read"
- [x] One-line instruction under the header: "Check the details below, correct anything
  wrong, then save."
- [x] **Real-card bug found in his scan:** "TEL: (632) 8817-0817 • 8982-3000" — the second
  number shares the first's area code and could not validate alone (e164 was null).
  `normalizePhones` now rebuilds it from a validated sibling's area code, accepting the
  result only when the national number comes out the SAME LENGTH as the donor's (a
  reconstruction, not a guess). Flagged "area code added" in both the web review panel and
  the Telegram reply so it is checked, not trusted. His card: 2/3 → 3/3 numbers dialable

**Second pass — Billy: "look at the screenshot its a mess":** measured the layout and found
real structural problems, not cosmetics:
- [x] A 320px queue sidebar reserved 922px of height for ONE 80px item (~840px of void).
  Replaced with a horizontal strip that only appears when there are 2+ cards
- [x] The photo thumbnail floated orphaned above the review card with a gap; it now sits
  inside the panel header next to the name
- [x] Fields stretched to fill an 800px column: Honorific (4 chars) and Name were both 377px
  and Honorific held the prime top-left slot. Now a 3-column grid where Name/Title/Company
  span two columns and Honorific one, inside a max-w-3xl page — a form column, not a dashboard
- [x] Phone inputs were 638/590/638px wide (ragged right edge, 12-char content). Now a fixed
  190px monospace tabular field with every annotation in one aligned column
- [x] The 766x80 note textarea became a single input; flat wall of inputs became labelled
  Person / Contact / Where we met sections; the duplicate bottom Save button is gone
- [x] Mobile: phone annotations were squeezed into a 43px column and wrapped to three lines;
  the row now wraps so each annotation gets its own full-width line

**App-wide scroll bug (Billy: "i cant scroll down the page to see the rest of the card"):**
- [x] `client/src/App.tsx` — the shell is `h-screen` and `<main>` was `overflow-hidden`, so
  ANY page taller than the window was clipped with no scrollbar. It only worked where a page
  remembered to add its own `h-full overflow-auto` (settings.tsx, logs.tsx did; families,
  ipo-filings and scan did not). `<main>` is now `overflow-y-auto`, so no page can be clipped
  again and new pages need no workaround. Verified by wheel-scrolling all 8 pages

**"It says it saved but I cant see the contact in my iOS":** saving writes to Sensei; nothing
pushes a contact to the phone. The save had worked (Editha I. Alcantara = person 3336) — the
hand-off was missing and the vCard was a bare download icon.
- [x] After saving, the page now shows a hand-off screen: "saved to Sensei only — it does not
  touch your phone", with a primary **Add to my phone** button, Open in Sensei, and Done.
  It lives at PAGE level: saving removes the card from the queue, so a panel-level success
  state unmounted immediately (that was the first attempt, caught in the browser)
- [x] vCard is served `Content-Disposition: inline` (was `attachment`): on iOS an attachment
  lands in Files and never reaches Contacts, while inline `text/vcard` makes Safari offer
  "Add to Contacts". `?download=1` still forces the attachment form for desktop
- [x] RFC 6350 §3.2 line folding (`foldVCardLine`): lines were up to 118 octets against a
  75-octet limit, which strict parsers reject. Folds on byte boundaries so an em dash or a
  Chinese name in a NOTE is never split
- [x] The header vCard button is a phone icon titled "Contact card for your phone (.vcf)"

### Still worth doing (from this scan)
- [x] Auto-crop: the model now returns `cardBounds` (the card's rectangle as 0-1 fractions)
  and the UI crops to it with CSS over the original image — no re-encoding, no new dependency,
  and the full photo is kept for audit and "Enlarge". `normalizeBounds` rejects a box that is
  inverted, tiny or off-frame rather than cropping the card in half.
  **Prompt lesson:** the first version used `{"x":0,"y":0,"width":1,"height":1}` as the schema
  example and the model simply echoed it every time. A non-trivial example plus "MEASURE it
  from this photo — the numbers above are only an example of the format" fixed it: Billy's
  card on a wooden table now reports {x:0.09, y:0.29, w:0.81, h:0.43}
- [ ] Deskew (rotating a card photographed at an angle) — still open

## 2026-09-25 — Business card scanner ✅ shipped (v1)

**Trigger:** Billy asked for a smart scanner that adds the "+" and understands international
dialling conventions, fixes ALL-CAPS to proper case, looks up the company, and does both
single and batch capture — "think about how we can use AI".

**Research (Sept 2026, 12 apps):** CamCard, ABBYY, Covve, HiHello, Haystack, Sansan/Eight,
ScanBizCards, Wantedly People, Blinq, Popl, Habsy, Card2Gold. They converge on batch capture,
both sides, bilingual cards, enrichment, dedupe, one-tap save, "where we met", reminders.
**Nobody documents** (a) E.164 normalisation with the country inferred from the card plus the
SEA labels (DID/HP/M/O/F/ext), or (b) SEA name handling (Tan Sri/Dato'/Dr, Chinese surname
order, ALL CAPS without breaking McDonald/d'Souza/DBS). Sansan only gets there with humans.
That gap is the wedge. Design: `docs/plans/2026-09-25-business-card-scanner-design.md`.

### Shipped
- [x] `server/card-normalize.ts` — PURE, 100+ assertions. Phones→E.164 via libphonenumber-js/max
  (country order: explicit + → card address → sibling number → SG default), label→typed slot,
  extensions (ext/x/#); honorific split (Tan Sri, Dato' Seri, Datuk, Khun, Haji, Dr…);
  Title Case that preserves McDonald/MacLeod/O'Brien/d'Souza/bin/binti/a-l/van der and leaves
  deliberate mixed case alone; Chinese/Thai script untouched and word order never reordered;
  company + title casing with a SEA dictionary (Pte Ltd, Sdn Bhd, PT/Tbk, DBS/UOB/OCBC/CIMB);
  email/url/LinkedIn validation that BLANKS rather than guesses; RFC 6350 vCard 3.0
- [x] `server/card-scanner.ts` — gemini-2.5-flash vision (claude-sonnet-4 fallback + "re-read"),
  prompt transcribes verbatim and never tidies; dedupe by email/E.164 phone (conclusive → merge)
  and by name (suggestion); enrichment (company site, LinkedIn) that only accepts a hit whose
  domain/URL contains the company token or surname; failures stored as `failed` rows, never dropped
- [x] `shared/schema.ts` — `business_cards` table (images, raw + parsed + confidence, duplicates,
  status, batchId, eventNote); `contact_meta` gains phone_mobile/office/other, job_title,
  company_name, linkedin_url, website, address, honorific, native_name, card_id
- [x] `server/routes-cards.ts` — scan, scan-batch (≤25), list+counts, get, reparse, save, delete,
  vcard download. `express.json` limit raised to 16mb for data-URL images
- [x] Telegram: photo/document/caption/media_group on `TelegramUpdate`, `getTelegramFilePath` +
  `downloadTelegramFileAsDataUrl` + `sendTelegramDocument` (all new); `server/telegram-cards.ts`
  handles a photo (or an album, debounced 2.5s, one card per photo) → parsed contact + Save /
  Fix / Re-read / Discard buttons → `.vcf` document to tap-save to the phone
- [x] `client/src/pages/scan.tsx` + sidebar entry — camera capture, drag-drop batch, client-side
  downscale to 1600px, queue with status tabs, review form with amber rings on low-confidence
  fields, duplicate banner, vCard download. Deep link `/scan?card=<id>` from the Telegram Fix button
- [x] **Bug found and fixed en route:** Telegram polling never requested `callback_query`
  (`allowed_updates` was left at a stale list from an old setWebhook), so EVERY inline button —
  card actions and the existing lead Save/Dismiss/Mute — was silently dead. Now sent explicitly.
  Also cleared a stale orphan process that had been blocking polling since 2026-09-24 12:47.

### Verified
- `npm run check` clean; `npm test` 234/234 (new `tests/card-normalize.test.ts`)
- Two synthetic cards (ALL-CAPS SG + mixed-case MY) end to end in ~2.5s each:
  "TAN SRI DATO' LIM KOK THAY" → honorific "Tan Sri Dato'" + name "Lim Kok Thay" + 林国泰;
  DID 6225 1234 ext 205 → +6562251234 x205 office; HP → +6591234567 mobile; F → fax;
  MY card with no country code → +60321181118 / +60123456789 from the KL address
- Live endpoints: scan, batch (2 cards, 18s), vCard download, save → contact_meta + company link;
  duplicate by email caught on a re-scan; invalid/empty input rejected. Test rows cleaned up
- Scan page screenshotted at desktop and 430px mobile width

### Deferred to v2 (not built)
- [x] Drafted follow-up message (email/WhatsApp) — `draftFollowUp` in `server/follow-ups.ts`
  writes from the notes ONLY; the prompt forbids inventing a conversation, a shared contact
  or a business detail, so a sparse note gives a short honest note rather than a fluent lie.
  Honorifics are used. `FollowUpDraftDialog` on the person page, editable + copy
- [x] Follow-up reminders — `contact_meta.remind_at` existed but NOTHING ever fired on it.
  Daily cron (09:00 SGT) sends a Telegram digest of everything due, each line carrying the
  "where we met" note that makes the reminder worth anything. Reminder buttons on the card
  save screen (tomorrow / 3 days / a week) and in the draft dialog
- [x] Bug caught in testing: the digest read `TELEGRAM_CHAT_ID` from the environment, which
  is not where this app keeps it — every other feature reads `settings.telegramChatId`, so
  the digest would have silently sent nothing forever
- [ ] Google Contacts OAuth sync (vCard covers the phone today)
- [x] QR / vCard / MECARD / LinkedIn-QR decode — `client/src/lib/card-qr.ts` decodes in the
  BROWSER (canvas already has the pixels, so no server image-decoding dependency) and the
  payload is folded over the model's reading in `applyQrHint`. A vCard QR is EXACT data —
  someone typed it, no OCR — so its fields win; a LinkedIn or website QR only fills a gap.
  Handles RFC 6350 line folding, escaped characters, and TEL TYPE labels (CELL→Mobile,
  FAX→Fax). 33 assertions incl. a fold→parse round-trip through our own writer.
  Verified end to end: jsQR read the code off a generated card and recovered
  "Khun Dhanin Chearavanont", both phones with correct slots, email and website.
  Telegram-sourced photos have no browser, so those still use the vision model
- [x] Job-change alerts — `server/job-changes.ts`. A daily cron checks 8 saved contacts
  (longest-unchecked first, re-check every 30 days, background search budget, blocked people
  skipped), asks whether the role on file still holds, and Telegrams anything that moved with
  the source link. The prompt defaults to "no change": a repeated profile page, a reworded
  title, or a namesake are explicitly NOT changes, and low confidence is dropped — a banker
  gets one shot at "congratulations on the new role". Nothing is written to the contact
  automatically; Billy confirms. **Verified on a real contact:** the card said "Treasurer &
  Director" and the watch found "Vice Chairperson and Treasurer" with a source URL
- [ ] Offline capture with later sync

## 2026-09-19 — Family trees: pass 2 + dedupe ✅ shipped; renderer + blocking planned

**Trigger:** Billy: "it didn't seem to be crawling properly and the family tree as a visual is
very basic". Review found: pass 1 finished 2026-09-14 (204 done / 91 needs_review), worker
ticking `queue-empty` hourly since; 22% of members have no edge (330/1,504), 68 families are
just the seeded patriarch, Vietnam avg 2.2 members; root cause = synthesis only ever saw
search snippets (≤1,200 chars), never a full page. 7 exact-name duplicate people inside
families (lifestyle scanner inserts people keyed on name+region, bypassing the shared
upsert), ~15 overlapping seed families sharing a patriarch. `person_blocks` is still empty.

### 1. Pass 2 — research with real pages ✅
- [x] `server/family-pages.ts`: Wikipedia search (free MediaWiki API, EN + the market's own
  language: th/id/vi/ms — Thai/Vietnamese articles carry the parents/spouse/children the
  English ones lack) with a title-relevance filter (fuzzy hits like "Thai Chinese" rejected);
  direct page fetch (SSRF-guarded), scrape.do only as fallback (max 1/family, never on 404);
  family-aware extraction (infobox Spouse/Children/Relatives rows, whole "Family"/"Notable
  members" sections incl. tables, family-word paragraphs elsewhere; 7k chars/page; 60s budget)
- [x] `family-research.ts`: 3 pages/family fed as `[P1] FULL PAGE` blocks ahead of the snippets;
  known members AND known edges passed back so a pass extends the tree; review decision counts
  members/edges from the DB after the run; relationships may name roster members the model did
  not re-list; `dedupeFamilyMembers` at the end of every run; LLM call capped at 120s
- [x] Queue: `claimNext` = pending → failed → needs_review older than 7 days (attempts cap
  applies), thinnest trees first; `requeueAllFamilies()` + `POST /api/families/research/requeue-all`
  + "Re-research all" button on the progress card; `POST /api/families/:id/research?now=1`
  researches one family immediately (research-now)
- [x] Seeder: must name ≥2 public members, honorifics stripped (`family-names.ts`), anchors already
  seeded in the country skipped; `POST /api/families/research/seed/:market`

### 2. Dedupe + seed cleanup ✅
- [x] `lifestyle-scanner.ts` upsertPerson → `resolvePersonByName` (was matching on name+region)
- [x] `dedupeExactNamePeople()` (89 rows folded in 82 groups), `mergeOverlappingFamilies()`
  (same patriarch, or ≥3 shared members = 60%+ of the smaller; survivor = fewer-word name →
  surname most members carry → bigger tree) — 17 families merged (Wee Ee Cheong + Wee Piew →
  Wee; Jiaravanon → Chearavanont; Le (Vinfast) + Phan (Vingroup) → Pham; Ganda → Tanoto; …);
  `pruneThinFamilies()`; all with dryRun via `POST /api/families/maintenance/dedupe` and
  `POST /api/families/maintenance/prune/:country`
- [x] Vietnam: 29 one-person seeds deleted, 12 reseeded (stricter prompt; still LLM-recall-limited,
  the pass will flag the wrong ones as needs_review)
- [x] Verified: `npm run check` clean, `npm test` 71/71 (new `tests/family-pages.test.ts`);
  deployed 2026-09-19 09:1x UTC; full pass requeued (261 families, thin trees first, ~11 days at
  1/hour — `FAMILY_RESEARCH_CRON="20,50 * * * *"` halves that). Live runs: Chirathivat 18m/2e →
  21m/4e, Chearavanont 16m/16e → 17m/20e, Kanjanapas 5m/2e → 8m/6e, Yoovidhya 6m/5e → 7m/7e in
  18–29s each; Lua/Tejapaibul/Darmawan honestly still empty (no public tree)

### 3. Proper tree renderer ✅ (2026-09-25)
- [x] `client/src/lib/family-layout.ts` — a PURE, unit-tested genealogy layout (35 assertions
  in `tests/family-layout.test.ts`). Not a generic tree lib: a child hangs from a COUPLE, so
  it builds units (person or married pair), assigns generations by relaxation (bounded, so
  cyclic bad data cannot hang the UI), then does a tidy-tree x-pass with a downward
  re-centring pass. Deterministic — same input, same geometry
- [x] `client/src/components/FamilyTree.tsx` — SVG connectors under HTML cards in one
  transformed container: pan by drag, ⌘/Ctrl+scroll zoom, fit-to-view, generation bands
  (Founder / G2 / G3 · youngest), photo or initials avatar, company + net worth, ★ on the
  family head, collapsible branches with a "+N" badge, orthogonal descent lines, a spouse
  bar and dashed sibling links
- [x] Blocked people: red fill for a direct block, amber for one propagated from a relative,
  each with its own legend entry — the conflict is visible spreading through the tree
- [x] "Not linked yet" is now a labelled strip under the tree saying how many people the
  sources never connected, each clickable to open the relationship editor
- [x] **Bug worth remembering:** the cards first rendered as a diagonal staircase. The
  `hover-elevate` utility sets `position: relative` at a higher specificity than Tailwind's
  `absolute`, so every absolutely-positioned card fell into normal flow and its coordinates
  became offsets. Never put `hover-elevate` on an absolutely positioned element
- [x] Person page (/people/:id) shows an "Immediate family" mini-tree — parents above,
  spouse beside, children below — rendered by the same `FamilyTree` component, with a link
  through to the full tree

### 4. Make blocking easy — ✅ in progress (2026-09-25)
- [x] `client/src/components/BlockPersonDialog.tsx` — the block dialog extracted from the
  family page so the family tree and the person page share one implementation. Parents come
  pre-checked (Billy's rule), spouse/siblings/children are opt-in, reason + "covered by"
- [x] Person page: "Mark as covered" / "Unblock" buttons. Blocking was previously reachable
  ONLY from inside a family tree, which is why `person_blocks` had stayed empty since 09-02
- [x] `getPersonProfile` relationships now carry a machine-readable `kind`
  (parent/child/spouse/sibling) and each relative's `blocked` flag, so the dialog does not
  parse English labels
- [x] Families page: a "Blocked" tab listing every covered person, direct vs "via <relative>",
  who covers them, with links to the person and their family
- [x] Verified end to end: blocking Wee Ee Cheong propagated to his father Wee Cho Yaw
  (direct + propagated rows), and the tree renders him red and his father amber "via family"
- [x] Lead card: a "⛔ covered?" chip beside each founder name in the feed, opening the same
  dialog with relatives fetched from the person profile
- [x] Telegram: a "⛔ Covered" button on every lead alert. `blockByNames` resolves each
  founder, blocks them AND their parents automatically (the one propagation safe to apply
  unasked), then replies naming exactly who was blocked and who is not in Sensei yet —
  a silent block would be worse than none
- [x] Telegram alert buttons: "⛔ Covered" on a lead alert — shipped 2026-09-25 (see above)
- [x] Weekly note carries a coverage line: who was marked covered this week and how many
  relatives were blocked with them ("No new coverage conflicts this week." when none)
- [x] Pipeline: a covered lead still shows with the ⛔ badge (Billy's 2026-09-02 rule), and
  Settings now has "Hide leads about covered people", off by default. When on, a lead is
  hidden only if EVERY person it names is covered — the same shape as the mute rule

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
- [x] needs_review queue UI; person merge/dedupe review (shipped 2026-09-08 with Program 2)
- [x] "Re-research family" button (Requeue + research-now shipped 2026-09-19);
      per-person lazy enrichment on view — folded into the person page

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

## Program 2 (approved by Billy 2026-09-08 evening) — running as 4 parallel workstreams

Billy's answers: 1 family review queue OK · 2 leads↔families/contacts OK · 3 Telegram as the
phone product YES · 4 prompts in Settings YES · 5 Tavily fixed by Billy (he asked why so many
searches: 763 of ~1067 since Sep 1 were the family worker at 6/family; now 4/family + cache) ·
6 person page/history YES · 7 weekly "what I learned" note YES · 8 hygiene OK.

- [x] **T — Telegram + weekly note** (server/telegram*.ts, health-monitor.ts, weekly-note.ts)
- [x] **F — Family review queue** (families.ts, family-research.ts, routes-families.ts, families UI)
- [x] **P — Prompts in Settings** (schema pipeline_prompts, prompts.ts, routes-prompts.ts, settings.tsx,
      pipeline-stages.ts/scanner.ts load prompts)
- [x] **L — Lead↔family/contact chips + person page** (dashboard.tsx, routes-people.ts, person.tsx)
- [x] **Me** — routes wired, ensure-* retired, LLM sites converted, SendGrid removed, deployed 2026-09-08 ~21:30 UTC
- Open: weekly note "dismissed" count is approximate (no status_changed_at column); the 16 old
  failed families show no reason until requeued; Founders page name now links to /people/:id

## Current Program (approved by Billy 2026-09-08): make Sensei self-improving, observable, robust

**Decisions (Billy):** 1 learning loop over hard-coded rules (it teaches itself, he teaches it);
2 visual errors in Sensei + Telegram pings when things go bad; 3 prompts editable/versioned in
settings with reference articles; 4 schema consolidation — do it via one-time ownership reassign
(local Postgres, superuser available) rather than migrations; 5-8 approved as proposed.

### Phase D — DB ownership + schema consolidation ✅ 2026-09-08
- [x] Ownership: all 54 public tables + sequences now owned by newsuser (ALTER TABLE per table;
  REASSIGN OWNED failed because postgres is the bootstrap role). Done 2026-09-08.
- [x] Drift inspected via information_schema (drizzle-kit pull is broken in this install):
  `db:push` would DROP 27 legacy tables (v1 `leads` 1632 rows, `saved_leads` 2, `contacts` 10,
  `*_v2` draft tables, lifestyle_leads, publications, scrape_log, …) and 6 unused columns on
  leads_v2 (analyzed_by_model, article_id, banker_angle, event_type, relevance_score, source_id).
- [x] Billy OK'd 2026-09-08: 27 legacy tables dumped to
  /root/backups/sensei/legacy-tables-20260908-2050.sql.gz (2.3 MB) and dropped. Unique
  constraints renamed to Drizzle naming, missing FKs/indexes added; `npm run db:push` is now a
  clean no-op and the schema mechanism going forward. The 6 live leads_v2 columns were kept
  (they hold data) and added to schema.ts. ensure-*-table.ts files can be retired one by one.

### Phase A — Health + alerting ✅ deployed 2026-09-08 20:09 UTC
- [x] `server/health.ts`: checks for DB, LLM gateway (last call ok/err via openai-client wrapper),
  scraper credits, web-search quota, last scan age/errors, Stage-6 parse failures, family worker,
  Telegram send. Each: ok | warn | error + message. `GET /api/health`.
- [x] `server/health-monitor.ts`: cron every 15 min; Telegram on transition to warn/error (re-ping
  after 6h if still bad; recovery message); daily 08:00 SGT digest.
- [x] UI: header banner (red/amber → /debug) + Debug "System health" card replacing Integrations.

### Phase B — Learning loop ✅ deployed 2026-09-08 20:09 UTC
- [x] `pipeline_examples` table + server/pipeline-examples.ts (list/upsert/delete/summary/run)
- [x] GET /api/pipeline/funnel (per stage + reason with samples), examples CRUD endpoints
- [x] client/src/components/RejectionFunnel.tsx mounted on Debug: funnel bars, "Should pass" /
  "Should reject" / re-run per article, "What Sensei has been taught" with re-check-all
- [x] Prompts learn: feedback-prompt.ts now emits negatives + positives (flagged misses + last 5
  saved leads) under the existing export, so every scan's S1 prompt carries both
- [x] scanner.ts: `url` on ArticleProcessed entries + dryRun mode (skips dedup gates, never persists)
- [x] Nightly examples cron (examples-cron.ts, 03:30 SGT) + POST /api/pipeline/examples/run; pass
  rate on the Debug page ("What Sensei has been taught"). Digest line for it: TODO

### Phase E — Refactor + deletions ✅ (partial, see notes)
- [x] `callJsonStage()` (server/llm-json.ts) replaces 12 call sites; 6 remain (telegram-commands,
  lifestyle-scanner ×2, backfill-lifestyle-geo ×2, ipo-scanner needs a systemPrompt option)
- [x] Deleted: Ollama client, gpt-4o-mini reprocess script, knowledge-only enrichers.
  SendGrid still wired via routes.ts + settings — remove in a follow-up with the Settings UI

### Phase C — Prompts in settings ✅ (shipped 2026-09-08)
- [x] `pipeline_prompts` + versions; Settings editor with all 8 prompts

### Phase F — Budgets + UX
- [x] web-search.ts: `priority: "background"` draws from SEARCH_BACKGROUND_DAILY_CAP (120/day);
  live calls never wait; family-research.ts searches are "background"
- [x] Feed sort: priority band (high/med/low) then newest — a week-old 90 no longer pins above today's 85
- [x] Radar duplicates already collapse on the dashboard (existing bestLeadIds dedup); deal value +
  wealth angle already render on the card — they were just never persisted until today

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
