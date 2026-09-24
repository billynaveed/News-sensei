/**
 * Full-page sources for family research.
 *
 * Pass 1 of the research agent only ever saw search snippets (≤1,200 chars
 * each), which is why most trees came back with members but few edges: a
 * snippet rarely states "X is the son of Y". This module finds the pages that
 * do — Wikipedia first (free MediaWiki search, no search budget), then
 * Forbes/Tatler/Bloomberg-style profiles — fetches them directly (SSRF-guarded,
 * scrape.do only as a fallback) and reduces each page to the text that carries
 * family facts: infobox rows such as Spouse / Children / Relatives, plus
 * paragraphs that mention family words.
 *
 * Pure helpers (`rankPageCandidates`, `extractFamilyText`) are kept free of I/O
 * so they are unit-testable.
 */

import * as cheerio from "cheerio";
import { log } from "./log";
import { isPublicHttpUrl } from "./url-safety";
import { scrapeUrl } from "./scraper";

export const PAGES_PER_FAMILY = parseInt(process.env.FAMILY_RESEARCH_PAGES_PER_FAMILY || "3", 10);
export const PAGE_TEXT_CAP = parseInt(process.env.FAMILY_RESEARCH_PAGE_CHARS || "7000", 10);
const SCRAPE_FALLBACK = process.env.FAMILY_RESEARCH_SCRAPE_FALLBACK !== "false";
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT = "Mozilla/5.0 (compatible; NewsSensei/1.0; +https://github.com/news-sensei) family-research";

export interface FamilyPage {
  url: string;
  title: string;
  text: string;
  via: "direct" | "scraper";
}

// ---------------------------------------------------------------------------
// Candidate ranking (pure)
// ---------------------------------------------------------------------------

/** Lower is better. Unknown hosts rank last; junk hosts are excluded. */
const HOST_RANK: [RegExp, number][] = [
  [/(^|\.)wikipedia\.org$/, 0],
  [/(^|\.)forbes\.com$/, 1],
  [/(^|\.)bloomberg\.com$/, 1],
  [/(^|\.)tatlerasia\.com$/, 2],
  [/(^|\.)prestigeonline\.com$/, 2],
  [/(^|\.)wikitree\.com$/, 2],
  [/(^|\.)geni\.com$/, 2],
  [/(^|\.)straitstimes\.com$/, 3],
  [/(^|\.)businesstimes\.com\.sg$/, 3],
  [/(^|\.)scmp\.com$/, 3],
  [/(^|\.)nikkei\.com$/, 3],
  [/(^|\.)theedgemalaysia\.com$/, 3],
  [/(^|\.)inquirer\.net$/, 3],
  [/(^|\.)bangkokpost\.com$/, 3],
  [/(^|\.)vnexpress\.net$/, 3],
];
const EXCLUDED_HOSTS = /(^|\.)(x\.com|twitter\.com|facebook\.com|instagram\.com|linkedin\.com|youtube\.com|tiktok\.com|pinterest\.com|reddit\.com|loopnet\.(com|ca)|glassdoor\.com|crunchbase\.com)$/;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Pick the pages worth fetching, best first, de-duplicated by URL. Wikipedia
 * "family" articles outrank person articles (they hold the whole tree), and a
 * URL from the family's own saved sources keeps the rank of its host.
 */
