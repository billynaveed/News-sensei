import Parser from "rss-parser";
import OpenAI from "openai";
import { tavily } from "@tavily/core";
import * as cheerio from "cheerio";
import { stripJsonFences } from "./json-utils";
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "./db";
import { log } from "./log";
import { sendTelegramMessage } from "./telegram";
import { validateSeaAnchor } from "./sea-guard";
import {
  lifestyleSources,
  lifestyleArticles,
  lifestyleLeadPeople,
  people,
  companies,
  peopleCompanies,
  type InsertLifestyleSource,
} from "@shared/schema";
import { storage } from "./storage";

const parser = new Parser({ timeout: 10000 });

const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
// Per-scan-run budget for Tavily extracts (full-text fallback on Cloudflare-blocked
// premium articles). Each advanced extract = ~2 Tavily credits. Free tier is ~1000
// credits/mo, so keep this low. Tunable via LIFESTYLE_TAVILY_MAX_PER_RUN.
const TAVILY_MAX_EXTRACTS_PER_RUN = parseInt(process.env.LIFESTYLE_TAVILY_MAX_PER_RUN || "5", 10);
let tavilyExtractsThisRun = 0;

/**
 * Full-text fallback for articles whose direct fetch is blocked (Cloudflare on
 * premium magazines). Uses Tavily's extract endpoint. Capped per run + logged so
 * usage/cost is observable (grep journal for "[tavily]"). Returns clean text or null.
 */
async function fetchViaTavily(url: string): Promise<string | null> {
  if (!TAVILY_API_KEY) return null;
  // Tavily can't resolve Google News redirect URLs — don't waste a credit on them.
  if (url.includes("news.google.com")) return null;
  if (tavilyExtractsThisRun >= TAVILY_MAX_EXTRACTS_PER_RUN) {
    log(`[lifestyle][tavily] per-run cap (${TAVILY_MAX_EXTRACTS_PER_RUN}) reached — using snippet for ${url}`, "lifestyle");
    return null;
  }
  try {
    const tvly = tavily({ apiKey: TAVILY_API_KEY });
    // "advanced" is required to get past Cloudflare on premium magazines; "basic"
    // returns empty for them. Advanced ≈ 2 credits/URL.
    const res = await tvly.extract([url], { extractDepth: "advanced" });
    const raw = res.results?.[0]?.rawContent || "";
    tavilyExtractsThisRun++;
    log(`[lifestyle][tavily] extract ${tavilyExtractsThisRun}/${TAVILY_MAX_EXTRACTS_PER_RUN} — ${raw.length} chars from ${url}`, "lifestyle");
    return raw || null;
  } catch (e) {
    log(`[lifestyle][tavily] extract failed for ${url}: ${e instanceof Error ? e.message : e}`, "lifestyle");
    return null;
  }
}
const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
});

const MODEL = "google/gemini-2.5-flash-lite";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || process.env.TELEGRAM_LIFESTYLE_CHAT_ID;

type SourceSeed = typeof lifestyleSources.$inferInsert;

