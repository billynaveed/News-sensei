import Parser from "rss-parser";
import OpenAI from "openai";
import * as cheerio from "cheerio";
import { stripJsonFences } from "./json-utils";
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "./db";
import { log } from "./index";
import { sendTelegramMessage } from "./telegram";
import {
  lifestyleSources,
  lifestyleArticles,
  lifestyleLeadPeople,
  people,
  companies,
  peopleCompanies,
  type InsertLifestyleSource,
} from "@shared/schema";

const parser = new Parser({ timeout: 10000 });
const insecureParser = new Parser({ timeout: 10000, requestOptions: { rejectUnauthorized: false } });
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
  const useParser = source.baseUrl.includes("buro247.sg") ? insecureParser : parser;
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
  const useParser = source.baseUrl.includes("buro247.sg") ? insecureParser : parser;
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

async function classifyLifestyleArticle(article: typeof lifestyleArticles.$inferSelect | typeof lifestyleArticles.$inferInsert) {
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
  });

  return JSON.parse(stripJsonFences(response.choices[0]?.message?.content || '{"relevant":false,"reason":"empty","confidence":0,"eventType":"other"}'));
}

async function extractStructuredLifestyleData(article: typeof lifestyleArticles.$inferSelect, source: typeof lifestyleSources.$inferSelect) {
  const prompt = `Extract wealthy/notable people and companies from this lifestyle article for a private banker CRM. Return JSON only.

Title: ${article.title}
Text: ${(article.fullText || article.snippet || "").slice(0, 12000)}

Schema:
{
  "people": [{"full_name":"string","company":"string|null","role":"string|null","mention_context":"featured|mentioned|photographed","wealth_signals":["string"]}],
  "companies": [{"name":"string","sector":"string|null","is_public": true | false | null}],
  "event_type": "wedding" | "charity" | "property" | "business" | "social" | "style" | "other",
  "headline": "string",
  "summary": "string",
  "banker_angle": "string",
  "relevance_score": number
}`;

  const response = await openai.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.1,
  });

  const parsed = JSON.parse(stripJsonFences(response.choices[0]?.message?.content || "{}"));
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

async function fetchFullText(url: string) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 News-sensei Lifestyle Scanner" }, signal: AbortSignal.timeout(8000) });
  const html = await res.text();
  return stripHtml(html).slice(0, 20000);
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
  if (!TELEGRAM_CHAT_ID || articleIds.length === 0) return;
  const rows = await db.select().from(lifestyleArticles).where(inArray(lifestyleArticles.id, articleIds));
  for (const article of rows) {
    if ((article.relevanceScore || 0) < 85) continue;
    const persons = await db.select({ name: people.fullName }).from(lifestyleLeadPeople).innerJoin(people, eq(lifestyleLeadPeople.personId, people.id)).where(eq(lifestyleLeadPeople.lifestyleLeadId, article.id));
    await sendTelegramMessage(TELEGRAM_CHAT_ID, formatLifestyleAlert(article, persons.map((p) => p.name)));
  }
}

export async function scanLifestylePipeline() {
  await ensureLifestyleSourcesSeeded();
  const now = new Date();
  const allSources = await db.select().from(lifestyleSources).where(eq(lifestyleSources.status, "active"));
  const dueSources = allSources.filter((source) => !source.lastChecked || (now.getTime() - new Date(source.lastChecked).getTime()) >= source.checkIntervalMin * 60 * 1000);

  let newArticles = 0;
  const alerted: string[] = [];

  for (const source of dueSources) {
    try {
      const candidates = [...await fetchRssArticles(source), ...await fetchGoogleNewsArticles(source)];
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
  return { sourcesChecked: dueSources.length, newArticles, extracted: filtered.length, alertsSent: alerted.length };
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
