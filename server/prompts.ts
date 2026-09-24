/**
 * Editable, versioned pipeline prompts.
 *
 * Every LLM prompt the news pipeline sends is a *template* with a code default
 * (`DEFAULT_PROMPTS`). Billy can override any of them from Settings; the
 * override lives in `pipeline_prompts` and every save appends a row to
 * `pipeline_prompt_versions`, so a bad edit is one click from being reverted.
 *
 * Templates use `{{placeholder}}` variables rendered by `render()`. Each key
 * declares the variables it supports (`PROMPT_META`), which is both the
 * documentation shown in the editor and the validation applied on save — a body
 * referencing an unknown variable is rejected rather than silently rendering a
 * literal `{{typo}}` into a prompt.
 *
 * Reads go through a 60s in-memory cache so a scan of 200 articles does not
 * issue 800 SELECTs; every mutation calls `invalidatePromptCache()`.
 */

import { and, desc, eq } from "drizzle-orm";
import { db } from "./db";
import {
  DEFAULT_INTEREST_FILTER_PROMPT,
  pipelinePrompts,
  pipelinePromptVersions,
  type PipelinePromptVersion,
} from "@shared/schema";
import { storage } from "./storage";
import { log } from "./log";

// ============================================================================
// Keys + variable catalogue
// ============================================================================

export const PROMPT_KEYS = [
  "stage1_interest",
  "stage1_regional_rules",
  "stage2_company",
  "stage3_public",
  "stage4_dedup",
  "stage6_analysis",
  "family_research",
  "founder_discovery",
] as const;

export type PromptKey = (typeof PROMPT_KEYS)[number];

const PROMPT_KEY_SET = new Set<string>(PROMPT_KEYS);

export function isPromptKey(value: string): value is PromptKey {
  return PROMPT_KEY_SET.has(value);
}

/** One `{{name}}` slot a template may use, with what it is filled with. */
export interface PromptVariable {
  name: string;
  description: string;
}

export interface PromptMeta {
  key: PromptKey;
  /** Short human label for the Settings list. */
  label: string;
  /** What this prompt decides, and where it sits in the pipeline. */
  description: string;
  /**
   * False while the prompt still lives only as a default here: the module that
   * sends it has not been switched over to `getPrompt()` yet, so edits are
   * stored but not yet used. Surfaced in the UI so nobody edits into a void.
   */
  wired: boolean;
  variables: PromptVariable[];
}