const DEFAULT_SOURCES: SourceSeed[] = [
  { name: "Tatler Asia", slug: "tatler-asia", region: "SG", publicationType: "luxury_magazine", baseUrl: "https://www.tatlerasia.com", feedUrl: "https://www.tatlerasia.com/feed", checkIntervalMin: 240, status: "active" },
  { name: "Vogue Singapore", slug: "vogue-singapore", region: "SG", publicationType: "luxury_magazine", baseUrl: "https://vogue.sg", feedUrl: "https://vogue.sg/feed", checkIntervalMin: 240, status: "active" },
  { name: "The Peak", slug: "the-peak", region: "SG", publicationType: "luxury_magazine", baseUrl: "https://thepeakmagazine.com.sg", feedUrl: null, checkIntervalMin: 240, status: "active" },
  { name: "Prestige", slug: "prestige", region: "SG", publicationType: "luxury_magazine", baseUrl: "https://www.prestigeonline.com", feedUrl: "https://www.prestigeonline.com/feed", checkIntervalMin: 240, status: "active" },
  { name: "Robb Report SG", slug: "robb-report-sg", region: "SG", publicationType: "luxury_magazine", baseUrl: "https://www.robbreport.com.sg", feedUrl: "https://www.robbreport.com.sg/feed", checkIntervalMin: 240, status: "active" },
  { name: "Forbes Asia", slug: "forbes-asia", region: "HK", publicationType: "business_magazine", baseUrl: "https://www.forbes.com/asia", feedUrl: "https://www.forbes.com/asia/feed", checkIntervalMin: 240, status: "active" },
  { name: "A+ Singapore", slug: "a-plus-singapore", region: "SG", publicationType: "luxury_magazine", baseUrl: "https://aplu.sg", feedUrl: null, checkIntervalMin: 240, status: "active" },
  { name: "Harper's Bazaar SG", slug: "harpers-bazaar-sg", region: "SG", publicationType: "luxury_magazine", baseUrl: "https://www.harpersbazaar.com.sg", feedUrl: "https://www.harpersbazaar.com.sg/feed", checkIntervalMin: 240, status: "active" },
  { name: "Buro Singapore", slug: "buro-singapore", region: "SG", publicationType: "luxury_magazine", baseUrl: "https://www.buro247.sg", feedUrl: null, checkIntervalMin: 240, status: "active" },
  { name: "CNA Luxury", slug: "cna-luxury", region: "SG", publicationType: "newspaper", baseUrl: "https://cnaluxury.channelnewsasia.com", feedUrl: "https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=7141", checkIntervalMin: 240, status: "active" },
  { name: "SCMP Lifestyle", slug: "scmp-lifestyle", region: "HK", publicationType: "newspaper", baseUrl: "https://www.scmp.com/lifestyle", feedUrl: "https://www.scmp.com/rss/91/feed", checkIntervalMin: 240, status: "active" },
  { name: "Senatus", slug: "senatus", region: "SG", publicationType: "luxury_magazine", baseUrl: "https://senatus.net", feedUrl: "https://senatus.net/rss", checkIntervalMin: 240, status: "active" },
  { name: "ICON Singapore", slug: "icon-singapore", region: "SG", publicationType: "luxury_magazine", baseUrl: "https://www.iconsingapore.com", feedUrl: null, checkIntervalMin: 240, status: "active" },
  { name: "Jakarta Globe", slug: "jakarta-globe", region: "ID", publicationType: "newspaper", baseUrl: "https://jakartaglobe.id", feedUrl: "https://jakartaglobe.id/feed", checkIntervalMin: 240, status: "active" },
  { name: "Prestige Indonesia", slug: "prestige-indonesia", region: "ID", publicationType: "luxury_magazine", baseUrl: "https://www.prestigeonline.com/id", feedUrl: "https://www.prestigeonline.com/id/feed", checkIntervalMin: 240, status: "active" },
  { name: "Tatler Philippines", slug: "tatler-philippines", region: "PH", publicationType: "luxury_magazine", baseUrl: "https://www.tatlerasia.com", feedUrl: "https://www.tatlerasia.com/feed", checkIntervalMin: 240, status: "active" },
  { name: "Tatler Hong Kong", slug: "tatler-hong-kong", region: "HK", publicationType: "luxury_magazine", baseUrl: "https://www.tatlerasia.com", feedUrl: "https://www.tatlerasia.com/feed", checkIntervalMin: 240, status: "active" },
];

async function ensureLifestyleSourcesSeeded() {
  const existing = await db.select().from(lifestyleSources).limit(1);
  if (existing.length > 0) return;
  await db.insert(lifestyleSources).values(DEFAULT_SOURCES);
  log(`[lifestyle] seeded ${DEFAULT_SOURCES.length} lifestyle sources`, "lifestyle");
}

function stripHtml(html: string): string {
  const $ = cheerio.load(html);
  return $.text().replace(/\s+/g, " ").trim();
}

