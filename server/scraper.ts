/**
 * Provider-agnostic web scraper.
 *
 * Every place that needs a rendered/unblocked page (Stage 5 full-article
 * fetch, RSS-via-proxy, IPO exchange pages, manual URL ingest) calls
 * `scrapeUrl()` and never talks to a vendor directly. Providers are selected by
 * `SCRAPER_PROVIDER` (scrape_do | scrapingbee) or, when unset, by whichever key
 * is configured — scrape.do preferred.
 *
 * scrape.do: GET https://api.scrape.do/?token=…&url=… (+ render=true,
 * super=true, geoCode=sg, output=markdown). Only 2xx/400/404/410 are billed.
 * Usage: GET https://api.scrape.do/info?token=…
 */

import * as cheerio from "cheerio";
import { log } from "./log";

export type ScraperProvider = "scrape_do" | "scrapingbee" | "none";

export interface ScrapeOptions {
  /** Run a headless browser (JS-heavy sites). Costs more credits. */
  render?: boolean;
  /** Residential / premium proxy for hard anti-bot sites. Costs more credits. */
  premium?: boolean;
  /** ISO country code for geo-targeting, e.g. "sg". */
  geo?: string;
  timeoutMs?: number;
  /** Ask the provider for markdown instead of HTML (scrape.do only). */
  markdown?: boolean;
}

export interface ScrapeResult {
  ok: boolean;
  status: number;
  body: string;
  provider: ScraperProvider;
  /** Credits this request cost, when the provider reports it. */
  cost?: number;
  /** Credits remaining on the plan, when the provider reports it. */
  remaining?: number;
  error?: string;
}

const SCRAPE_DO_KEY = process.env.SCRAPE_DO_API_KEY;
const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;

export function activeScraper(): ScraperProvider {
  const forced = process.env.SCRAPER_PROVIDER as ScraperProvider | undefined;
  if (forced === "scrape_do" && SCRAPE_DO_KEY) return "scrape_do";
  if (forced === "scrapingbee" && SCRAPINGBEE_KEY) return "scrapingbee";
  if (SCRAPE_DO_KEY) return "scrape_do";
  if (SCRAPINGBEE_KEY) return "scrapingbee";
  return "none";
}

/** Rolling in-process stats so the Debug page can show what scraping costs. */
const stats = { day: "", requests: 0, credits: 0, failures: 0, lastRemaining: null as number | null, lastError: null as string | null };
function today() { return new Date().toISOString().slice(0, 10); }
function touchStats() { if (stats.day !== today()) { stats.day = today(); stats.requests = 0; stats.credits = 0; stats.failures = 0; } }

async function viaScrapeDo(url: string, o: ScrapeOptions): Promise<ScrapeResult> {
  const params = new URLSearchParams({ token: SCRAPE_DO_KEY!, url });
  if (o.render) params.set("render", "true");
  if (o.premium) params.set("super", "true");
  if (o.geo) params.set("geoCode", o.geo);
  if (o.markdown) params.set("output", "markdown");
  params.set("timeout", String(o.timeoutMs ?? 60_000));
  const res = await fetch(`https://api.scrape.do/?${params}`, { signal: AbortSignal.timeout((o.timeoutMs ?? 60_000) + 10_000) });
  const body = await res.text();
  const cost = Number(res.headers.get("scrape.do-request-cost")) || undefined;
  const remaining = res.headers.get("scrape.do-remaining-credits");
  return {
    ok: res.ok,
    status: res.status,
    body,
    provider: "scrape_do",
    cost,
    remaining: remaining !== null ? Number(remaining) : undefined,
    error: res.ok ? undefined : `scrape.do HTTP ${res.status}: ${body.slice(0, 200)}`,
  };
}

