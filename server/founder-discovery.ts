/**
 * Founder discovery for leads whose article names no individual.
 *
 * A $400M acquisition of a private SEA company is a founder liquidity event
 * even when the wire story only names the acquirer's executives. Rather than
 * shipping a lead with an empty founder list, look the founders up (one web
 * search + a tiny LLM read) so Stage 6b geography and Stage 7 enrichment have
 * names to work with. Results are cached in research_cache for 90 days.
 */

import { openai } from "./openai-client";
import { db } from "./db";
import { researchCache } from "@shared/schema";
import { and, eq, gt, sql } from "drizzle-orm";
import { searchWeb } from "./web-search";
import { stripJsonFences } from "./json-utils";
import { log } from "./log";

const CACHE_ENTITY = "company_founders";
const CACHE_TTL_DAYS = 90;

export interface DiscoveredFounder {
  name: string;
  role: string | null;
  location: string | null;
}

export async function discoverFounders(companyName: string, hint?: string | null): Promise<DiscoveredFounder[]> {
  const name = companyName.trim();
  if (name.length < 2) return [];

  const cutoff = new Date(Date.now() - CACHE_TTL_DAYS * 86_400_000);
  const [cached] = await db
    .select({ result: researchCache.result })
    .from(researchCache)
    .where(and(eq(researchCache.entityType, CACHE_ENTITY), sql`lower(${researchCache.query}) = ${name.toLowerCase()}`, gt(researchCache.createdAt, cutoff)))
    .limit(1);
  if (cached) return cached.result as DiscoveredFounder[];

  // Two short queries: search engines punish long/quoted strings.
  const queries = [`${name} founders CEO${hint ? ` ${hint}` : ""}`, `who founded ${name}`];
  const seen = new Map<string, { title: string; url: string; content: string }>();
  let answer: string | undefined;
  for (const q of queries) {
    const search = await searchWeb(q, { maxResults: 6, includeAnswer: true });
    answer = answer || search?.answer;
    for (const r of search?.results ?? []) if (r.url && !seen.has(r.url)) seen.set(r.url, r);
    if (seen.size >= 6) break;
  }
  const results = Array.from(seen.values());
  if (results.length === 0) return [];
  const search = { answer };

  const context = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${(r.content || "").slice(0, 600)}`).join("\n\n");
  const prompt = `From these search results, list the founders and CEO of the company "${name}"${hint ? ` (${hint})` : ""}.

${search?.answer ? `Search summary: ${search.answer}\n\n` : ""}${context}

Return JSON only: {"founders": [{"name": "Full name", "role": "e.g. Co-founder & CEO", "location": "City, Country where they are based, or null"}]}
Rules: only people explicitly tied to "${name}" in the results; never guess; empty array if unsure; max 5 people, CEO/founders first.`;

  try {
    const response = await openai.chat.completions.create({
      model: "google/gemini-2.5-flash-lite",
      messages: [{ role: "user", content: prompt }],
      max_completion_tokens: 300,
      temperature: 0.1,
      response_format: { type: "json_object" },
    });
    const parsed = JSON.parse(stripJsonFences(response.choices[0]?.message?.content || "{}"));
    const founders: DiscoveredFounder[] = (Array.isArray(parsed.founders) ? parsed.founders : [])
      .filter((f: any) => f && typeof f.name === "string" && f.name.trim().split(/\s+/).length >= 2)
      .slice(0, 5)
      .map((f: any) => ({ name: f.name.trim(), role: f.role || null, location: f.location || null }));
    await db.insert(researchCache).values({ query: name, entityType: CACHE_ENTITY, result: founders }).catch(() => {});
    log(`[FounderDiscovery] ${name}: ${founders.map((f) => f.name).join(", ") || "none found"}`, "pipeline");
    return founders;
  } catch (error) {
    log(`[FounderDiscovery] failed for ${name}: ${(error as Error).message}`, "pipeline");
    return [];
  }
}