export const PROMPT_META: Record<PromptKey, PromptMeta> = {
  stage1_interest: {
    key: "stage1_interest",
    label: "Stage 1 — Interest filter",
    description:
      "The relevance criteria for every article: which wealth events count and which do not. " +
      "Prepended to the regional-rules block below, and followed by the learned examples block.",
    wired: true,
    variables: [],
  },
  stage1_regional_rules: {
    key: "stage1_regional_rules",
    label: "Stage 1 — Regional rules + output",
    description:
      "Appended to the interest filter: the strict SEA/HK/Taiwan geography test, the article " +
      "itself, and the JSON shape Stage 1 must return.",
    wired: true,
    variables: [
      { name: "regions", description: "Target regions from Settings, comma-separated." },
      { name: "headline", description: "Article headline." },
      { name: "snippet", description: "First 500 characters of the article." },
      { name: "source", description: "Source name the article came from." },
    ],
  },
  stage2_company: {
    key: "stage2_company",
    label: "Stage 2 — Company extraction",
    description:
      "Picks the one company an article is about (the acquisition target, not the acquirer; " +
      "never the publisher). Its answer drives Stage 3, dedup and enrichment.",
    wired: true,
    variables: [
      { name: "headline", description: "Article headline." },
      { name: "content", description: "First 500 characters of the article." },
    ],
  },
  stage3_public: {
    key: "stage3_public",
    label: "Stage 3 — Public company check",
    description:
      "Filters out already-listed companies. Pre-IPO companies must stay private — their " +
      "founders are the prospects.",
    wired: true,
    variables: [
      { name: "companyName", description: "Company name from Stage 2." },
      { name: "headline", description: "Article headline, for context." },
    ],
  },
  stage4_dedup: {
    key: "stage4_dedup",
    label: "Stage 4 — Duplicate vs update",
    description:
      "Only runs when the company is already a saved lead: decides whether the new article is " +
      "a genuine follow-up event or a rehash of the one already saved.",
    wired: true,
    variables: [
      { name: "existingSummary", description: "AI summary (or headline) of the already-saved lead." },
      { name: "headline", description: "Headline of the new article." },
      { name: "snippet", description: "First 500 characters of the new article." },
    ],
  },
  stage6_analysis: {
    key: "stage6_analysis",
    label: "Stage 6 — Deep analysis",
    description:
      "The big one. Reads the full article and produces the lead: companies, founders, " +
      "investors, deal value, priority score, wealth angle and the SEA evidence the " +
      "deterministic guard checks.",
    wired: true,
    variables: [
      { name: "headline", description: "Article headline." },
      { name: "source", description: "Source name the article came from." },
      { name: "content", description: "Full article text, truncated to 6000 characters." },
      { name: "regions", description: "Target regions from Settings, comma-separated." },
    ],
  },
  family_research: {
    key: "family_research",
    label: "Family research synthesis",
    description:
      "Turns web-search results into a family tree (members + parent/spouse/sibling edges). " +
      "Reference only for now — server/family-research.ts still sends its own copy.",
    wired: true,
    variables: [
      { name: "familyName", description: 'Family name, e.g. "Wee family".' },
      { name: "country", description: "Family's country." },
      { name: "anchorClause", description: 'Sentence naming the anchor person, or empty. Includes its own leading space.' },
      { name: "companiesClause", description: "Sentence listing the family's main companies, or empty. Includes its own leading space." },
      { name: "knownMembersLine", description: "Line listing already-known member spellings, or empty." },
      { name: "sources", description: "Numbered search results (title, URL, extract)." },
    ],
  },
  founder_discovery: {
    key: "founder_discovery",
    label: "Founder discovery",
    description:
      "Stage 6a: names the subject company's founders/CEO from search results when the article " +
      "does not. Reference only for now — server/founder-discovery.ts still sends its own copy.",
    wired: true,
    variables: [
      { name: "companyName", description: "Company whose founders are being looked up." },
      { name: "hintSuffix", description: 'Parenthesised disambiguation hint, or empty. Includes its own leading space.' },
      { name: "answerBlock", description: 'Search-engine summary paragraph, or empty. Includes its own trailing blank line.' },
      { name: "results", description: "Numbered search results (title, URL, extract)." },
    ],
  },
};

// ============================================================================
// Code defaults
// ============================================================================

/**
 * The exact prompt text the pipeline sent before prompts became editable.
 *
 * `stage1_interest` deliberately re-uses the shared constant rather than
 * copying it: it is still the `settings.interest_filter_prompt` column default,
 * so the two can never drift.
 *
 * `scripts/verify-prompt-defaults.ts` renders each of these with sample
 * variables and diffs the result against the original inline literals.
 */
