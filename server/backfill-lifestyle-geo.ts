/**
 * One-off backfill: retroactively apply the SEA geography gate to lifestyle
 * leads that were extracted BEFORE the guard existed.
 *
 * The lifestyle pipeline historically had no location filter, so out-of-region
 * UHNW (e.g. Masayoshi Son / Tokyo, Japan) were extracted, alerted, and synced
 * to the main feed. This script re-derives each extracted article's location
 * signals via a lightweight LLM call, runs the SAME validateSeaAnchor rule used
 * live in lifestyle-scanner.ts / scanner.ts, and for anything that fails:
 *   1. flips the lifestyle article to status "filtered_out" (score 0)
 *   2. deletes the synced row from the main `leads` table (category=lifestyle)
 *   3. removes its lifestyle_lead_people associations
 *
 * Fail-closed: identical semantics to the live gate. Idempotent — re-running
 * only ever re-checks the remaining "extracted" rows.
 *
 * Usage:
 *   npx tsx server/backfill-lifestyle-geo.ts          # dry-run (preview only)
 *   npx tsx server/backfill-lifestyle-geo.ts --apply   # commit changes
 */
import "dotenv/config";
import OpenAI from "openai";
import { and, desc, eq } from "drizzle-orm";
import { db } from "./db";
import { stripJsonFences } from "./json-utils";
import { validateSeaAnchor } from "./sea-guard";
import { leads, lifestyleArticles, lifestyleLeadPeople } from "@shared/schema";

const APPLY = process.argv.includes("--apply");
const CONCURRENCY = 8;

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  timeout: 30_000,
  maxRetries: 2,
});
const MODEL = "google/gemini-2.5-flash-lite";

/** Minimal concurrency limiter — runs `fn` over `items`, at most `n` in flight. */
async function mapLimit<T, R>(items: T[], n: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return results;
}

/** Geo-only re-extraction: just the location signals validateSeaAnchor needs. */
async function deriveGeo(article: typeof lifestyleArticles.$inferSelect) {
  const text = (article.fullText || article.summary || article.bankerAngle || article.snippet || "").slice(0, 12000);
  const prompt = `For the PRIMARY wealthy individual in this article, report where they are based and what (if anything) anchors them to a Target Region.

Target Regions = Southeast Asia + Hong Kong + Taiwan ONLY (Singapore, Malaysia, Indonesia, Thailand, Vietnam, Philippines, Hong Kong, Taiwan).
Mainland China, Japan, Korea, India, the US/UK/EU and Australia are OUT of target.

Title: ${article.headline || article.title}
Text: ${text}

Return JSON only:
{
  "founder_locations": [{"name":"string","location":"City, Country or null"}],
  "hq_location": "City, Country or null",
  "sea_evidence_type": "company_hq | founder_base | founder_roots | operational_centre | wealth_event | none",
  "sea_evidence_text": "passage (15+ chars) naming a specific Target Region city/country, or empty string"
}
Use "none" if the only tie to Asia is a SEA publisher, a SEA investor/backer, or vague "Asia expansion".`;

  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.1,
    response_format: { type: "json_object" },
  });
  return JSON.parse(stripJsonFences(response.choices[0]?.message?.content || "{}"));
}

async function main() {
  const articles = await db
    .select()
    .from(lifestyleArticles)
    .where(eq(lifestyleArticles.status, "extracted"))
    .orderBy(desc(lifestyleArticles.createdAt));

  console.log(`\n${APPLY ? "APPLY" : "DRY-RUN"} — re-checking ${articles.length} extracted lifestyle lead(s) against the SEA geography gate (concurrency ${CONCURRENCY}).\n`);

  let done = 0;
  let errors = 0;
  const verdicts = await mapLimit(articles, CONCURRENCY, async (article) => {
    let guard;
    try {
      const geo = await deriveGeo(article);
      guard = validateSeaAnchor({
        hqLocation: geo.hq_location ?? null,
        founderLocations: Array.isArray(geo.founder_locations) ? geo.founder_locations : null,
        seaEvidenceType: geo.sea_evidence_type ?? "none",
        seaEvidenceText: geo.sea_evidence_text ?? "",
      });
    } catch (e) {
      errors++;
      guard = null; // LLM error → leave the row untouched (treated as "skip")
    }
    done++;
    if (done % 50 === 0) process.stdout.write(`  …${done}/${articles.length} checked\n`);
    return { article, guard };
  });

  const rejects = verdicts.filter((v) => v.guard && !v.guard.passes);
  const kept = verdicts.filter((v) => v.guard && v.guard.passes).length;

  // Show a sample of what would be rejected so the decision is auditable.
  console.log(`\n── Sample of geo-rejections (first 25) ──`);
  for (const { article, guard } of rejects.slice(0, 25)) {
    console.log(`  ❌ [${article.relevanceScore ?? "?"}] ${article.headline || article.title}`);
    console.log(`       ${guard!.reason}`);
  }

  let leadsDeleted = 0;
  let peopleUnlinked = 0;
  if (APPLY) {
    for (const { article, guard } of rejects) {
      await db
        .update(lifestyleArticles)
        .set({
          status: "filtered_out",
          filterReason: `geo (backfill): ${guard!.reason}`,
          relevanceScore: 0,
          updatedAt: new Date(),
        })
        .where(eq(lifestyleArticles.id, article.id));

      const delLeads = await db
        .delete(leads)
        .where(and(eq(leads.sourceUrl, article.url), eq(leads.category, "lifestyle")))
        .returning({ id: leads.id });
      leadsDeleted += delLeads.length;

      const delPeople = await db
        .delete(lifestyleLeadPeople)
        .where(eq(lifestyleLeadPeople.lifestyleLeadId, article.id))
        .returning({ id: lifestyleLeadPeople.id });
      peopleUnlinked += delPeople.length;
    }
  }

  console.log(`\n── Summary ─────────────────────────────`);
  console.log(`  checked          : ${articles.length}`);
  console.log(`  kept (in-region) : ${kept}`);
  console.log(`  rejected (geo)   : ${rejects.length}`);
  console.log(`  LLM errors (skipped): ${errors}`);
  if (APPLY) {
    console.log(`  feed leads deleted     : ${leadsDeleted}`);
    console.log(`  person links removed   : ${peopleUnlinked}`);
  } else {
    console.log(`\n  (dry-run — no changes written. Re-run with --apply to commit.)`);
  }
  console.log(`────────────────────────────────────────\n`);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
