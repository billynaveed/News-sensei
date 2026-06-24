import { and, eq } from "drizzle-orm";
import { db } from "./db";
import { researchCache } from "@shared/schema";
import { openai } from "./openai-client";
import { stripJsonFences } from "./json-utils";
import { log } from "./log";

// Resolve where a FOUNDER actually lives using the model's world knowledge,
// rather than hoping the article states it. This is the reliable geo signal:
// an LLM knows Rupert Murdoch is US/AU and Anthony Tan (Grab) is Singapore.
// Cheap model + per-person cache (in-memory + research_cache) so each person is
// looked up at most once.

const MODEL = "google/gemini-2.5-flash-lite";
const TARGETS = "Singapore, Malaysia, Indonesia, Thailand, Vietnam, Philippines, Hong Kong, Taiwan";

type Geo = { inTarget: boolean | null; location: string };
const memCache = new Map<string, Geo>();

export async function resolveFounderGeo(name: string, company?: string | null): Promise<Geo> {
  const key = name.trim().toLowerCase();
  if (!key) return { inTarget: null, location: "" };
  if (memCache.has(key)) return memCache.get(key)!;

  try {
    const [cached] = await db
      .select()
      .from(researchCache)
      .where(and(eq(researchCache.query, key), eq(researchCache.entityType, "founder_geo")))
      .limit(1);
    if (cached) {
      const v = cached.result as Geo;
      memCache.set(key, v);
      return v;
    }
  } catch { /* cache miss */ }

  const prompt = `Where does ${name}${company ? ` (associated with ${company})` : ""} CURRENTLY live and run their affairs from — their primary residence and base TODAY?
Judge by where they actually reside/operate now, NOT merely their birthplace: someone born in the region who long ago relocated abroad (e.g. a Taiwan-born CEO now based in the US) is NOT in target.
Target regions = ${TARGETS}. NOT in target: mainland China, Japan, Korea, India, the US, UK, Europe, Australia, the Middle East, etc.
Use your knowledge of who this person is. Return JSON only:
{"location":"Country (or City, Country) — where they live now","in_target_region": true | false | null}
Set in_target_region=null ONLY if you genuinely cannot identify this person.`;

  let v: Geo = { inTarget: null, location: "" };
  try {
    const res = await openai.chat.completions.create({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      response_format: { type: "json_object" },
    });
    const parsed = JSON.parse(stripJsonFences(res.choices[0]?.message?.content || "{}"));
    v = {
      inTarget: typeof parsed.in_target_region === "boolean" ? parsed.in_target_region : null,
      location: String(parsed.location || ""),
    };
  } catch (e) {
    log(`[founder-geo] lookup failed for "${name}": ${e instanceof Error ? e.message : e}`, "geo");
    return { inTarget: null, location: "" }; // fail-open on error (don't drop)
  }

  memCache.set(key, v);
  try {
    await db.insert(researchCache).values({ query: key, entityType: "founder_geo", result: v });
  } catch { /* best-effort cache */ }
  return v;
}

/**
 * Decide whether a lead's founders keep it in-region. Keep if ANY founder is in
 * a target region, or if geography is unknown (fail-open). Drop only when EVERY
 * named founder is confidently outside the target regions.
 */
export async function foundersKeepLead(
  founderNames: string[],
  companyNames: string[],
): Promise<{ keep: boolean; reason: string }> {
  const names = (founderNames || []).filter(Boolean);
  if (names.length === 0) return { keep: true, reason: "no named founder to geo-check" };
  const company = (companyNames || []).filter(Boolean)[0] ?? null;

  const results = await Promise.all(names.map((n) => resolveFounderGeo(n, company)));
  if (results.some((r) => r.inTarget === true)) return { keep: true, reason: "founder in target region" };
  if (results.some((r) => r.inTarget === null)) return { keep: true, reason: "founder geography unknown (kept)" };

  const locs = names.map((n, i) => `${n}: ${results[i].location || "foreign"}`).join("; ");
  return { keep: false, reason: `all founders outside target region (${locs})` };
}
