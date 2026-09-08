/**
 * Family research agent — slow-burn worker that builds family trees for the
 * top SEA business families. Runs inside the Sensei server on node-cron
 * (~1 family/hour) so ~300 seed families take roughly two weeks.
 *
 * Per family: a handful of web searches → claude-sonnet-4 synthesis into a
 * strict JSON tree (members, relationships, confidence, source URLs) → rows in
 * family_members / family_relationships, reusing `people` via
 * upsertPersonByName. The agent NEVER blocks anyone — blocks are human-only.
 */

import cron, { type ScheduledTask } from "node-cron";
import { and, asc, eq, lt, or, sql } from "drizzle-orm";
import { db } from "./db";
import { log } from "./log";
import { getPrompt, render } from "./prompts";
import { callJsonStage } from "./llm-json";
import { searchWeb } from "./web-search";
import { upsertPersonByName } from "./contacts";
import { normalizeNameKey, resolvePersonByName } from "./families";
import { families, familyMembers, familyRelationships, people, type Family } from "@shared/schema";

const MODEL = "anthropic/claude-sonnet-4";
const SOURCE_TAG = "family-research";

// Budget guards. Searches are the metered resource (Tavily/Brave); the cron
// cadence already caps LLM calls at ~24 families/day.
const MAX_ATTEMPTS = 3;
const SEARCHES_PER_FAMILY = parseInt(process.env.FAMILY_RESEARCH_SEARCHES_PER_FAMILY || "4", 10);
const DAILY_SEARCH_CAP = parseInt(process.env.FAMILY_RESEARCH_DAILY_SEARCH_CAP || "200", 10);
const SEEDS_PER_MARKET = parseInt(process.env.FAMILY_RESEARCH_SEEDS_PER_MARKET || "50", 10);
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
let lastRun: { at: string; familyId: string | null; name: string | null; status: string; error?: string } | null = null;

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
  });
}

// ---------------------------------------------------------------------------
// Seeding: ~50 families per market, inserted as researchStatus=pending.
// ---------------------------------------------------------------------------

type SeedFamily = { familyName: string; anchorPerson: string; primaryCompanies: string[]; netWorthEstimate: string | null };

async function seedMarket(market: { code: string; name: string }): Promise<number> {
  const prompt = `List the ${SEEDS_PER_MARKET} wealthiest and most prominent business families of ${market.name} (Southeast Asia) as of today — the families a private banker would want mapped. Include established dynasties (tycoons, conglomerate founders) and newer founder families with large liquid wealth.

Return ONLY a JSON array, no prose, each item:
{"familyName": "Surname family, e.g. 'Kwek family'", "anchorPerson": "Full name of the living patriarch/matriarch or best-known current leader (the name as most commonly written in English-language press)", "primaryCompanies": ["1-3 main companies"], "netWorthEstimate": "e.g. 'US$5B' or null"}

Rules: one entry per family (no duplicates, no variant spellings); families must be ${market.name}-based or primarily associated with ${market.name}; skip families you are not confident exist.`;

  const seeds = await chatJson<SeedFamily[]>(prompt, 6000);
  if (!Array.isArray(seeds)) throw new Error(`seed for ${market.code}: not an array`);

  let inserted = 0;
  for (const s of seeds) {
    const name = (s?.familyName || "").trim();
    const anchor = (s?.anchorPerson || "").trim();
    if (name.length < 3 || anchor.length < 3) continue;
    const [dup] = await db
      .select({ id: families.id })
      .from(families)
      .where(and(sql`lower(${families.name}) = lower(${name})`, eq(families.country, market.name)))
      .limit(1);
    if (dup) continue;

    const patriarch = await upsertPersonByName(anchor, { source: "family-seed", nationality: market.name });
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
    inserted++;
  }
  return inserted;
}