async function fetchGoogleNewsArticles(source: typeof lifestyleSources.$inferSelect) {
  const query = encodeURIComponent(`site:${new URL(source.baseUrl).hostname} luxury OR billionaire OR founder OR ceo OR wedding OR gala`);
  const url = `https://news.google.com/rss/search?q=${query}&hl=en-US&gl=US&ceid=US:en`;
  const useParser = parser;
  const feed = await useParser.parseURL(url);
  return (feed.items || []).slice(0, 10).map((item) => ({
    sourceId: source.id,
    url: item.link || "",
    title: item.title || "Untitled",
    snippet: item.contentSnippet || item.content || null,
    imageUrl: null,
    publishedAt: item.pubDate ? new Date(item.pubDate) : null,
    status: "pending" as const,
  })).filter((a) => a.url);
}

async function fetchRssArticles(source: typeof lifestyleSources.$inferSelect) {
  if (!source.feedUrl) return [];
  const useParser = parser;
  // Premium magazines 403 here (Cloudflare). We don't fight that on the feed —
  // the decoupled Google News path (fetchGoogleNewsArticles) covers those sources.
  const feed = await useParser.parseURL(source.feedUrl);
  return (feed.items || []).slice(0, 15).map((item) => ({
    sourceId: source.id,
    url: item.link || "",
    title: item.title || "Untitled",
    snippet: item.contentSnippet || item.content || null,
    imageUrl: null,
    publishedAt: item.pubDate ? new Date(item.pubDate) : null,
    status: "pending" as const,
  })).filter((a) => a.url);
}

async function upsertPerson(fullName: string, region: string, sourceName: string) {
  const normalized = fullName.trim();
  const existing = await db.select().from(people).where(and(eq(people.fullName, normalized), eq(people.region, region), isNull(people.mergedIntoId))).limit(1);
  if (existing[0]) {
    const [updated] = await db.update(people)
      .set({
        mentionCount: sql`${people.mentionCount} + 1`,
        lastMentionedAt: new Date(),
        sources: sql`array_append(COALESCE(${people.sources}, ARRAY[]::text[]), ${sourceName})`,
        updatedAt: new Date(),
      })
      .where(eq(people.id, existing[0].id))
      .returning();
    return updated;
  }

  const createdRows = await db.insert(people).values({
    fullName: normalized,
    lastName: normalized.split(" ").slice(-1)[0] || normalized,
    region,
    lastMentionedAt: new Date(),
    sources: [sourceName],
  }).returning();
  return createdRows[0];
}

async function upsertCompany(name: string, articleUrl: string) {
  const normalized = name.trim();
  const existing = await db.select().from(companies).where(eq(companies.name, normalized)).limit(1);
  if (existing[0]) return existing[0];
  const createdRows = await db.insert(companies).values({ name: normalized, sourceUrls: [articleUrl] }).returning();
  return createdRows[0];
}

export async function classifyLifestyleArticle(article: typeof lifestyleArticles.$inferSelect | typeof lifestyleArticles.$inferInsert) {
  const prompt = `You are filtering luxury/society magazine content for a UHNW private banker.
Return JSON only.

Article title: ${article.title}
Snippet: ${article.snippet || ""}

REJECT (relevant=false) these categories:
- Celebrity profiles, red carpet coverage, fashion/beauty editorials featuring celebrities
- Entertainment industry figures (actors, singers, musicians, models) UNLESS they have significant business empires (e.g. Rihanna's Fenty, Kylie Jenner's cosmetics empire)
- Product reviews, fashion lookbooks, style guides, trend roundups
- Brand campaign coverage without named UHNW individuals

ACCEPT (relevant=true) these categories:
- Business owners, founders, CEOs, family dynasty members
- Society figures at galas, charity events, weddings (named individuals, not just brands)
- Property buyers, art collectors, philanthropists
- Rich list features, wealth profiles, family office/succession/wealth transfer articles
- Investors, board members, or executives with identifiable net worth

Return:
{
  "relevant": boolean,
  "reason": string,
  "confidence": number,
  "eventType": "wedding" | "charity" | "property" | "business" | "social" | "style" | "other"
}`;

  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.1,
    response_format: { type: "json_object" },
  });

  return JSON.parse(stripJsonFences(response.choices[0]?.message?.content || '{"relevant":false,"reason":"empty","confidence":0,"eventType":"other"}'));
}