export const DEFAULT_PROMPTS: Record<PromptKey, string> = {
  stage1_interest: DEFAULT_INTEREST_FILTER_PROMPT,

  stage1_regional_rules: `CRITICAL REGIONAL FILTER (SEA / HK / Taiwan, strict).
Target Regions: {{regions}}.

Pass on geography ONLY if the article itself shows ONE of:
  (a) the SUBJECT company is HEADQUARTERED in a Target Region, OR
  (b) a NAMED founder is BASED in a Target Region (current home / office), OR
  (c) a NAMED founder has CREDIBLE ROOTS in a Target Region (born, raised,
      educated, family, previously based there), OR
  (d) the SUBJECT company has a STRONG OPERATIONAL CENTRE in a Target Region
      (regional HQ, primary office with leadership, principal market with
      on-the-ground leadership), OR
  (e) the article EXPLICITLY concerns a wealth liquidity event for a
      SEA / HK / Taiwan founder, family, or private company.

REJECT — these signals alone do NOT make an article SEA-relevant:
  - The publisher or source domain is SEA (Tech in Asia, Business Times,
    Straits Times, KrASIA, DealStreetAsia, The Edge, e27, SCMP, CNA, Hubbis).
    A SEA outlet covering a US / European / Mainland-China company is NOT
    a SEA story.
  - An investor, backer, fund, or LP is SEA-based (GIC, Temasek, Khazanah,
    EDBI, family offices, sovereign funds, Hillhouse-LPs, etc.) but the
    company itself is not. Investor identity does NOT establish SEA
    relevance for the SUBJECT company.
  - Vague "Asia expansion", "APAC growth", "Asian customers", regional
    distribution, or partner network with no concrete office, founder, or
    HQ in a Target Region.
  - Mainland China entities (Beijing, Shanghai, Shenzhen, Guangzhou,
    Hangzhou — e.g. ByteDance, Tencent, Alibaba mainland operations) are
    NOT in scope. Mainland China is excluded; only HK and Taiwan count.
  - Global companies (Anthropic, OpenAI, SpaceX, Stripe) where the only
    SEA tie is a SEA backer or a SEA-published article.

If you cannot point to a specific sentence in the article that establishes
(a)–(e), mark relevant=false.

Article Headline: {{headline}}
Article Snippet: {{snippet}}
Source: {{source}}
Target Regions: {{regions}}

Return JSON:
{
  "relevant": true/false,
  "reason": "Brief explanation. If relevant, name which of (a)-(e) applies and quote the supporting passage. If not relevant, name the disqualifying signal (sea_publisher_only / sea_investor_only / vague_apac_expansion / mainland_china_only / global_company_no_sea_anchor).",
  "confidenceScore": 0-100
}`,

  stage2_company: `Extract the PRIMARY company that this article is ABOUT (the subject), not the publisher/source.

CRITICAL RULES:
- News publishers (Bloomberg, Reuters, Nikkei, The Edge, Business Times, CNA, SCMP, Tech in Asia, KrASIA, DealStreetAsia, e27, Straits Times, Hubbis) are NEVER the primary company. They are sources.
- If the headline says "Company X does Y — Bloomberg", the primary company is "Company X", NOT Bloomberg.
- Use the company's commonly known name. Examples:
  - "Digital Bank Maya" → "Maya" (also known as PayMaya, Voyager Innovations)
  - "Grab Holdings" or "Grab" → "Grab"
  - "GoTo Group" or "Gojek Tokopedia" → "GoTo"
- ACQUISITIONS: when "A acquires / buys / agrees to acquire B", the PRIMARY company is ALWAYS B (the target being acquired) — its founders and shareholders are the ones receiving the liquidity. NEVER return the acquirer, even if the headline leads with the acquirer's name.
  - "Circle agrees to buy Tazapay for $400M" → "Tazapay"
  - "Grab to acquire Jaya Grocer" → "Jaya Grocer"
- FUNDING / IPO: the company raising money or listing is the primary company, not its investors.

Headline: {{headline}}
Content: {{content}}

Return JSON: { "companyName": "string or null", "confidenceScore": 0-100 }`,

  stage3_public: `Determine if this company is publicly listed/traded:

Company: {{companyName}}
Article Headline: {{headline}}

A company is PUBLIC if:
- It trades on a stock exchange (SGX, NASDAQ, NYSE, HKEX, SET, IDX, etc)
- Article mentions stock ticker symbols
- Described as "publicly traded" or "listed company"

A company is PRIVATE if:
- Not yet listed
- Article discusses FUTURE IPO (company is still private)
- No mention of trading or stock tickers
- Described as a startup, private company, or privately held

Return JSON:
{
  "isPublic": true/false,
  "reason": "Brief explanation",
  "confidence": 0-100
}`,

  stage4_dedup: `Compare these two articles about the same company:

SAVED ARTICLE SUMMARY:
{{existingSummary}}

NEW ARTICLE:
Headline: {{headline}}
Snippet: {{snippet}}

Determine if the new article contains SUBSTANTIALLY NEW information.

Substantially new means:
- Different funding round or amount
- New acquisition or exit event
- Significant business development
- Different time period or stage

NOT substantially new:
- Same event, different wording
- Minor updates to same story
- Similar information already covered

Return JSON:
{
  "substantiallyNew": true/false,
  "percentNew": 0-100,
  "reason": "Explanation of what's new or why it's duplicate"
}`,

  stage6_analysis: `Perform deep analysis of this news article for private banking lead intelligence.

FULL ARTICLE:
Headline: {{headline}}
Source: {{source}}
Content: {{content}}

Target Regions (SEA / HK / Taiwan): {{regions}}

GEOGRAPHY RULE (strict, source-backed). A lead qualifies on geography ONLY if the
article itself contains evidence of one of these:
  1. company_hq           — company is headquartered in a Target Region
  2. founder_base         — a named founder currently lives / works in a Target Region
  3. founder_roots        — a named founder has credible roots in a Target Region
                            (born / raised / educated / family / previously based there)
  4. operational_centre   — company has a strong operational centre in a Target Region
                            (regional HQ, primary office, principal market with leadership presence)
  5. wealth_event         — the article explicitly concerns a wealth liquidity event
                            for a SEA / HK / Taiwan founder, family or private company

NOT ENOUGH (must NOT pass on these alone — record each one observed in
disqualifyingSignals so the deterministic guard can reject):
  - sea_publisher_only      → article is published by a SEA outlet (Tech in Asia,
                              Business Times, Straits Times, KrASIA, DealStreetAsia,
                              The Edge, e27, SCMP, CNA, etc) but the subject company
                              and founders are non-SEA
  - sea_investor_only       → company is non-SEA but an investor / backer / fund is
                              SEA-based (GIC, Temasek, Khazanah, EDBI, MUFG-SEA arm,
                              SEA family office, etc). Investor identity does NOT
                              establish target-region relevance.
  - vague_apac_expansion    → vague "expanding into Asia / APAC", "Asian customers",
                              "Asia growth strategy" with no concrete office, founder,
                              or HQ in a Target Region
  - sea_customers_only      → company sells to SEA customers but is not based there
  - sea_distribution_only   → distribution / partner network in SEA only

Mainland China is NOT in the Target Regions. Beijing, Shanghai, Shenzhen,
Guangzhou, Hangzhou-based companies do NOT qualify unless they have an
independent qualifying anchor in HK or Taiwan or another Target Region.

PRIORITY SCORING:
- 80-100 (HIGH): Clear liquidity event with a named individual. IPO filing,
  acquisition with disclosed price, Series D+ / late-stage raise >$100M, confirmed exit.
- ACQUISITION OF A PRIVATE TARGET-REGION COMPANY = a liquidity event for its
  founders and shareholders BY DEFINITION. Do NOT require the article to say
  explicitly that a person "gains wealth". If the target is private and in a
  Target Region: named founder/CEO of the target + disclosed price ⇒ 85+;
  named founder/CEO, price undisclosed ⇒ 70-80; no individual named ⇒ 55-65
  (founders will be identified in enrichment — still worth a banker's look).
- 50-79 (MEDIUM): Likely liquidity event, details missing. IPO rumors, M&A talks,
  Series C, unicorn milestone with named founders.
- 20-49 (LOW): Tangential — possible future liquidity. Ignore Series A/B.
- 1-19 (REJECT): No liquidity event — general market/industry commentary, opinion.

INVESTOR/BACKER WEALTH EVENTS:
- A NAMED billionaire/UHNW investor or backer of a company in an M&A deal, IPO, or
  major raise is HIGH priority — treat the backer as a key person.
- Patterns: "[Name]-backed", "backed by [Name]", "[Name]'s [Company]", "investor [Name]".
- "Richard Li-backed bolttech" in a $200M M&A = score 70+ and EXTRACT Richard Li.
- SKIP institutional backers with no named individual (Temasek, GIC, sovereign funds).

WEALTH ANGLE QUALITY — the wealthAngle field is graded; aim for 10/10:
- 10/10: names a specific person + the liquidity event + the amount.
- 7/10: names a person + event, amount vague.
- 4/10: company event but no individual named.
- 1/10: generic, no person/event.
NEVER write "No identifiable individual" if any person (founder, exec, or named
backer) appears — name them.

WORKED EXAMPLE — "Richard Li-backed bolttech in talks to acquire MoneyHero for US$200M":
  founderNames ["Richard Li"], investors ["Richard Li"], dealValue "$200M",
  priorityScore 75, wealthAngle "Richard Li (billionaire backer of bolttech) positioned
  to realize returns from the reported US$200M MoneyHero acquisition."

SUBJECT COMPANY: in an acquisition ("A acquires / buys B") the subject company is
ALWAYS the TARGET B — its founders and shareholders receive the liquidity. The
acquirer's HQ and founders are irrelevant. In a funding round or IPO the subject
is the company raising / listing, never its investors.

Required structured output:
- hqLocation       : "City, Country" of the SUBJECT company HQ (the acquisition
                     target / fundraiser), or null if unclear.
- founderLocations : array of {"name": "...", "location": "City, Country | null"} for
                     each named founder. Use null when location is not stated.
- seaEvidenceType  : one of "company_hq" | "founder_base" | "founder_roots"
                     | "operational_centre" | "wealth_event" | "none"
- seaEvidenceText  : a quoted or paraphrased passage from the article (15+ chars)
                     that supports seaEvidenceType. MUST mention a specific Target
                     Region city or country. Use empty string if seaEvidenceType
                     is "none".
- disqualifyingSignals : array of strings drawn from the NOT ENOUGH list above
                         (e.g. ["sea_investor_only"]). Empty array if none apply.
- regionRelevance  : true ONLY if seaEvidenceType is not "none" AND
                     disqualifyingSignals would not by themselves be the sole
                     reason for relevance.

Extract and return JSON:
{
  "companyNames": ["SUBJECT company FIRST (acquisition target / fundraiser), then the acquirer/investors. Do NOT include publishers or companies only mentioned in passing"],
  "primaryCompany": "the SUBJECT company (acquisition target / fundraiser), never the acquirer or investor",
  "founderNames": ["SUBJECT company's founders/CEO/shareholders ONLY (they receive the liquidity). Executives of the ACQUIRER or of investors are NOT founders — omit them entirely, even if quoted. Also named billionaire investors/backers with ACTUAL NAMES. Include people described as 'backers'/'investors'/'X-backed' even if not the founder, e.g. 'Richard Li-backed bolttech' -> include 'Richard Li'. Empty array if no names."],
  "investors": ["array of investors mentioned — include anyone described as backer, supporter, or financier"],
  "summary": "1-2 sentence summary of what happened",
  "keyFinancials": {
    "fundingAmount": "e.g. $50M or null",
    "valuation": "e.g. $500M or null",
    "dealValue": "for M&A or null"
  },
  "priorityScore": 1-100,
  "priorityLevel": "high/medium/low",
  "matchedIndicators": ["IPO", "Series B", "Exit", etc],
  "wealthAngle": "WHO specifically gains wealth and HOW MUCH. Name the person even if an investor/backer rather than founder (e.g. 'Richard Li (backer of bolttech) positioned to realize returns from the $200M deal'). Say 'No identifiable individual' ONLY if no person is named anywhere.",
  "confidenceScore": 0-100,
  "hqLocation": "City, Country or null",
  "founderLocations": [{"name": "Founder Name", "location": "City, Country or null"}],
  "seaEvidenceType": "company_hq | founder_base | founder_roots | operational_centre | wealth_event | none",
  "seaEvidenceText": "supporting passage from the article (or empty string if none)",
  "disqualifyingSignals": ["array of disqualifier strings, may be empty"],
  "seaConnection": "Specific SEA connection sentence or null",
  "regionRelevance": true/false
}`,

  family_research: `You are mapping the family tree of the {{familyName}} ({{country}}) for a private banker.{{anchorClause}}{{companiesClause}}
{{knownMembersLine}}

Using ONLY the sources below, identify the family's members and how they are related. Focus on the wealth-holding core: patriarch/matriarch, spouse, children (and their spouses), grandchildren who are publicly known, siblings who co-run the business.

SOURCES:
{{sources}}

Return ONLY JSON:
{
  "description": "2-3 sentence family overview (business, generation in charge, succession)",
  "netWorthEstimate": "e.g. 'US$3.2B (Forbes 2025)' or null",
  "patriarch": "full name of the current family head, or null",
  "members": [{"name": "Full name as most commonly written in English press", "role": "e.g. 'Founder, chairman of X' / 'Eldest son, CEO of Y'", "notes": "one line, optional", "confidence": "high|medium|low"}],
  "relationships": [{"from": "Parent full name", "to": "Child full name", "type": "parent", "confidence": "high|medium|low", "sourceUrl": "URL from sources supporting this"}],
  "confidence": "high|medium|low",
  "sourceUrls": ["URLs actually used"]
}

Rules:
- "type" is one of: "parent" (from=parent, to=child), "spouse", "sibling" (only when parents are unknown).
- Every relationship must have a supporting sourceUrl from the list. Do NOT invent people or relationships. If the sources only support the anchor person, return just them.
- Use one canonical spelling per person and use it consistently in members and relationships.
- Do not include deceased ancestors unless they are needed to connect living members.`,

  founder_discovery: `From these search results, list the founders and CEO of the company "{{companyName}}"{{hintSuffix}}.

{{answerBlock}}{{results}}

Return JSON only: {"founders": [{"name": "Full name", "role": "e.g. Co-founder & CEO", "location": "City, Country where they are based, or null"}]}
Rules: only people explicitly tied to "{{companyName}}" in the results; never guess; empty array if unsure; max 5 people, CEO/founders first.`,
};

