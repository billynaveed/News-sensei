/**
 * Stage 1 geography rescue.
 *
 * Stage 1 only sees a headline + ~500-char snippet, so it routinely rejects
 * SEA companies whose SEA anchor is not stated in that snippet (e.g. "Tazapay
 * opens Bengaluru center" — Tazapay is Singapore-HQ). ~85% of weekly rejects
 * are "sea_publisher_only". For deal-shaped articles rejected on geography
 * alone, this module verifies the subject company's HQ (cache → companies
 * table → one web search + a tiny LLM read) and rescues the article when the
 * HQ or founder base is in a target region.
 */

import { openai } from "./openai-client";
import { db } from "./db";
import { companies, researchCache } from "@shared/schema";
import { and, eq, gt, sql } from "drizzle-orm";
import { searchCompanyHeadquarters } from "./web-search";
import { listSeaTerms } from "./sea-guard";
import { stripJsonFences } from "./json-utils";
import { log } from "./log";

const CACHE_ENTITY = "company_hq";
const CACHE_TTL_DAYS = 90;
const DAILY_LOOKUP_CAP = parseInt(process.env.GEO_RESCUE_DAILY_CAP || "60", 10);

/** Stage 1 reasons that mean "rejected on geography only" (the event may still be a wealth event). */
const GEO_ONLY_SIGNALS = [
  "sea_publisher_only",
  "global_company_no_sea_anchor",
  "vague_apac_expansion",
  "sea_customers_only",
  "sea_distribution_only",
];

/** Deal-shaped wording — only these are worth a paid lookup. */
const DEAL_RX = /\b(acqui\w*|buys?|bought|takeover|merger|merge[sd]?|raises?|raised|funding|series [a-e]\b|ipo|listing|exit|sells?|sold|stake|valuation|unicorn|invest\w*|buyout)\b/i;

let budget = { day: "", used: 0 };
function lookupsLeftToday(): number {
  const day = new Date().toISOString().slice(0, 10);
  if (budget.day !== day) budget = { day, used: 0 };
  return Math.max(0, DAILY_LOOKUP_CAP - budget.used);
}

export function shouldAttemptGeoRescue(article: { headline: string; content: string }, stage1Reason: string): boolean {
  const reason = stage1Reason.toLowerCase();
  if (!GEO_ONLY_SIGNALS.some((s) => reason.includes(s))) return false;
  return DEAL_RX.test(`${article.headline} ${article.content.slice(0, 500)}`);
}

export interface CompanyHq {
  companyName: string;
  hqCountry: string | null;
  hqCity: string | null;
  founderBase: string | null;
  isSea: boolean;
  confidence: number;
  evidence: string | null;
  resolvedVia: "cache" | "companies_table" | "web" | "none";
}

function isSeaLocation(...parts: (string | null | undefined)[]): boolean {
  const text = parts.filter(Boolean).join(" ").toLowerCase();
  if (!text) return false;
  return listSeaTerms().some((t) => text.includes(t));
}

async function readCache(name: string): Promise<CompanyHq | null> {
  const cutoff = new Date(Date.now() - CACHE_TTL_DAYS * 86_400_000);
  const [row] = await db
    .select({ result: researchCache.result })
    .from(researchCache)
    .where(and(eq(researchCache.entityType, CACHE_ENTITY), sql`lower(${researchCache.query}) = ${name.toLowerCase()}`, gt(researchCache.createdAt, cutoff)))
    .limit(1);
  return row ? ({ ...(row.result as CompanyHq), resolvedVia: "cache" }) : null;
}

async function writeCache(name: string, hq: CompanyHq) {
  await db.insert(researchCache).values({ query: name, entityType: CACHE_ENTITY, result: hq });
}

/** Resolve where a company is headquartered (and where its founders sit). */
export async function resolveCompanyHq(companyName: string): Promise<CompanyHq> {
  const name = companyName.trim();
  const none: CompanyHq = { companyName: name, hqCountry: null, hqCity: null, founderBase: null, isSea: false, confidence: 0, evidence: null, resolvedVia: "none" };
  if (name.length < 2) return none;

  const cached = await readCache(name);
  if (cached) return cached;

  const [known] = await db
    .select({ hqCountry: companies.hqCountry, hqCity: companies.hqCity })
    .from(companies)
    .where(sql`lower(${companies.name}) = ${name.toLowerCase()}`)
    .limit(1);
  if (known?.hqCountry) {
    const hq: CompanyHq = { ...none, hqCountry: known.hqCountry, hqCity: known.hqCity, isSea: isSeaLocation(known.hqCountry, known.hqCity), confidence: 90, evidence: "companies table", resolvedVia: "companies_table" };
    return hq;
  }

  if (lookupsLeftToday() <= 0) {
    log(`[GeoRescue] daily lookup cap reached, skipping ${name}`, "pipeline");
    return none;
  }
  budget.used++;

  const search = await searchCompanyHeadquarters(name);
  const results = search?.results ?? [];
  if (results.length === 0) return none;

  const context = results.slice(0, 5).map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${(r.content || "").slice(0, 600)}`).join("\n\n");
  const prompt = `From the search results, determine where the company "${name}" is headquartered and where its founders/CEO are based.

${search?.answer ? `Search summary: ${search.answer}\n\n` : ""}${context}

Return JSON only:
{"hqCity": "city or null", "hqCountry": "country or null", "founderBase": "city/country where founders or CEO live, or null", "confidence": 0-100, "evidence": "one short quoted phrase from the results"}
If the results are about a different company with a similar name, return nulls with confidence 0.`;

  try {
    const response = await openai.chat.completions.create({
      model: "google/gemini-2.5-flash-lite",
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: 200,
      temperature: 0.1,
      response_format: { type: "json_object" },
    });
    const parsed = JSON.parse(stripJsonFences(response.choices[0]?.message?.content || "{}"));
    const hq: CompanyHq = {
      companyName: name,
      hqCountry: parsed.hqCountry || null,
      hqCity: parsed.hqCity || null,
      founderBase: parsed.founderBase || null,
      confidence: Number(parsed.confidence) || 0,
      evidence: parsed.evidence || null,
      isSea: false,
      resolvedVia: "web",
    };
    hq.isSea = hq.confidence >= 60 && isSeaLocation(hq.hqCountry, hq.hqCity, hq.founderBase);
    await writeCache(name, hq).catch(() => {});
    return hq;
  } catch (error) {
    log(`[GeoRescue] HQ read failed for ${name}: ${(error as Error).message}`, "pipeline");
    return none;
  }
}

/** Human-readable anchor note, prepended to article content so Stages 6/6b see the verified geography. */
export function hqNote(hq: CompanyHq): string {
  const where = [hq.hqCity, hq.hqCountry].filter(Boolean).join(", ");
  const founder = hq.founderBase ? ` Founders/CEO based in ${hq.founderBase}.` : "";
  return `[Verified: ${hq.companyName} is headquartered in ${where || hq.founderBase}.${founder}]`;
}