export async function extractStructuredLifestyleData(article: typeof lifestyleArticles.$inferSelect, source: typeof lifestyleSources.$inferSelect) {
  const prompt = `Extract wealthy/notable people and companies from this lifestyle article for a private banker CRM. Return JSON only.

Title: ${article.title}
Text: ${(article.fullText || article.snippet || "").slice(0, 12000)}

EXTRACTION RULES:
- Extract every NAMED individual who is wealthy/notable: founders, heirs, tycoons, executives, philanthropists, art/property collectors, and named investors/backers ("[Name]-backed", "backed by [Name]").
- Skip institutions with no named person (Temasek, sovereign funds, generic "family office").
- wealth_signals: concrete evidence — net worth figure, business empire, major property/art purchase, rich-list rank, succession/wealth-transfer event.

banker_angle — name the SPECIFIC person and why they are a private-banking prospect. Aim for high quality:
- Good: "Peter Woo (Wharf Holdings chairman, est. US$13B net worth) profiled on succession planning — prime wealth-transfer prospect."
- Weak: "Wealthy person featured in magazine." (avoid)
- If no individual is identifiable, set banker_angle to "" and relevance_score below 40.

relevance_score (0-100): 85+ = named UHNW with concrete wealth signal + actionable event (succession, sale, major purchase). 60-84 = named wealthy individual, softer signal. 40-59 = notable but thin. <40 = no identifiable UHNW individual.

GEOGRAPHY (Target Regions = Southeast Asia + Hong Kong + Taiwan ONLY:
Singapore, Malaysia, Indonesia, Thailand, Vietnam, Philippines, Hong Kong, Taiwan).
Mainland China, Japan, Korea, India, the US/UK/EU and Australia are OUT of target.
For the PRIMARY individual, report where they are based and what anchors them (if any) to a Target Region:
- founder_locations: array of {"name": "...", "location": "City, Country | null"} — the person's current base, as stated/implied in the article.
- hq_location: "City, Country | null" — HQ of their main company.
- sea_evidence_type: one of "company_hq" | "founder_base" | "founder_roots" | "operational_centre" | "wealth_event" | "none". Use "none" if the only tie to Asia is a SEA publisher, a SEA investor/backer, or vague "Asia expansion".
- sea_evidence_text: a passage from the article (15+ chars) naming a specific Target Region city/country that supports sea_evidence_type. Empty string if none.

Schema:
{
  "people": [{"full_name":"string","company":"string|null","role":"string|null","mention_context":"featured|mentioned|photographed","wealth_signals":["string"]}],
  "companies": [{"name":"string","sector":"string|null","is_public": true | false | null}],
  "event_type": "wedding" | "charity" | "property" | "business" | "social" | "style" | "other",
  "headline": "string",
  "summary": "string",
  "banker_angle": "string",
  "relevance_score": number,
  "founder_locations": [{"name":"string","location":"City, Country or null"}],
  "hq_location": "City, Country or null",
  "sea_evidence_type": "company_hq | founder_base | founder_roots | operational_centre | wealth_event | none",
  "sea_evidence_text": "supporting passage from the article (or empty string if none)"
}`;

  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.1,
    response_format: { type: "json_object" },
  });

  const parsed = JSON.parse(stripJsonFences(response.choices[0]?.message?.content || "{}"));

  // Geography gate — same Target-Region rule (SEA + HK + Taiwan) as the main
  // news pipeline (scanner.ts). The lifestyle path historically had no location
  // filter, so out-of-region UHNW (e.g. Masayoshi Son / Tokyo) leaked through.
  // Fail closed: reject before any alert, feed-sync, or CRM person/company write.
  const guard = validateSeaAnchor({
    hqLocation: parsed.hq_location ?? null,
    founderLocations: Array.isArray(parsed.founder_locations) ? parsed.founder_locations : null,
    seaEvidenceType: parsed.sea_evidence_type ?? "none",
    seaEvidenceText: parsed.sea_evidence_text ?? "",
  });
  if (!guard.passes) {
    await db.update(lifestyleArticles).set({
      status: "filtered_out",
      filterReason: `geo: ${guard.reason}`,
      relevanceScore: 0,
      eventType: parsed.event_type || article.eventType,
      headline: parsed.headline || article.title,
      summary: parsed.summary || article.snippet || "",
      updatedAt: new Date(),
    }).where(eq(lifestyleArticles.id, article.id));
    log(`[lifestyle] geo-rejected ${article.url}: ${guard.reason}`, "lifestyle");
    return { ...parsed, relevance_score: 0, region_rejected: true };
  }

  const extractedPeople = Array.isArray(parsed.people) ? parsed.people : [];
  const extractedCompanies = Array.isArray(parsed.companies) ? parsed.companies : [];

  await db.update(lifestyleArticles).set({
    eventType: parsed.event_type || article.eventType,
    headline: parsed.headline || article.title,
    summary: parsed.summary || article.snippet || "",
    bankerAngle: parsed.banker_angle || "",
    relevanceScore: typeof parsed.relevance_score === "number" ? parsed.relevance_score : 50,
    status: "extracted",
    updatedAt: new Date(),
  }).where(eq(lifestyleArticles.id, article.id));

  for (const p of extractedPeople) {
    if (!p?.full_name) continue;
    const person = await upsertPerson(p.full_name, source.region, source.name);
    await db.insert(lifestyleLeadPeople).values({
      lifestyleLeadId: article.id,
      personId: person.id,
      mentionContext: p.mention_context || "mentioned",
    }).onConflictDoNothing();

    if (p.company) {
      const company = await upsertCompany(p.company, article.url);
      await db.insert(peopleCompanies).values({
        personId: person.id,
        companyId: company.id,
        role: p.role || null,
        roleType: p.role ? "executive" : null,
        source: article.url,
      }).onConflictDoNothing();
    }
  }

  for (const c of extractedCompanies) {
    if (!c?.name) continue;
    await upsertCompany(c.name, article.url);
  }

  return parsed;
}