// ============================================================================
// Rendering
// ============================================================================

/** Matches a `{{name}}` slot. Word characters only, so JSON braces never match. */
const PLACEHOLDER_PATTERN = /\{\{\s*(\w+)\s*\}\}/g;

/**
 * Substitutes `{{name}}` placeholders in a template.
 *
 * Placeholders with no matching variable are left in place rather than blanked,
 * so a typo shows up in the prompt (and the logs) instead of quietly removing
 * an instruction. Values are inserted verbatim — `$&`-style replacement
 * patterns in article text cannot corrupt the output.
 *
 * @example
 * render("Headline: {{headline}}", { headline: "Grab raises $500M" });
 * // → "Headline: Grab raises $500M"
 */
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER_PATTERN, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : match,
  );
}

/** Every distinct `{{name}}` referenced by a template body. */
export function extractPlaceholders(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(PLACEHOLDER_PATTERN)) found.add(match[1]);
  return Array.from(found);
}

/**
 * Rejects a body that references variables this key cannot supply.
 *
 * @returns The offending variable names, empty when the body is valid.
 */
export function unknownPlaceholders(key: PromptKey, body: string): string[] {
  const allowed = new Set(PROMPT_META[key].variables.map((v) => v.name));
  return extractPlaceholders(body).filter((name) => !allowed.has(name));
}