export function rankPageCandidates(urls: string[], limit = PAGES_PER_FAMILY): string[] {
  const seen = new Set<string>();
  const scored: { url: string; score: number; order: number }[] = [];
  urls.forEach((raw, order) => {
    const url = (raw || "").trim();
    const host = hostOf(url);
    if (!host || seen.has(url) || !/^https?:\/\//i.test(url)) return;
    if (EXCLUDED_HOSTS.test(host)) return;
    // Non-English Wikipedias are fine, but skip Wikipedia's own utility pages.
    if (/wikipedia\.org/.test(host) && /\/wiki\/(Special|Talk|Category|File|Template|Help|Portal):/i.test(url)) return;
    seen.add(url);
    let score = 9;
    for (const [re, rank] of HOST_RANK) {
      if (re.test(host)) { score = rank; break; }
    }
    if (score === 0 && /family/i.test(url)) score = -1;
    scored.push({ url, score, order });
  });
  return scored
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .slice(0, limit)
    .map((s) => s.url);
}

// ---------------------------------------------------------------------------
// Text extraction (pure)
// ---------------------------------------------------------------------------

const FAMILY_WORDS = /\b(son|daughter|children|child|father|mother|parent|wife|husband|spouse|married|marriage|brother|sister|sibling|grandson|granddaughter|grandchild|grandfather|grandmother|nephew|niece|heir|successor|succeeded|patriarch|matriarch|eldest|youngest|second[- ]generation|third[- ]generation|family|in-law|widow|née|nee)\b/i;
const FAMILY_HEADINGS = /family|members|personal life|early life|succession|relatives|children|marriage|biography|background|genealogy|descendants|generation|dynasty|heirs?/i;
const INFOBOX_ROWS = /^(spouse|spouses|partner|children|child|parents|parent|father|mother|relatives|family|relations|family members|siblings|sibling|born|died|occupation|title|net worth|known for|successor|predecessor)\b/i;

function clean(s: string): string {
  return s
    .replace(/\[\d+\]|\[[a-z]\]|\[citation needed\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Reduce a page to the text that carries family facts, capped at `cap`
 * characters. Wikipedia infobox rows are kept whole (they are the densest
 * source of spouse/children/relative names); paragraphs are kept when they
 * mention a family word, with the lead paragraph always included.
 */
export function extractFamilyText(html: string, cap = PAGE_TEXT_CAP): { title: string; text: string } {
  const $ = cheerio.load(html);
  $("script, style, nav, header, footer, form, noscript, .navbox, .reflist, .mw-editsection, #toc, .sidebar, .catlinks, .mw-jump-link").remove();
  const title = clean($('meta[property="og:title"]').attr("content") || $("h1").first().text() || $("title").text() || "");

  const parts: string[] = [];
  const push = (s: string) => { if (s && !parts.includes(s)) parts.push(s); };

  // Infobox rows (Wikipedia and lookalikes): "Spouse: Tewee Chearavanont".
  $("table.infobox tr, table.vcard tr, .infobox tr").each((_, tr) => {
    const th = clean($(tr).find("th").first().text());
    if (!th || !INFOBOX_ROWS.test(th)) return;
    const td = $(tr).find("td").first();
    // <br>-separated lists become "; " so names stay distinguishable.
    td.find("br").replaceWith("; ");
    td.find("li").each((_, li) => { $(li).append("; "); });
    const value = clean(td.text()).replace(/(; )+/g, "; ").replace(/; $/, "");
    if (value) push(`${th}: ${value}`);
  });

  const scope = $("#mw-content-text").length ? $("#mw-content-text") : $("article").length ? $("article") : $("main").length ? $("main") : $("body");
  const description = clean($('meta[property="og:description"]').attr("content") || $('meta[name="description"]').attr("content") || "");
  if (description) push(description);

  // Walk the body in document order. Inside a family section ("Notable
  // members", "Family", "Personal life", …) everything is kept — member lists
  // rarely repeat family words ("Sumet Jiaravanon, chairman of CP") — while
  // outside one only paragraphs that mention a family word survive.
  let inFamilySection = false;
  scope.find("h2, h3, p, li, table.wikitable tr").each((_, el) => {
    const tag = (el as { tagName?: string }).tagName?.toLowerCase();
    if (tag === "h2" || tag === "h3") {
      const heading = clean($(el).text());
      inFamilySection = FAMILY_HEADINGS.test(heading);
      if (inFamilySection) push(`## ${heading}`);
      return;
    }
    if (tag === "tr") {
      if (!inFamilySection) return;
      const cells = $(el).find("th, td").map((_, c) => clean($(c).text())).get().filter(Boolean);
      if (cells.length) push(cells.join(" | "));
      return;
    }
    const text = clean($(el).text());
    if (text.length < 12) return;
    if (inFamilySection) return push(text);
    if (tag === "li") return; // lists outside a family section are companies, awards, navigation
    if (parts.length < 4 || FAMILY_WORDS.test(text)) push(text);
  });

  let text = "";
  for (const p of parts) {
    if (text.length + p.length + 1 > cap) break;
    text += (text ? "\n" : "") + p;
  }
  return { title, text };
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/** Local-language Wikipedia per market: far richer than English for TH/ID/VN families. */
export const WIKI_LANG_BY_COUNTRY: Record<string, string> = {
  Thailand: "th",
  Indonesia: "id",
  Vietnam: "vi",
  Malaysia: "ms",
};

const GENERIC_QUERY_WORDS = new Set(["family", "families", "thailand", "singapore", "indonesia", "malaysia", "philippines", "vietnam", "the", "of", "and"]);

/** A hit is relevant when its title contains a distinctive query token (a surname, never "family" or the country). */
export function titleMatchesQuery(title: string, query: string): boolean {
  const norm = (t: string) => t.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const tokens = norm(query).split(/[^a-z0-9\u0e00-\u0e7f\u00c0-\u024f]+/).filter((t) => t.length >= 3 && !GENERIC_QUERY_WORDS.has(t));
  if (tokens.length === 0) return true;
  const t = norm(title);
  return tokens.some((tok) => t.includes(tok));
}

/**
 * Wikipedia article URLs for a family / person, via the MediaWiki search API
 * of the given language edition. Free and unmetered, so it does not touch the
 * search budget. Returns [] on any failure — page fetching is best-effort.
 */
export async function wikipediaLookup(queries: string[], limit = 2, lang = "en"): Promise<string[]> {
  const found: string[] = [];
  for (const q of queries) {
    if (found.length >= limit) break;
    try {
      const params = new URLSearchParams({
        action: "query",
        list: "search",
        srsearch: q,
        srlimit: "3",
        format: "json",
        origin: "*",
      });
      const res = await fetch(`https://${lang}.wikipedia.org/w/api.php?${params}`, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { query?: { search?: { title: string }[] } };
      for (const hit of data.query?.search ?? []) {
        // MediaWiki search is fuzzy: "Tejapaibul family Thailand" returns
        // "Thai Chinese" when no article matches. Keep a hit only when its
        // title carries a distinctive token of the query (the surname).
        if (!titleMatchesQuery(hit.title, q)) continue;
        const url = `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, "_"))}`;
        if (!found.includes(url)) found.push(url);
        if (found.length >= limit) break;
      }
    } catch (error) {
      log(`[family-pages] wikipedia lookup failed for "${q}": ${(error as Error).message}`, "families");
    }
  }
  return found;
}

async function fetchDirect(url: string): Promise<{ html: string | null; status: number }> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) return { html: null, status: res.status };
  const type = res.headers.get("content-type") || "";
  if (!/html|xml/i.test(type)) return { html: null, status: res.status };
  return { html: await res.text(), status: res.status };
}

/** The page is gone; a paid render will not bring it back. */
const NO_FALLBACK_STATUS = new Set([404, 410, 451]);

/**
 * Fetch one page and reduce it to family text. Direct fetch first (Wikipedia
 * and most publishers allow it); the metered scraper only when the direct
 * fetch fails or yields nothing useful. Never throws.
 */
export async function fetchFamilyPage(url: string, allowScrape = true): Promise<FamilyPage | null> {
  if (!isPublicHttpUrl(url)) return null;
  let html: string | null = null;
  let status = 0;
  let via: FamilyPage["via"] = "direct";
  try {
    ({ html, status } = await fetchDirect(url));
  } catch (error) {
    log(`[family-pages] direct fetch failed for ${url}: ${(error as Error).message}`, "families");
  }
  let extracted = html ? extractFamilyText(html) : { title: "", text: "" };
  const worthRendering = extracted.text.length < 400 && !NO_FALLBACK_STATUS.has(status) && !/wikipedia\.org/.test(url);
  if (worthRendering && SCRAPE_FALLBACK && allowScrape) {
    const scraped = await scrapeUrl(url, { timeoutMs: 30_000 });
    if (scraped.ok && scraped.body) {
      const alt = extractFamilyText(scraped.body);
      if (alt.text.length > extracted.text.length) { extracted = alt; via = "scraper"; }
    }
  }
  if (extracted.text.length < 300) return null;
  return { url, title: extracted.title || url, text: extracted.text, via };
}

/** Wall-clock budget for all of a family's page fetches, and metered renders per family. */
const PAGES_TIME_BUDGET_MS = parseInt(process.env.FAMILY_RESEARCH_PAGES_BUDGET_MS || "60000", 10);
const SCRAPES_PER_FAMILY = parseInt(process.env.FAMILY_RESEARCH_SCRAPES_PER_FAMILY || "1", 10);

/**
 * Best-effort: fetch up to `limit` of the ranked candidates, skipping the ones
 * that come back empty, until the limit is filled, candidates run out, or the
 * time budget is spent. At most SCRAPES_PER_FAMILY candidates may use the
 * metered renderer.
 */
export async function fetchFamilyPages(candidates: string[], limit = PAGES_PER_FAMILY): Promise<FamilyPage[]> {
  const pages: FamilyPage[] = [];
  const started = Date.now();
  let scrapes = 0;
  for (const url of candidates) {
    if (pages.length >= limit || Date.now() - started > PAGES_TIME_BUDGET_MS) break;
    const page = await fetchFamilyPage(url, scrapes < SCRAPES_PER_FAMILY);
    if (page?.via === "scraper") scrapes++;
    if (page) pages.push(page);
  }
  return pages;
}
