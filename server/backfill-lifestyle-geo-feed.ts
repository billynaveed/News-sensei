/**
 * Second-pass backfill: apply the SEA geography gate directly to lifestyle rows
 * in the MAIN `leads` (feed) table.
 *
 * The first pass (backfill-lifestyle-geo.ts) only iterated lifestyle_articles
 * with status="extracted". But the feed accumulated lifestyle leads from older
 * articles that have since moved to other statuses (or were deduped away), so
 * ~700 feed rows were never re-checked. This pass operates on the feed row's OWN
 * stored text (headline + aiSummary + wealthAngle), runs the same
 * validateSeaAnchor rule, and deletes the out-of-region ones.
 *
 * Scope: only feed leads NOT already tied to a kept ("extracted") lifestyle
 * article — those were handled (kept) by pass 1. Fail-closed, same as the live gate.
 *
 * Usage:
 *   npx tsx server/backfill-lifestyle-geo-feed.ts          # dry-run
 *   npx tsx server/backfill-lifestyle-geo-feed.ts --apply   # commit
 */
import "dotenv/config";
import OpenAI from "openai";
import { and, eq, sql } from "drizzle-orm";
import { db } from "./db";
import { stripJsonFences } from "./json-utils";
import { validateSeaAnchor } from "./sea-guard";
import { leads, lifestyleArticles } from "@shared/schema";

const APPLY = process.argv.includes("--apply");
const CONCURRENCY = 8;

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
  timeout: 30_000,
  maxRetries: 2,
});
const MODEL = "google/gemini-2.5-flash-lite";

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

async function deriveGeo(lead: typeof leads.$inferSelect) {
  const text = [lead.aiSummary, lead.wealthAngle].filter(Boolean).join("\n").slice(0, 8000);
  const prompt = `For the PRIMARY wealthy individual in this lead, report where they are based and what (if anything) anchors them to a Target Region.

Target Regions = Southeast Asia + Hong Kong + Taiwan ONLY (Singapore, Malaysia, Indonesia, Thailand, Vietnam, Philippines, Hong Kong, Taiwan).
Mainland China, Japan, Korea, India, the US/UK/EU and Australia are OUT of target.

Headline: ${lead.headline}
Summary: ${text}

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
  // Feed lifestyle leads NOT tied to a kept ("extracted") lifestyle article.
  const rows = await db
    .select()
    .from(leads)
    .where(and(
      eq(leads.category, "lifestyle"),
      sql`NOT EXISTS (SELECT 1 FROM ${lifestyleArticles} la WHERE la.url = ${leads.sourceUrl} AND la.status = 'extracted')`,
    ));

  console.log(`\n${APPLY ? "APPLY" : "DRY-RUN"} — re-checking ${rows.length} orphan lifestyle feed lead(s) (concurrency ${CONCURRENCY}).\n`);

  let done = 0;
  let errors = 0;
  const verdicts = await mapLimit(rows, CONCURRENCY, async (lead) => {
    let guard;
    try {
      const geo = await deriveGeo(lead);
      guard = validateSeaAnchor({
        hqLocation: geo.hq_location ?? null,
        founderLocations: Array.isArray(geo.founder_locations) ? geo.founder_locations : null,
        seaEvidenceType: geo.sea_evidence_type ?? "none",
        seaEvidenceText: geo.sea_evidence_text ?? "",
      });
    } catch {
      errors++;
      guard = null;
    }
    done++;
    if (done % 50 === 0) process.stdout.write(`  …${done}/${rows.length} checked\n`);
    return { lead, guard };
  });

  const rejects = verdicts.filter((v) => v.guard && !v.guard.passes);
  const kept = verdicts.filter((v) => v.guard && v.guard.passes).length;

  console.log(`\n── Sample of geo-rejections (first 25) ──`);
  for (const { lead, guard } of rejects.slice(0, 25)) {
    console.log(`  ❌ [${lead.priorityScore ?? "?"}] ${lead.headline}`);
    console.log(`       ${guard!.reason}`);
  }

  let deleted = 0;
  if (APPLY) {
    for (const { lead } of rejects) {
      const del = await db.delete(leads).where(eq(leads.id, lead.id)).returning({ id: leads.id });
      deleted += del.length;
    }
  }

  console.log(`\n── Summary ─────────────────────────────`);
  console.log(`  checked          : ${rows.length}`);
  console.log(`  kept (in-region) : ${kept}`);
  console.log(`  rejected (geo)   : ${rejects.length}`);
  console.log(`  LLM errors (skipped): ${errors}`);
  if (APPLY) console.log(`  feed leads deleted  : ${deleted}`);
  else console.log(`\n  (dry-run — no changes written. Re-run with --apply to commit.)`);
  console.log(`────────────────────────────────────────\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