// ============================================================================
// Cache + reads
// ============================================================================

const CACHE_TTL_MS = 60_000;

interface PromptCache {
  loadedAt: number;
  /** key → stored override body. Keys with no row are absent. */
  bodies: Map<string, string>;
}

let cache: PromptCache | null = null;

/** Drops the cached overrides so the next read hits the database. */
export function invalidatePromptCache(): void {
  cache = null;
}

async function loadOverrides(): Promise<Map<string, string>> {
  const fresh = cache && Date.now() - cache.loadedAt < CACHE_TTL_MS;
  if (fresh) return cache!.bodies;

  try {
    const rows = await db.select().from(pipelinePrompts);
    const bodies = new Map<string, string>(rows.map((row) => [row.key, row.body]));
    cache = { loadedAt: Date.now(), bodies };
    return bodies;
  } catch (error) {
    // A prompt read must never take the pipeline down: fall back to defaults
    // and let the next call retry. Do not cache the failure.
    log(`[Prompts] failed to load overrides, using code defaults: ${(error as Error).message}`, "pipeline");
    return new Map();
  }
}

/**
 * The prompt template currently in force for a key: the saved override if one
 * exists, otherwise the code default. Cached for 60s.
 *
 * @example
 * const body = await getPrompt("stage2_company");
 * const prompt = render(body, { headline, content });
 */