async function viaScrapingBee(url: string, o: ScrapeOptions): Promise<ScrapeResult> {
  const params = new URLSearchParams({ api_key: SCRAPINGBEE_KEY!, url, render_js: o.render ? "true" : "false" });
  if (o.premium) params.set("premium_proxy", "true");
  if (o.geo) params.set("country_code", o.geo);
  const res = await fetch(`https://app.scrapingbee.com/api/v1?${params}`, { signal: AbortSignal.timeout((o.timeoutMs ?? 60_000) + 10_000) });
  const body = await res.text();
  const cost = Number(res.headers.get("spb-cost")) || undefined;
  return { ok: res.ok, status: res.status, body, provider: "scrapingbee", cost, error: res.ok ? undefined : `ScrapingBee HTTP ${res.status}: ${body.slice(0, 200)}` };
}

/** Fetch a page through the active scraping provider. Never throws. */
export async function scrapeUrl(url: string, options: ScrapeOptions = {}): Promise<ScrapeResult> {
  const provider = activeScraper();
  if (provider === "none") return { ok: false, status: 0, body: "", provider, error: "No scraping provider configured (set SCRAPE_DO_API_KEY or SCRAPINGBEE_API_KEY)" };
  touchStats();
  stats.requests++;
  try {
    const result = provider === "scrape_do" ? await viaScrapeDo(url, options) : await viaScrapingBee(url, options);
    if (result.cost) stats.credits += result.cost;
    if (result.remaining !== undefined) stats.lastRemaining = result.remaining;
    if (!result.ok) { stats.failures++; stats.lastError = result.error ?? null; log(`[Scraper] ${result.error}`, "scraper"); }
    return result;
  } catch (error) {
    stats.failures++;
    const message = error instanceof Error ? error.message : "Unknown error";
    stats.lastError = message;
    log(`[Scraper] ${provider} failed for ${url}: ${message}`, "scraper");
    return { ok: false, status: 0, body: "", provider, error: message };
  }
}

/** Plan-level status for the Debug page (remaining credits etc.). */
export async function getScraperStatus() {
  touchStats();
  const provider = activeScraper();
  let plan: Record<string, unknown> | null = null;
  if (provider === "scrape_do") {
    try {
      const res = await fetch(`https://api.scrape.do/info?token=${SCRAPE_DO_KEY}`, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) plan = (await res.json()) as Record<string, unknown>;
    } catch { /* status is best-effort */ }
  }
  return { provider, today: { ...stats }, plan };
}

/** Pull readable article text out of raw HTML (shared by Stage 5 and manual ingest). */
export function extractArticleText(html: string): { title: string; text: string; publishedAt: string | null } {
  const $ = cheerio.load(html);
  $("script, style, nav, header, footer, aside, form, noscript").remove();
  const title = ($('meta[property="og:title"]').attr("content") || $("h1").first().text() || $("title").text() || "").trim();
  const description = ($('meta[property="og:description"]').attr("content") || $('meta[name="description"]').attr("content") || "").trim();
  const scope = $("article").length ? $("article") : $("main").length ? $("main") : $("body");
  const paragraphs = scope.find("p").map((_, el) => $(el).text().replace(/\s+/g, " ").trim()).get().filter((t) => t.length > 40);
  const text = [description, ...paragraphs].filter(Boolean).join("\n");
  const publishedAt = $('meta[property="article:published_time"]').attr("content") || null;
  return { title, text, publishedAt };
}

/**
 * Generic headline/link extraction from a publisher homepage or section page,
 * used by the ScrapingBee-era "scrape the front page" discovery fallback.
 */
export function extractHeadlinesFromHtml(html: string, domain: string): { headline: string; url: string; summary: string }[] {
  const $ = cheerio.load(html);
  const out: { headline: string; url: string; summary: string }[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href") || "";
    const text = $(a).text().replace(/\s+/g, " ").trim();
    if (text.length < 25 || text.length > 200) return;
    let url: string;
    try { url = new URL(href, `https://${domain}`).toString(); } catch { return; }
    if (!url.includes(domain.replace(/^www\./, ""))) return;
    if (!/\/(news|article|story|business|companies|startups|tech|markets|deals|20\d\d)\b/i.test(url)) return;
    if (seen.has(url)) return;
    seen.add(url);
    const container = $(a).closest("article, li, div");
    const summary = container.find("p").first().text().replace(/\s+/g, " ").trim().slice(0, 500);
    out.push({ headline: text, url, summary });
  });
  return out.slice(0, 80);
}