/** Seed all markets. Idempotent: existing (name, country) pairs are skipped. */
export async function seedFamilies(): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const market of SEA_MARKETS) {
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

  const seen = new Map<string, { title: string; url: string; content: string }>();
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
  return { sources: Array.from(seen.values()), searchesUsed: used };
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

async function researchFamily(family: Family): Promise<void> {
  const anchor = family.patriarchPersonId
    ? (await db.select({ fullName: people.fullName }).from(people).where(eq(people.id, family.patriarchPersonId)))[0]?.fullName ?? null
    : null;
  const existingMembers = (await db.execute(sql`
    SELECT p.full_name FROM family_members fm JOIN people p ON p.id = fm.person_id WHERE fm.family_id = ${family.id}
  `)).rows.map((r: any) => r.full_name as string);

  const { sources, searchesUsed } = await gatherSources(family, anchor);
  if (sources.length === 0) throw new Error(`no search results (searches used: ${searchesUsed}, left today: ${searchesLeftToday()})`);

  const context = sources.map((s, i) => `[${i + 1}] ${s.title}\nURL: ${s.url}\n${s.content}`).join("\n\n");
  const prompt = render(await getPrompt("family_research"), {
    familyName: family.name,
    country: family.country ?? "",
    anchorClause: anchor ? ` The anchor person is "${anchor}".` : "",
    companiesClause: family.primaryCompanies?.length ? ` Main companies: ${family.primaryCompanies.join(", ")}.` : "",
    knownMembersLine: existingMembers.length ? `Already-known members (reuse these exact spellings): ${existingMembers.join("; ")}.` : "",
    sources: context,
  });

  const out = await chatJson<ResearchOutput>(prompt, 4000);
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

  const patriarchId = out.patriarch ? idByName.get(nameKey(out.patriarch)) : undefined;
  const [{ total: totalEdges } = { total: 0 }] = (await db.execute(sql`
    SELECT count(*)::int AS total FROM family_relationships WHERE family_id = ${family.id}
  `)).rows as { total: number }[];

  const level = out.confidence || "low";
  const reviewReason = needsReviewReason(members.length, totalEdges, level, sources.length);
  const status = reviewReason ? "needs_review" : "done";
  await db
    .update(families)
    .set({
      description: out.description || family.description,
      netWorthEstimate: out.netWorthEstimate || family.netWorthEstimate,
      patriarchPersonId: patriarchId ?? family.patriarchPersonId,
      // The review queue reads the reason back out of this field.
      confidence: reviewReason ? `${level}: ${reviewReason}` : level,
      sourceUrls: Array.isArray(out.sourceUrls) ? out.sourceUrls.slice(0, 20) : sources.map((s) => s.url).slice(0, 20),
      researchStatus: status,
      researchedAt: new Date(),
      researchAttempts: sql`${families.researchAttempts} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(families.id, family.id));

  log(
    `[family-research] ${family.name} (${family.country}): ${members.length} members (${reusedVariants} reused under a variant spelling), ${edges} new edges, ${sources.length} sources, confidence=${level} → ${status}${reviewReason ? ` (${reviewReason})` : ""}`,
    "families",
  );
  lastRun = { at: new Date().toISOString(), familyId: family.id, name: family.name, status };
}

/** Claim the next queued family (pending, or failed with attempts left). */
async function claimNext(): Promise<Family | null> {
  const [family] = await db
    .select()
    .from(families)
    .where(
      or(
        eq(families.researchStatus, "pending"),
        and(eq(families.researchStatus, "failed"), lt(families.researchAttempts, MAX_ATTEMPTS)),
      ),
    )
    .orderBy(asc(families.researchAttempts), asc(families.createdAt))
    .limit(1);
  if (!family) return null;
  await db.update(families).set({ researchStatus: "researching", updatedAt: new Date() }).where(eq(families.id, family.id));
  return family;
}

/** One tick: research a single family. Safe to call from cron or an endpoint. */
export async function runFamilyResearchOnce(): Promise<{ researched: string | null; status: string }> {
  if (running) return { researched: null, status: "already-running" };
  running = true;
  try {
    if (searchesLeftToday() < SEARCHES_PER_FAMILY) {
      lastRun = { at: new Date().toISOString(), familyId: null, name: null, status: "budget-exhausted" };
      return { researched: null, status: "budget-exhausted" };
    }
    const family = await claimNext();
    if (!family) return { researched: null, status: "queue-empty" };
    try {
      await researchFamily(family);
      return { researched: family.name, status: "ok" };
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
  console.log(`Family research worker started (cron "${CRON}", ${DAILY_SEARCH_CAP} searches/day cap)`);
}

export function stopFamilyResearch() {
  if (task) { task.stop(); task = null; }
  if (kickoff) { clearTimeout(kickoff); kickoff = null; }
}
