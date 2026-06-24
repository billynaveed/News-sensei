import { and, eq } from "drizzle-orm";
import { db } from "./db";
import { researchCache } from "@shared/schema";
import { openai } from "./openai-client";
import { stripJsonFences } from "./json-utils";
import { searchWeb, formatSearchContext } from "./web-search";
import { log } from "./log";

// Resolve where a FOUNDER actually lives by running a real web search and judging
// from the evidence — NOT from the model's guess about their name. We only mark
// someone out-of-region when the search results actually establish a foreign
// residence; if the search is inconclusive we keep them (never block on a name).

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
    if (cached) { const v = cached.result as Geo; memCache.set(key, v); return v; }
  } catch { /* cache miss */ }

  let v: Geo = { inTarget: null, location: "" };
  try {
    const q = `Where does ${name}${company ? ` (co-founder/executive of ${company})` : ""} currently live and reside? home country, city, nationality, where they are based`;
    const search = await searchWeb(q, { searchDepth: "basic", maxResults: 6, includeAnswer: true });
    const context = search ? formatSearchContext(search).slice(0, 6000) : "";

    if (!context || context.trim().length < 40) {
      // No usable search evidence — do NOT guess. Keep the lead.
      v = { inTarget: null, location: "" };
    } else {
      const prompt = `Web search results about ${name}${company ? ` (${company})` : ""}:

${context}

Based ONLY on the evidence above, where does ${name} CURRENTLY live / reside / run their affairs from?
Target regions = ${TARGETS}. NOT in target: mainland China, Japan, Korea, India, the US, UK, Europe, Australia, the Middle East, etc.
RULES:
- Decide strictly from the search evidence, NEVER from how the person's name sounds.
- If the results do not clearly establish their current country of residence, set in_target_region = null.
Return JSON only: {"location":"country/city per the evidence (or empty)","in_target_region": true | false | null}`;

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
    }
  } catch (e) {
    log(`[founder-geo] lookup failed for "${name}": ${e instanceof Error ? e.message : e}`, "geo");
    return { inTarget: null, location: "" }; // fail-open on error
  }

  memCache.set(key, v);
  try {
    await db.insert(researchCache).values({ query: key, entityType: "founder_geo", result: v });
  } catch { /* best-effort */ }
  return v;
}

/**
 * Keep a lead unless EVERY named founder is, per the web evidence, confidently
 * outside the target regions. Unknown / no-evidence founders keep the lead.
 */
export async function foundersKeepLead(
  founderNames: string[],
  companyNames: string[],
): Promise<{ keep: boolean; reason: string }> {
  const names = (founderNames || []).filter(Boolean);
  if (names.length === 0) return { keep: true, reason: "no named founder to geo-check" };
  const company = (companyNames || []).filter(Boolean)[0] ?? null;

  const results = await Promise.all(names.map((n) => resolveFounderGeo(n, company)));
  if (results.some((r) => r.inTarget === true)) return { keep: true, reason: "founder in target region (web-verified)" };
  if (results.some((r) => r.inTarget === null)) return { keep: true, reason: "founder geography not established (kept)" };

  const locs = names.map((n, i) => `${n}: ${results[i].location || "foreign"}`).join("; ");
  return { keep: false, reason: `all founders outside target region per web search (${locs})` };
}