/**
 * SSRF guard: only allow http(s) fetches to public hosts. Article URLs can
 * originate from the unauthenticated browser-ingest endpoint, so a server-side
 * fetch must not be steerable to loopback / private / link-local / cloud-metadata
 * addresses. (Hostnames that resolve to private IPs via DNS rebinding are not
 * covered here — see remaining-work notes for pinned-resolution hardening.)
 */
function isPublicHttpUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    return false;
  }
  // IPv4 literals in private / loopback / link-local / unspecified ranges.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;            // link-local + cloud metadata (169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return false;   // 172.16.0.0/12
    if (a === 192 && b === 168) return false;            // 192.168.0.0/16
    if (a >= 224) return false;                          // multicast / reserved
  }
  // IPv6 loopback / unique-local / link-local.
  if (host === "::1" || host === "::" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) {
    return false;
  }
  return true;
}

async function fetchFullText(url: string) {
  if (!isPublicHttpUrl(url)) {
    log(`[lifestyle] blocked non-public fetch target: ${url}`, "lifestyle");
    return "";
  }
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" }, signal: AbortSignal.timeout(8000) });
    if (res.ok) {
      const html = await res.text();
      const text = stripHtml(html).slice(0, 20000);
      if (text.length > 200) return text;
    }
  } catch { /* fall through to Tavily */ }
  // Direct fetch failed/blocked (Cloudflare) — Tavily extract returns clean text
  // (capped + logged for cost monitoring).
  const raw = await fetchViaTavily(url);
  return raw ? raw.slice(0, 20000) : "";
}

function formatLifestyleAlert(article: typeof lifestyleArticles.$inferSelect, names: string[]) {
  return `💜 <b>New Lifestyle Lead</b>

<b>${article.headline || article.title}</b>

<i>People:</i> ${names.join(", ") || "N/A"}
<i>Event:</i> ${article.eventType || "other"}
<i>Score:</i> ${article.relevanceScore || 0}

${article.bankerAngle || article.summary || ""}

<a href="${article.url}">Read article →</a>`;
}

