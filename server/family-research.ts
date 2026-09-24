/**
 * Family research agent — slow-burn worker that builds family trees for the
 * top SEA business families. Runs inside the Sensei server on node-cron
 * (~1 family/hour) so ~300 seed families take roughly two weeks per pass.
 *
 * Per family: a handful of web searches → up to three FULL pages (Wikipedia
 * first, via the free MediaWiki search; then profile pages) → claude-sonnet-4
 * synthesis into a strict JSON tree (members, relationships, confidence,
 * source URLs) → rows in family_members / family_relationships, reusing
 * `people` via resolvePersonByName. Re-running a family extends its tree: the
 * known members and edges are fed back in, and inserts are conflict-safe.
 * The agent NEVER blocks anyone — blocks are human-only.
 */

import cron, { type ScheduledTask } from "node-cron";
import { and, asc, eq, lt, or, sql } from "drizzle-orm";
import { db } from "./db";
import { log } from "./log";
import { getPrompt, render } from "./prompts";
import { callJsonStage } from "./llm-json";
import { searchWeb } from "./web-search";
import { dedupeFamilyMembers, normalizeNameKey, resolvePersonByName } from "./families";
import { stripHonorifics } from "./family-names";
import { PAGES_PER_FAMILY, WIKI_LANG_BY_COUNTRY, fetchFamilyPages, rankPageCandidates, wikipediaLookup, type FamilyPage } from "./family-pages";
import { families, familyMembers, familyRelationships, people, type Family } from "@shared/schema";

const MODEL = "anthropic/claude-sonnet-4";
const SOURCE_TAG = "family-research";

// Budget guards. Searches are the metered resource (Tavily/Brave); the cron
// cadence already caps LLM calls at ~24 families/day. Page fetches are direct
// HTTP (free) with the metered scraper only as a fallback.
const MAX_ATTEMPTS = 3;
const SEARCHES_PER_FAMILY = parseInt(process.env.FAMILY_RESEARCH_SEARCHES_PER_FAMILY || "4", 10);
const DAILY_SEARCH_CAP = parseInt(process.env.FAMILY_RESEARCH_DAILY_SEARCH_CAP || "200", 10);
const SEEDS_PER_MARKET = parseInt(process.env.FAMILY_RESEARCH_SEEDS_PER_MARKET || "50", 10);
/** A needs_review family is retried once this many days have passed (new sources may exist). */
const REVISIT_DAYS = parseInt(process.env.FAMILY_RESEARCH_REVISIT_DAYS || "7", 10);
const CRON = process.env.FAMILY_RESEARCH_CRON || "20 * * * *"; // hourly at :20
const ENABLED = process.env.FAMILY_RESEARCH_ENABLED !== "false";

export const SEA_MARKETS: { code: string; name: string }[] = [
  { code: "SG", name: "Singapore" },
  { code: "ID", name: "Indonesia" },
  { code: "MY", name: "Malaysia" },
  { code: "TH", name: "Thailand" },
  { code: "PH", name: "Philippines" },
  { code: "VN", name: "Vietnam" },
];

let task: ScheduledTask | null = null;
let kickoff: NodeJS.Timeout | null = null;
let running = false;
let searchBudget = { day: "", used: 0 };
let lastRun: { at: string; familyId: string | null; name: string | null; status: string; detail?: string; error?: string } | null = null;

function budgetDay() {
  return new Date().toISOString().slice(0, 10);
}
function searchesLeftToday(): number {
  if (searchBudget.day !== budgetDay()) searchBudget = { day: budgetDay(), used: 0 };
  return Math.max(0, DAILY_SEARCH_CAP - searchBudget.used);
}

// jsonMode is off: `seedMarket` asks for a top-level JSON *array*, which strict
// json_object mode can push the model into wrapping in an object.
async function chatJson<T>(prompt: string, maxTokens: number): Promise<T> {
  return callJsonStage<T>({
    model: MODEL,
    prompt,
    maxTokens,
    temperature: 0.2,
    label: "FamilyResearch",
    jsonMode: false,
    // A tree synthesis is ~15k tokens in, ≤6k out; anything past two minutes
    // is a stuck gateway call, and the worker must not hold the queue for it.
    timeoutMs: 120_000,
  });
}

// ---------------------------------------------------------------------------
// Seeding: ~50 families per market, inserted as researchStatus=pending.
// ---------------------------------------------------------------------------