export async function getPrompt(key: PromptKey): Promise<string> {
  const overrides = await loadOverrides();
  return overrides.get(key) ?? DEFAULT_PROMPTS[key];
}

/** Convenience: fetch and render in one call. */
export async function renderPrompt(key: PromptKey, vars: Record<string, string>): Promise<string> {
  return render(await getPrompt(key), vars);
}

// ============================================================================
// State for the Settings editor
// ============================================================================

export interface PromptState extends PromptMeta {
  body: string;
  defaultBody: string;
  version: number;
  /** True when no override row exists — the code default is in force. */
  isDefault: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Every key with its current body, version and provenance. */
export async function listPromptStates(): Promise<PromptState[]> {
  const rows = await db.select().from(pipelinePrompts);
  const byKey = new Map(rows.map((row) => [row.key, row]));

  return PROMPT_KEYS.map((key) => {
    const row = byKey.get(key);
    return {
      ...PROMPT_META[key],
      body: row?.body ?? DEFAULT_PROMPTS[key],
      defaultBody: DEFAULT_PROMPTS[key],
      version: row?.version ?? 0,
      isDefault: !row,
      updatedAt: row?.updatedAt?.toISOString() ?? null,
      updatedBy: row?.updatedBy ?? null,
    };
  });
}

/** Saved history for one key, newest first. */
export async function listPromptVersions(key: PromptKey): Promise<PipelinePromptVersion[]> {
  return db
    .select()
    .from(pipelinePromptVersions)
    .where(eq(pipelinePromptVersions.key, key))
    .orderBy(desc(pipelinePromptVersions.version));
}

// ============================================================================
// Mutations
// ============================================================================

/** Next version number for a key (1 when nothing has ever been saved). */
async function nextVersion(key: PromptKey): Promise<number> {
  const [latest] = await db
    .select({ version: pipelinePromptVersions.version })
    .from(pipelinePromptVersions)
    .where(eq(pipelinePromptVersions.key, key))
    .orderBy(desc(pipelinePromptVersions.version))
    .limit(1);
  return (latest?.version ?? 0) + 1;
}

/**
 * Stores a new body for a key: appends a history row and bumps the live
 * version. Callers must validate placeholders first (`unknownPlaceholders`).
 *
 * @returns The version number just written.
 */
export async function savePrompt(
  key: PromptKey,
  body: string,
  note: string | null,
  updatedBy: string,
): Promise<number> {
  const version = await nextVersion(key);

  await db.insert(pipelinePromptVersions).values({ key, version, body, note });
  await db
    .insert(pipelinePrompts)
    .values({ key, body, version, updatedBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: pipelinePrompts.key,
      set: { body, version, updatedBy, updatedAt: new Date() },
    });

  invalidatePromptCache();
  log(`[Prompts] ${key} saved as v${version} by ${updatedBy}${note ? ` — ${note}` : ""}`, "pipeline");
  return version;
}

/**
 * Re-saves an earlier version's body as a new version, so history stays
 * append-only and the revert itself is undoable.
 *
 * @throws {Error} If the requested version does not exist.
 */
export async function revertPrompt(key: PromptKey, version: number, updatedBy: string): Promise<number> {
  const [target] = await db
    .select()
    .from(pipelinePromptVersions)
    .where(and(eq(pipelinePromptVersions.key, key), eq(pipelinePromptVersions.version, version)))
    .limit(1);

  if (!target) throw new Error(`No version ${version} for prompt "${key}"`);
  return savePrompt(key, target.body, `Reverted to v${version}`, updatedBy);
}

/**
 * Drops the override so the code default is in force again. History is kept,
 * so the customised body can still be recovered from the version list.
 */
export async function resetPrompt(key: PromptKey): Promise<void> {
  await db.delete(pipelinePrompts).where(eq(pipelinePrompts.key, key));
  invalidatePromptCache();
  log(`[Prompts] ${key} reset to code default`, "pipeline");
}

// ============================================================================
// One-time migration from settings.interestFilterPrompt
// ============================================================================

/**
 * Carries Billy's hand-tuned Stage 1 prompt across from the old
 * `settings.interest_filter_prompt` column into `pipeline_prompts`.
 *
 * Runs at boot and is idempotent in three ways: it does nothing once a
 * `stage1_interest` row exists, nothing when the settings value still equals
 * the code default, and nothing when settings are unreadable. The legacy column
 * is left untouched — it remains the settings-table default and the fallback
 * for anything that has not been switched over.
 */
export async function seedPromptsFromSettings(): Promise<void> {
  try {
    const [existing] = await db
      .select({ id: pipelinePrompts.id })
      .from(pipelinePrompts)
      .where(eq(pipelinePrompts.key, "stage1_interest"))
      .limit(1);
    if (existing) return;

    const settings = await storage.getSettings();
    const legacy = settings?.interestFilterPrompt?.trim();
    if (!legacy || legacy === DEFAULT_PROMPTS.stage1_interest.trim()) return;

    await savePrompt("stage1_interest", settings!.interestFilterPrompt, "Migrated from Settings", "migration");
    log("[Prompts] seeded stage1_interest v1 from settings.interestFilterPrompt", "pipeline");
  } catch (error) {
    // Seeding is a convenience, never a boot blocker.
    log(`[Prompts] seedPromptsFromSettings skipped: ${(error as Error).message}`, "pipeline");
  }
}