async function sendHighValueLifestyleAlerts(articleIds: string[]) {
  if (articleIds.length === 0) return;
  // Prefer the configured destination (set via the /here bot command) so
  // lifestyle alerts land in the same "alerts" topic as news/IPO alerts.
  // Fall back to the legacy env var if settings has no chat id.
  const settings = await storage.getSettings();
  const chatId = settings?.telegramChatId || TELEGRAM_CHAT_ID;
  const topicId = settings?.telegramTopicId ?? null;
  if (!chatId) return;
  const rows = await db.select().from(lifestyleArticles).where(inArray(lifestyleArticles.id, articleIds));
  for (const article of rows) {
    if ((article.relevanceScore || 0) < 85) continue;
    const persons = await db.select({ name: people.fullName }).from(lifestyleLeadPeople).innerJoin(people, eq(lifestyleLeadPeople.personId, people.id)).where(eq(lifestyleLeadPeople.lifestyleLeadId, article.id));
    await sendTelegramMessage(chatId, formatLifestyleAlert(article, persons.map((p) => p.name)), 'HTML', undefined, topicId);
  }
}

export async function scanLifestylePipeline() {
  await ensureLifestyleSourcesSeeded();
  tavilyExtractsThisRun = 0; // reset the per-run Tavily budget
  const now = new Date();
  const allSources = await db.select().from(lifestyleSources).where(eq(lifestyleSources.status, "active"));
  const dueSources = allSources.filter((source) => !source.lastChecked || (now.getTime() - new Date(source.lastChecked).getTime()) >= source.checkIntervalMin * 60 * 1000);

  let newArticles = 0;
  const alerted: string[] = [];

  for (const source of dueSources) {
    try {
      // Fetch RSS and Google News independently — a Cloudflare 403 on the
      // publication's feed must not suppress the (unblocked) Google News path.
      const [rss, gnews] = await Promise.all([
        fetchRssArticles(source).catch((e) => {
          log(`[lifestyle] ${source.slug} RSS failed: ${e instanceof Error ? e.message : e}`, "lifestyle");
          return [] as Awaited<ReturnType<typeof fetchRssArticles>>;
        }),
        fetchGoogleNewsArticles(source).catch((e) => {
          log(`[lifestyle] ${source.slug} GoogleNews failed: ${e instanceof Error ? e.message : e}`, "lifestyle");
          return [] as Awaited<ReturnType<typeof fetchGoogleNewsArticles>>;
        }),
      ]);
      const candidates = [...rss, ...gnews];
      for (const candidate of candidates) {
        const existing = await db.select().from(lifestyleArticles).where(eq(lifestyleArticles.url, candidate.url)).limit(1);
        if (existing[0]) continue;
        await db.insert(lifestyleArticles).values(candidate).onConflictDoNothing();
        newArticles++;
      }

      await db.update(lifestyleSources).set({ lastChecked: new Date(), updatedAt: new Date(), errorMessage: null }).where(eq(lifestyleSources.id, source.id));
    } catch (error) {
      await db.update(lifestyleSources).set({ errorMessage: error instanceof Error ? error.message : "unknown error", errorCount: sql`${lifestyleSources.errorCount} + 1`, updatedAt: new Date() }).where(eq(lifestyleSources.id, source.id));
      log(`[lifestyle] source ${source.slug} failed: ${error}`, "lifestyle");
    }
  }

  const pending = await db.select().from(lifestyleArticles).where(eq(lifestyleArticles.status, "pending")).orderBy(desc(lifestyleArticles.createdAt)).limit(100);
  for (const article of pending) {
    try {
      const decision = await classifyLifestyleArticle(article);
      const confidence = decision.confidence <= 1 ? decision.confidence * 100 : decision.confidence;
      if (!decision.relevant || confidence < 60) {
        await db.update(lifestyleArticles).set({ status: "filtered_out", filterReason: decision.reason, filterConfidence: Math.round(confidence), eventType: decision.eventType, updatedAt: new Date() }).where(eq(lifestyleArticles.id, article.id));
        continue;
      }

      const fullText = await fetchFullText(article.url).catch(() => article.snippet || "");
      await db.update(lifestyleArticles).set({ status: "filtered", filterReason: decision.reason, filterConfidence: Math.round(confidence), eventType: decision.eventType, fullText, updatedAt: new Date() }).where(eq(lifestyleArticles.id, article.id));
    } catch (error) {
      log(`[lifestyle] filter failed for ${article.url}: ${error}`, "lifestyle");
    }
  }

  const filtered = await db.select().from(lifestyleArticles).where(and(eq(lifestyleArticles.status, "filtered"), gte(lifestyleArticles.updatedAt, new Date(Date.now() - 24 * 60 * 60 * 1000)))).limit(100);
  for (const article of filtered) {
    try {
      const [source] = await db.select().from(lifestyleSources).where(eq(lifestyleSources.id, article.sourceId)).limit(1);
      if (!source) continue;
      const extracted = await extractStructuredLifestyleData(article, source);
      if ((extracted.relevance_score || 0) >= 85) alerted.push(article.id);
    } catch (error) {
      log(`[lifestyle] extraction failed for ${article.url}: ${error}`, "lifestyle");
    }
  }

  await sendHighValueLifestyleAlerts(alerted);

  log(`[lifestyle][tavily] ${tavilyExtractsThisRun} extract(s) used this run (cap ${TAVILY_MAX_EXTRACTS_PER_RUN}, ~${tavilyExtractsThisRun * 2} credits)`, "lifestyle");

  // Sync high-value lifestyle articles to main leads table for feed visibility
  const syncResult = await syncLifestyleToLeads();

  return { sourcesChecked: dueSources.length, newArticles, extracted: filtered.length, alertsSent: alerted.length, synced: syncResult.synced };
}