type SeedFamily = {
  familyName: string;
  anchorPerson: string;
  knownMembers?: string[];
  primaryCompanies: string[];
  netWorthEstimate: string | null;
};

/**
 * The seeder can only be as good as the model's recall for a market. Vietnam
 * pass 1 produced 29 one-person "families" built from a company name and a
 * guessed surname, so a seed now has to name two public members, and an anchor
 * that is already the patriarch of a seeded family in the same country is
 * skipped (the LLM likes to list "Vingroup" three times under three surnames).
 */
async function seedMarket(market: { code: string; name: string }, limit = SEEDS_PER_MARKET): Promise<number> {
  const prompt = `List the ${limit} wealthiest and most prominent business families of ${market.name} (Southeast Asia) as of today — the families a private banker would want mapped. Include established dynasties (tycoons, conglomerate founders) and newer founder families with large liquid wealth. Use the country's published rich lists (Forbes ${market.name} / Forbes Asia, local business press) as your reference.

Return ONLY a JSON array, no prose, each item:
{"familyName": "Surname family, e.g. 'Kwek family' (add the main company in brackets only when the surname is common, e.g. 'Nguyen family (Techcombank)')", "anchorPerson": "Full name of the living patriarch/matriarch or best-known current leader, as most commonly written in English-language press, WITHOUT honorifics (no Tan Sri / Dato / Khun)", "knownMembers": ["2+ other family members you can name from public reporting (spouse, children, siblings) — full names"], "primaryCompanies": ["1-3 main companies"], "netWorthEstimate": "e.g. 'US$5B' or null"}

Rules: one entry per family (no duplicates, no variant spellings, never the same anchor person twice); families must be ${market.name}-based or primarily associated with ${market.name}; the anchor must be a real, publicly documented person — never guess a surname from a company name; skip any family for which you cannot name at least two members besides the anchor.`;

  const seeds = await chatJson<SeedFamily[]>(prompt, 8000);
  if (!Array.isArray(seeds)) throw new Error(`seed for ${market.code}: not an array`);

  const existingAnchors = new Set(
    (await db.execute(sql`
      SELECT p.full_name FROM families f JOIN people p ON p.id = f.patriarch_person_id WHERE f.country = ${market.name}
    `)).rows.map((r: any) => normalizeNameKey(r.full_name as string)),
  );

  let inserted = 0;
  for (const s of seeds) {
    const name = stripHonorifics((s?.familyName || "").trim());
    const anchor = stripHonorifics((s?.anchorPerson || "").trim());
    const known = Array.isArray(s?.knownMembers) ? s.knownMembers.filter((m) => typeof m === "string" && m.trim().length >= 3) : [];
    if (name.length < 3 || anchor.length < 3 || known.length < 2) continue;
    if (existingAnchors.has(normalizeNameKey(anchor))) continue;
    const [dup] = await db
      .select({ id: families.id })
      .from(families)
      .where(and(sql`lower(${families.name}) = lower(${name})`, eq(families.country, market.name)))
      .limit(1);
    if (dup) continue;

    const { person: patriarch } = await resolvePersonByName(anchor, { source: "family-seed", nationality: market.name });
    const [fam] = await db
      .insert(families)
      .values({
        name,
        country: market.name,
        primaryCompanies: Array.isArray(s.primaryCompanies) ? s.primaryCompanies.filter(Boolean).slice(0, 3) : [],
        netWorthEstimate: s.netWorthEstimate || null,
        patriarchPersonId: patriarch.id,
        researchStatus: "pending",
      })
      .returning();
    await db.insert(familyMembers).values({ familyId: fam.id, personId: patriarch.id }).onConflictDoNothing();
    existingAnchors.add(normalizeNameKey(anchor));
    inserted++;
  }
  return inserted;
}