/**
 * Sync high-value lifestyle articles to the main leads table so they appear in the feed.
 * Only syncs articles with relevanceScore >= 60 that haven't been synced yet.
 */
export async function syncLifestyleToLeads(): Promise<{ synced: number; skipped: number }> {
  const articles = await db.select()
    .from(lifestyleArticles)
    .where(eq(lifestyleArticles.status, "extracted"))
    .orderBy(desc(lifestyleArticles.createdAt))
    .limit(50);

  let synced = 0;
  let skipped = 0;

  for (const article of articles) {
    try {
      // Check if already synced
      const existing = await storage.getLeadByUrl(article.url);
      if (existing) {
        skipped++;
        continue;
      }

      const [source] = await db.select().from(lifestyleSources).where(eq(lifestyleSources.id, article.sourceId)).limit(1);
      if (!source) continue;

      const score = article.relevanceScore || 60;
      const priorityLevel = score >= 70 ? "high" : score >= 40 ? "medium" : "low";

      await storage.createLead({
        headline: article.headline || article.title || "Untitled",
        sourceUrl: article.url,
        sourceName: source.name,
        sourceTier: "tier3",
        publishedAt: article.publishedAt || article.createdAt,
        companyNames: [],
        founderNames: [],
        investors: [],
        aiSummary: article.summary || article.bankerAngle || article.snippet || "",
        matchedKeywords: [article.eventType || "lifestyle"],
        priorityScore: score,
        priorityLevel,
        region: source.region,
        status: "new",
        category: "lifestyle",
        wealthAngle: article.bankerAngle || "",
      } as any);

      synced++;
    } catch (error) {
      log(`[lifestyle] sync to leads failed for ${article.url}: ${error}`, "lifestyle");
      skipped++;
    }
  }

  if (synced > 0) {
    log(`[lifestyle] Synced ${synced} articles to leads table`, "lifestyle");
  }

  return { synced, skipped };
}

export async function getRecentLifestyleLeads(limit = 20) {
  return db.select({
    id: lifestyleArticles.id,
    title: lifestyleArticles.title,
    headline: lifestyleArticles.headline,
    url: lifestyleArticles.url,
    summary: lifestyleArticles.summary,
    bankerAngle: lifestyleArticles.bankerAngle,
    eventType: lifestyleArticles.eventType,
    relevanceScore: lifestyleArticles.relevanceScore,
    publishedAt: lifestyleArticles.publishedAt,
    sourceName: lifestyleSources.name,
    status: lifestyleArticles.status,
  }).from(lifestyleArticles)
    .innerJoin(lifestyleSources, eq(lifestyleArticles.sourceId, lifestyleSources.id))
    .orderBy(desc(lifestyleArticles.publishedAt), desc(lifestyleArticles.createdAt))
    .limit(limit);
}