/** Seed all markets (or one, by code). Idempotent: existing (name, country) pairs and anchors are skipped. */
export async function seedFamilies(marketCode?: string): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  const markets = marketCode ? SEA_MARKETS.filter((m) => m.code === marketCode.toUpperCase()) : SEA_MARKETS;
  if (markets.length === 0) throw new Error(`unknown market "${marketCode}"`);
  for (const market of markets) {
    try {
      result[market.code] = await seedMarket(market);
      log(`[family-research] seeded ${result[market.code]} families for ${market.name}`, "families");
    } catch (error) {
      result[market.code] = -1;
      log(`[family-research] seed failed for ${market.name}: ${(error as Error).message}`, "families");
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Research one family
// ---------------------------------------------------------------------------

type ResearchOutput = {
  description: string | null;
  netWorthEstimate: string | null;
  patriarch: string | null;
  members: { name: string; role?: string | null; notes?: string | null; confidence?: string }[];
  relationships: { from: string; to: string; type: "parent" | "spouse" | "sibling"; confidence?: string; sourceUrl?: string | null }[];
  confidence: "high" | "medium" | "low";
  sourceUrls: string[];
};

type Snippet = { title: string; url: string; content: string };

/**
 * Searches (metered) + full pages (free). The pages are what make pass 2
 * different from pass 1: a Wikipedia family article states every parent/child
 * pair, where a search snippet only ever shows the patriarch.
 */
async function gatherSources(family: Family, anchorName: string | null) {
  const anchor = anchorName || family.name;
  const company = family.primaryCompanies?.[0];
  const queries = [
    `${family.name} ${family.country} family members children`,
    `${anchor} wife husband children`,
    `${anchor} son daughter successor ${company ?? ""}`.trim(),
    `${family.name} ${family.country} family tree next generation`,
    `${anchor} Forbes family`,
    `${family.name} family ${family.country} Tatler OR "family business" succession`,
  ].slice(0, SEARCHES_PER_FAMILY);

  const seen = new Map<string, Snippet>();
  let used = 0;
  for (const q of queries) {
    if (searchesLeftToday() <= 0) break;
    searchBudget.used++;
    used++;
    const res = await searchWeb(q, { maxResults: 5, includeAnswer: false, priority: "background" });
    for (const r of res?.results ?? []) {
      if (r.url && !seen.has(r.url)) seen.set(r.url, { title: r.title, url: r.url, content: (r.content || "").slice(0, 1200) });
    }
  }

  // Wikipedia is unmetered, so always ask it — family article first, then the
  // anchor, then the anchor on the market's own-language edition (Thai /
  // Indonesian / Vietnamese articles carry trees English ones lack).
  const wiki = await wikipediaLookup([`${family.name} ${family.country}`, anchorName ?? ""].filter((q) => q.trim().length > 3));
  const localLang = family.country ? WIKI_LANG_BY_COUNTRY[family.country] : undefined;
  const localWiki = localLang && anchorName ? await wikipediaLookup([anchorName], 1, localLang) : [];
  const candidates = rankPageCandidates(
    [...wiki, ...localWiki, ...Array.from(seen.keys()), ...(family.sourceUrls ?? [])],
    PAGES_PER_FAMILY * 3,
  );
  const pages = await fetchFamilyPages(candidates, PAGES_PER_FAMILY);

  return { sources: Array.from(seen.values()), pages, searchesUsed: used };
}

/**
 * Why a researched family cannot be trusted as-is, phrased for the review
 * queue ("only 1 member found"). `null` means the tree is good enough to mark
 * done without a human looking at it.
 */
function needsReviewReason(
  memberCount: number,
  edgeCount: number,
  confidence: string,
  sourceCount: number,
): string | null {
  if (memberCount < 2) return `only ${memberCount} member${memberCount === 1 ? "" : "s"} found in ${sourceCount} sources`;
  if (edgeCount === 0) return `${memberCount} members but no relationships could be sourced`;
  if (confidence === "low") return `low model confidence over ${sourceCount} sources`;
  return null;
}

function canonicalEdge(from: number, to: number, type: "parent" | "spouse" | "sibling") {
  // spouse/sibling are symmetric — store lowest id first so the unique index dedupes.
  if (type !== "parent" && from > to) return { fromPersonId: to, toPersonId: from, type };
  return { fromPersonId: from, toPersonId: to, type };
}

function formatContext(pages: FamilyPage[], sources: Snippet[]): string {
  const pageBlocks = pages.map((p, i) => `[P${i + 1}] FULL PAGE: ${p.title}\nURL: ${p.url}\n${p.text}`);
  const snippetBlocks = sources.map((s, i) => `[S${i + 1}] ${s.title}\nURL: ${s.url}\n${s.content}`);
  return [...pageBlocks, ...snippetBlocks].join("\n\n");
}

async function researchFamily(family: Family): Promise<void> {
  const anchor = family.patriarchPersonId
    ? (await db.select({ fullName: people.fullName }).from(people).where(eq(people.id, family.patriarchPersonId)))[0]?.fullName ?? null
    : null;
  const existingMembers = (await db.execute(sql`
    SELECT p.full_name FROM family_members fm JOIN people p ON p.id = fm.person_id WHERE fm.family_id = ${family.id}
  `)).rows.map((r: any) => r.full_name as string);
  const existingEdges = (await db.execute(sql`
    SELECT a.full_name AS "from", r.type, b.full_name AS "to"
      FROM family_relationships r
      JOIN people a ON a.id = r.from_person_id
      JOIN people b ON b.id = r.to_person_id
     WHERE r.family_id = ${family.id}
  `)).rows as { from: string; type: string; to: string }[];

  const { sources, pages, searchesUsed } = await gatherSources(family, anchor);
  if (sources.length === 0 && pages.length === 0) {
    throw new Error(`no search results or pages (searches used: ${searchesUsed}, left today: ${searchesLeftToday()})`);
  }

  const knownLines: string[] = [];
  if (existingMembers.length) knownLines.push(`Already-known members (reuse these exact spellings): ${existingMembers.join("; ")}.`);
  if (existingEdges.length) {
    knownLines.push(
      `Already-known relationships (keep them, add the missing ones): ${existingEdges
        .map((e) => `${e.from} → ${e.to} (${e.type})`)
        .join("; ")}.`,
    );
  }

  const prompt = render(await getPrompt("family_research"), {
    familyName: family.name,
    country: family.country ?? "",
    anchorClause: anchor ? ` The anchor person is "${anchor}".` : "",
    companiesClause: family.primaryCompanies?.length ? ` Main companies: ${family.primaryCompanies.join(", ")}.` : "",
    knownMembersLine: knownLines.join("\n"),
    sources: formatContext(pages, sources),
  });

  const out = await chatJson<ResearchOutput>(prompt, 6000);
  const members = Array.isArray(out.members) ? out.members.filter((m) => m?.name && m.name.trim().length >= 3) : [];
  const rels = Array.isArray(out.relationships) ? out.relationships : [];

  // Keyed on the normalized name so a relationship written "Leng Beng Kwek"
  // still resolves to the member listed as "Kwek Leng Beng".
  const idByName = new Map<string, number>();
  const nameKey = (n: string) => normalizeNameKey(n) || n.trim().toLowerCase();
  let reusedVariants = 0;
  for (const m of members) {
    // resolvePersonByName reuses an existing people row when the LLM wrote the
    // name with different casing, punctuation or token order.
    const { person, reusedVariant } = await resolvePersonByName(m.name.trim(), {
      source: SOURCE_TAG,
      nationality: family.country,
    });
    if (reusedVariant) reusedVariants++;
    idByName.set(nameKey(m.name), person.id);
    await db.insert(familyMembers).values({ familyId: family.id, personId: person.id }).onConflictDoNothing();
    // Fill blanks on the person only — never overwrite existing data.
    await db
      .update(people)
      .set({
        familyName: sql`coalesce(${people.familyName}, ${family.name})`,
        bio: m.role ? sql`coalesce(${people.bio}, ${[m.role, m.notes].filter(Boolean).join(". ")})` : people.bio,
        updatedAt: new Date(),
      })
      .where(eq(people.id, person.id));
  }
  // Relationships may name a member known from a previous pass that the model
  // did not repeat in `members`; resolve those against the family's roster.
  const roster = (await db.execute(sql`
    SELECT p.id, p.full_name, p.aliases FROM family_members fm JOIN people p ON p.id = fm.person_id WHERE fm.family_id = ${family.id}
  `)).rows as { id: number; full_name: string; aliases: string[] | null }[];
  for (const r of roster) {
    if (!idByName.has(nameKey(r.full_name))) idByName.set(nameKey(r.full_name), r.id);
    for (const a of r.aliases ?? []) if (!idByName.has(nameKey(a))) idByName.set(nameKey(a), r.id);
  }

  let edges = 0;
  for (const r of rels) {
    if (!r?.from || !r?.to || !["parent", "spouse", "sibling"].includes(r.type)) continue;
    const from = idByName.get(nameKey(r.from));
    const to = idByName.get(nameKey(r.to));
    if (!from || !to || from === to) continue;
    const edge = canonicalEdge(from, to, r.type);
    const inserted = await db
      .insert(familyRelationships)
      .values({ familyId: family.id, ...edge, confidence: r.confidence || out.confidence || "low", sourceUrl: r.sourceUrl || null })
      .onConflictDoNothing()
      .returning({ id: familyRelationships.id });
    edges += inserted.length;
  }

  // Two spellings of one person may have slipped in as two rows; fold them.
  const deduped = await dedupeFamilyMembers(family.id);

  const patriarchId = out.patriarch ? idByName.get(nameKey(out.patriarch)) : undefined;
  const [{ members: totalMembers, edges: totalEdges } = { members: 0, edges: 0 }] = (await db.execute(sql`
    SELECT (SELECT count(*)::int FROM family_members WHERE family_id = ${family.id}) AS members,
           (SELECT count(*)::int FROM family_relationships WHERE family_id = ${family.id}) AS edges
  `)).rows as { members: number; edges: number }[];

  const level = out.confidence || "low";
  const sourceCount = sources.length + pages.length;
  const reviewReason = needsReviewReason(totalMembers, totalEdges, level, sourceCount);
  const status = reviewReason ? "needs_review" : "done";
  const usedUrls = [
    ...pages.map((p) => p.url),
    ...(Array.isArray(out.sourceUrls) ? out.sourceUrls : sources.map((s) => s.url)),
  ];
  await db
    .update(families)
    .set({
      description: out.description || family.description,
      netWorthEstimate: out.netWorthEstimate || family.netWorthEstimate,
      patriarchPersonId: patriarchId ?? family.patriarchPersonId,
      // The review queue reads the reason back out of this field.
      confidence: reviewReason ? `${level}: ${reviewReason}` : level,
      sourceUrls: Array.from(new Set(usedUrls.filter(Boolean))).slice(0, 20),
      researchStatus: status,
      researchedAt: new Date(),
      researchAttempts: sql`${families.researchAttempts} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(families.id, family.id));

  const detail = `${totalMembers} members (+${edges} edges → ${totalEdges}), ${pages.length} pages, ${sources.length} snippets`;
  log(
    `[family-research] ${family.name} (${family.country}): ${detail}; ${reusedVariants} variant spellings reused, ${deduped} duplicate members folded, confidence=${level} → ${status}${reviewReason ? ` (${reviewReason})` : ""}`,
    "families",
  );
  lastRun = { at: new Date().toISOString(), familyId: family.id, name: family.name, status, detail };
}

/**
 * Claim the next queued family: pending first, then failed with attempts
 * left, then needs_review families not looked at for REVISIT_DAYS (newer
 * sources may have appeared). Within a bucket, families with the fewest
 * edges go first. With `familyId`, that family is claimed whatever its
 * status (the "research now" action), unless it is a manual tree.
 */
async function claimNext(familyId?: string): Promise<Family | null> {
  const revisitBefore = new Date(Date.now() - REVISIT_DAYS * 24 * 60 * 60 * 1000);
  const [family] = familyId
    ? await db
        .select()
        .from(families)
        .where(and(eq(families.id, familyId), sql`${families.researchStatus} <> 'manual'`))
        .limit(1)
    : await db
        .select()
        .from(families)
        .where(
          or(
            eq(families.researchStatus, "pending"),
            and(eq(families.researchStatus, "failed"), lt(families.researchAttempts, MAX_ATTEMPTS)),
            and(
              eq(families.researchStatus, "needs_review"),
              lt(families.researchAttempts, MAX_ATTEMPTS),
              lt(families.researchedAt, revisitBefore),
            ),
          ),
        )
        .orderBy(
          sql`case ${families.researchStatus} when 'pending' then 0 when 'failed' then 1 else 2 end`,
          asc(families.researchAttempts),
          // Thinnest trees first, so a new pass shows visible gains fastest.
          sql`(select count(*) from family_relationships r where r.family_id = ${families.id})`,
          asc(families.createdAt),
        )
        .limit(1);
  if (!family) return null;
  await db.update(families).set({ researchStatus: "researching", updatedAt: new Date() }).where(eq(families.id, family.id));
  return family;
}

/**
 * One tick: research a single family — the next in the queue, or the given
 * one right now. Safe to call from cron or an endpoint.
 */
export async function runFamilyResearchOnce(familyId?: string): Promise<{ researched: string | null; status: string; detail?: string }> {
  if (running) return { researched: null, status: "already-running" };
  running = true;
  try {
    if (searchesLeftToday() < SEARCHES_PER_FAMILY) {
      lastRun = { at: new Date().toISOString(), familyId: null, name: null, status: "budget-exhausted" };
      return { researched: null, status: "budget-exhausted" };
    }
    const family = await claimNext(familyId);
    if (!family) return { researched: null, status: familyId ? "not-found" : "queue-empty" };
    try {
      await researchFamily(family);
      return { researched: family.name, status: "ok", detail: lastRun?.detail };
    } catch (error) {
      const message = (error as Error).message;
      await db
        .update(families)
        .set({
          researchStatus: "failed",
          // Same field the review queue reads for needs_review reasons, so the
          // Failed tab can show what actually went wrong.
          confidence: `error: ${message.slice(0, 200)}`,
          researchAttempts: sql`${families.researchAttempts} + 1`,
          researchedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(families.id, family.id));
      log(`[family-research] ${family.name} failed: ${message}`, "families");
      lastRun = { at: new Date().toISOString(), familyId: family.id, name: family.name, status: "failed", error: message };
      return { researched: family.name, status: "failed" };
    }
  } finally {
    running = false;
  }
}

/** Queue a family for (re-)research regardless of its current status. */
export async function requeueFamily(familyId: string) {
  await db
    .update(families)
    .set({ researchStatus: "pending", researchAttempts: 0, updatedAt: new Date() })
    .where(eq(families.id, familyId));
}

/**
 * Start a fresh pass over every agent-researched family (manual trees are
 * left alone). Existing members and edges are kept — a pass extends a tree,
 * it never clears one. `claimNext` takes the thinnest trees first.
 */
export async function requeueAllFamilies(): Promise<number> {
  const rows = (await db.execute(sql`
    UPDATE families
       SET research_status = 'pending', research_attempts = 0, updated_at = now()
     WHERE research_status <> 'manual'
     RETURNING id
  `)).rows;
  log(`[family-research] requeued ${rows.length} families for a new pass`, "families");
  return rows.length;
}

export async function getResearchProgress() {
  const rows = (await db.execute(sql`SELECT research_status AS status, count(*)::int AS n FROM families GROUP BY 1`)).rows as { status: string; n: number }[];
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = r.n;
  const agentTotal = Object.entries(counts).filter(([s]) => s !== "manual").reduce((a, [, n]) => a + n, 0);
  const researched = (counts.done ?? 0) + (counts.needs_review ?? 0);
  return {
    enabled: ENABLED,
    running,
    cron: CRON,
    counts,
    total: agentTotal,
    researched,
    remaining: (counts.pending ?? 0) + (counts.researching ?? 0),
    searchesLeftToday: searchesLeftToday(),
    pagesPerFamily: PAGES_PER_FAMILY,
    lastRun,
  };
}

/** Recover rows stuck in "researching" from a crash mid-run. */
async function recoverStuck() {
  await db
    .update(families)
    .set({ researchStatus: "pending", updatedAt: new Date() })
    .where(eq(families.researchStatus, "researching"));
}

async function tick(reason: string) {
  try {
    const progress = await getResearchProgress();
    if (progress.total === 0) {
      log(`[family-research] no seed families yet — seeding all markets (${reason})`, "families");
      await seedFamilies();
    }
    const r = await runFamilyResearchOnce();
    log(`[family-research] tick (${reason}): ${r.status}${r.researched ? ` — ${r.researched}` : ""}`, "families");
  } catch (error) {
    log(`[family-research] tick error: ${(error as Error).message}`, "families");
  }
}

export function startFamilyResearch() {
  stopFamilyResearch();
  if (!ENABLED) {
    console.log("Family research worker disabled (FAMILY_RESEARCH_ENABLED=false)");
    return;
  }
  recoverStuck().catch(() => {});
  task = cron.schedule(CRON, () => tick("cron"));
  // First tick shortly after boot so a fresh deploy starts working without
  // waiting for the next cron slot.
  kickoff = setTimeout(() => tick("startup"), 90_000);
  console.log(`Family research worker started (cron "${CRON}", ${DAILY_SEARCH_CAP} searches/day cap, ${PAGES_PER_FAMILY} pages/family)`);
}

export function stopFamilyResearch() {
  if (task) { task.stop(); task = null; }
  if (kickoff) { clearTimeout(kickoff); kickoff = null; }
}
