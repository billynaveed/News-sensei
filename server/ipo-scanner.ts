import * as cheerio from "cheerio";
import OpenAI from "openai";
import { db } from "./db";
import { ipoFilings, type InsertIpoFiling, type IpoExchange, type IpoFiling } from "@shared/schema";
import { eq, and, desc, isNull } from "drizzle-orm";
import { sendTelegramMessage } from "./telegram";
import { storage } from "./storage";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
});

// ---------------------------------------------------------------------------
// HKEX Scrapers
// ---------------------------------------------------------------------------

/**
 * Scrapes HKEX new listing page (Main Board or GEM) and returns parsed IPO entries.
 */
async function scrapeHkex(board: "Main-Board" | "GEM"): Promise<InsertIpoFiling[]> {
  const url = `https://www2.hkexnews.hk/New-Listings/New-Listing-Information/${board}?sc_lang=en`;
  const exchange: IpoExchange = board === "Main-Board" ? "hkex_main" : "hkex_gem";

  console.log(`[IPO] Fetching HKEX ${board}: ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HKEX ${board} fetch failed: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);
  const filings: InsertIpoFiling[] = [];

  // Parse table rows inside the main content table
  $("table.table tbody tr").each((_i, row) => {
    const tds = $(row).find("td");
    if (tds.length < 5) return;

    const stockCode = $(tds[0]).text().trim();
    const companyName = $(tds[1]).text().trim();
    if (!stockCode || !companyName) return;

    // Extract PDF links from columns 3 (announcements), 4 (prospectus), 5 (allotment)
    const announcementUrl = $(tds[2]).find("a").attr("href") || null;
    const prospectusUrl = $(tds[3]).find("a").attr("href") || null;
    const allotmentUrl = $(tds[4]).find("a").attr("href") || null;

    filings.push({
      exchange,
      stockCode,
      companyName,
      prospectusUrl: prospectusUrl || announcementUrl || allotmentUrl || null,
      alertSent: false,
      rawData: {
        announcementUrl,
        prospectusUrl,
        allotmentUrl,
        scrapedAt: new Date().toISOString(),
      },
    });
  });

  console.log(`[IPO] Found ${filings.length} entries on HKEX ${board}`);
  return filings;
}

// ---------------------------------------------------------------------------
// SGX Scrapers
// ---------------------------------------------------------------------------

/**
 * Scrapes SGX IPO prospectus page. SGX is JS-rendered but we'll try fetching
 * the API endpoint that the frontend uses instead of needing Playwright.
 */
async function scrapeSgx(): Promise<InsertIpoFiling[]> {
  // SGX has a public API endpoint that returns IPO data as JSON
  const url = "https://api.sgx.com/ipo/v1/prospectus?pagestart=0&pagesize=20&ordertype=desc";
  console.log(`[IPO] Fetching SGX API: ${url}`);

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
        "Accept": "application/json",
      },
    });

    if (!res.ok) {
      console.warn(`[IPO] SGX API returned ${res.status}, trying HTML fallback`);
      return await scrapeSgxHtml();
    }

    const data = await res.json() as any;
    const filings: InsertIpoFiling[] = [];

    const items = data?.data?.rows || data?.data || [];
    for (const item of items) {
      const stockCode = item.stockCode || item.stock_code || "";
      const companyName = item.companyName || item.company_name || item.name || "";
      if (!companyName) continue;

      filings.push({
        exchange: "sgx" as IpoExchange,
        stockCode: stockCode || "N/A",
        companyName,
        prospectusUrl: item.prospectusUrl || item.url || null,
        listingDate: item.listingDate || item.listing_date || null,
        filingDate: item.filingDate || item.filing_date || null,
        alertSent: false,
        rawData: { ...item, scrapedAt: new Date().toISOString() },
      });
    }

    console.log(`[IPO] Found ${filings.length} entries on SGX`);
    return filings;
  } catch (err) {
    console.error("[IPO] SGX API error:", err);
    return await scrapeSgxHtml();
  }
}

/**
 * Fallback: scrape SGX HTML page directly (may not get all data if JS-rendered)
 */
async function scrapeSgxHtml(): Promise<InsertIpoFiling[]> {
  try {
    const res = await fetch("https://www.sgx.com/securities/ipo-prospectus", {
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" },
    });
    if (!res.ok) return [];

    const html = await res.text();
    const $ = cheerio.load(html);
    const filings: InsertIpoFiling[] = [];

    // Try to parse any table rows we can find
    $("table tbody tr").each((_i, row) => {
      const tds = $(row).find("td");
      if (tds.length < 2) return;

      const companyName = $(tds[0]).text().trim();
      const prospectusUrl = $(tds[0]).find("a").attr("href") || null;
      if (!companyName) return;

      filings.push({
        exchange: "sgx" as IpoExchange,
        stockCode: "N/A",
        companyName,
        prospectusUrl,
        alertSent: false,
        rawData: { scrapedAt: new Date().toISOString() },
      });
    });

    console.log(`[IPO] Found ${filings.length} entries on SGX (HTML fallback)`);
    return filings;
  } catch (err) {
    console.error("[IPO] SGX HTML fallback error:", err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// IDX (Indonesia Stock Exchange) Scraper
// ---------------------------------------------------------------------------

/**
 * Scrapes IDX IPO data. IDX main site is behind Cloudflare, so we use
 * ScrapingBee if available, otherwise skip gracefully.
 */
async function scrapeIdx(): Promise<InsertIpoFiling[]> {
  const scrapingBeeKey = process.env.SCRAPINGBEE_API_KEY;

  if (!scrapingBeeKey) {
    console.log("[IPO] IDX: ScrapingBee not configured, skipping (Cloudflare-protected)");
    return [];
  }

  const targetUrl = "https://www.idx.co.id/en/listed-companies/ipo-prospectus/";
  console.log(`[IPO] Fetching IDX via ScrapingBee: ${targetUrl}`);

  try {
    const params = new URLSearchParams({
      api_key: scrapingBeeKey,
      url: targetUrl,
      render_js: "true",
      wait: "3000",
    });

    const res = await fetch(`https://app.scrapingbee.com/api/v1/?${params}`, {
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      console.warn(`[IPO] IDX ScrapingBee returned ${res.status}`);
      return [];
    }

    const html = await res.text();
    const $ = cheerio.load(html);
    const filings: InsertIpoFiling[] = [];

    // IDX IPO page typically has a table with company names and prospectus links
    $("table tbody tr").each((_i, row) => {
      const tds = $(row).find("td");
      if (tds.length < 2) return;

      const companyName = $(tds[0]).text().trim() || $(tds[1]).text().trim();
      const stockCode = $(tds[0]).text().trim().match(/^\w+$/)?.[0] || "N/A";
      const prospectusUrl = $(row).find("a[href*='pdf']").attr("href") ||
                           $(row).find("a").first().attr("href") || null;
      if (!companyName) return;

      filings.push({
        exchange: "idx" as IpoExchange,
        stockCode,
        companyName,
        prospectusUrl: prospectusUrl?.startsWith("http") ? prospectusUrl : prospectusUrl ? `https://www.idx.co.id${prospectusUrl}` : null,
        alertSent: false,
        rawData: { scrapedAt: new Date().toISOString() },
      });
    });

    console.log(`[IPO] Found ${filings.length} entries on IDX`);
    return filings;
  } catch (err: any) {
    console.error("[IPO] IDX scrape error:", err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// PSE (Philippine Stock Exchange) Scraper
// ---------------------------------------------------------------------------

/**
 * Scrapes PSE for recently listed companies via edge.pse.com.ph API.
 * Fetches all pages and filters for companies listed in the last 12 months.
 */
async function scrapePse(): Promise<InsertIpoFiling[]> {
  console.log("[IPO] Fetching PSE company directory...");
  const filings: InsertIpoFiling[] = [];
  const cutoffDate = new Date();
  cutoffDate.setFullYear(cutoffDate.getFullYear() - 1); // Last 12 months

  try {
    // PSE edge API returns paginated HTML fragments via POST
    for (let page = 1; page <= 6; page++) {
      const res = await fetch("https://edge.pse.com.ph/companyDirectory/search.ax", {
        method: "POST",
        headers: {
          "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `keyword=&sector=&subsector=&listingBoardId=&sortType=0&dateSortType=desc&pageNo=${page}`,
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        console.warn(`[IPO] PSE page ${page} returned ${res.status}`);
        break;
      }

      const html = await res.text();
      const $ = cheerio.load(html);

      $("table.list tbody tr").each((_i, row) => {
        const tds = $(row).find("td");
        if (tds.length < 5) return;

        const companyName = $(tds[0]).text().trim();
        const stockCode = $(tds[1]).text().trim();
        const sector = $(tds[2]).text().trim();
        const listingDateStr = $(tds[4]).text().trim();
        if (!companyName || !listingDateStr) return;

        // Parse listing date and filter for recent
        const listingDate = new Date(listingDateStr);
        if (isNaN(listingDate.getTime()) || listingDate < cutoffDate) return;

        filings.push({
          exchange: "pse" as IpoExchange,
          stockCode: stockCode || "N/A",
          companyName,
          industry: sector || null,
          listingDate: listingDateStr,
          alertSent: false,
          rawData: {
            sector,
            listingDate: listingDateStr,
            scrapedAt: new Date().toISOString(),
          },
        });
      });

      // Rate-limit between pages
      await new Promise((r) => setTimeout(r, 500));
    }

    console.log(`[IPO] Found ${filings.length} recent entries on PSE`);
    return filings;
  } catch (err: any) {
    console.error("[IPO] PSE scrape error:", err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Check if an IPO filing already exists in the database
 */
async function filingExists(exchange: IpoExchange, stockCode: string, companyName: string): Promise<boolean> {
  const existing = await db
    .select({ id: ipoFilings.id })
    .from(ipoFilings)
    .where(
      and(
        eq(ipoFilings.exchange, exchange),
        eq(ipoFilings.stockCode, stockCode),
        eq(ipoFilings.companyName, companyName)
      )
    )
    .limit(1);

  return existing.length > 0;
}

// ---------------------------------------------------------------------------
// GPT-4o Prospectus Analysis
// ---------------------------------------------------------------------------

interface ProspectusAnalysis {
  industry: string | null;
  proposedValuation: string | null;
  revenue: string | null;
  profit: string | null;
  founders: string | null;
  underwriters: string | null;
  sponsors: string | null;
  listingDate: string | null;
  lockupExpiration: string | null;
}

/**
 * Fetches prospectus page content and extracts key data via GPT-4o.
 * For PDFs we fetch the first chunk of text; for HTML pages we use cheerio.
 */
async function analyzeProspectus(filing: IpoFiling): Promise<ProspectusAnalysis | null> {
  if (!filing.prospectusUrl) return null;

  try {
    // Fetch prospectus page/content
    const url = filing.prospectusUrl.startsWith("http")
      ? filing.prospectusUrl
      : `https://www1.hkexnews.hk${filing.prospectusUrl}`;

    console.log(`[IPO] Analyzing prospectus for ${filing.companyName}: ${url}`);

    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      console.warn(`[IPO] Failed to fetch prospectus (${res.status}): ${url}`);
      return null;
    }

    const contentType = res.headers.get("content-type") || "";
    let textContent: string;

    if (contentType.includes("pdf")) {
      // For PDFs, we can't easily parse — use the company name + exchange context
      // and ask GPT to do a web search style analysis
      textContent = `[PDF prospectus at ${url}]\nCompany: ${filing.companyName}\nExchange: ${filing.exchange}\nStock Code: ${filing.stockCode}`;
    } else {
      const html = await res.text();
      const $ = cheerio.load(html);
      // Remove scripts, styles
      $("script, style, nav, header, footer").remove();
      textContent = $("body").text().replace(/\s+/g, " ").trim().slice(0, 15_000);
    }

    if (textContent.length < 50) {
      console.warn(`[IPO] Prospectus content too short for ${filing.companyName}`);
      return null;
    }

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: `You are an IPO filing analyst. Extract key information from prospectus content.
Return a JSON object with these fields (use null if not found):
- industry: string (sector/industry of the company)
- proposedValuation: string (proposed market cap or valuation, with currency)
- revenue: string (most recent full-year revenue, with currency)
- profit: string (most recent full-year net profit/loss, with currency)
- founders: string (founder names, comma-separated)
- underwriters: string (underwriter/joint bookrunner names, comma-separated)
- sponsors: string (sponsor names, comma-separated)
- listingDate: string (expected or actual listing date)
- lockupExpiration: string (lock-up period end date or duration)

Return ONLY valid JSON, no markdown.`,
        },
        {
          role: "user",
          content: `Analyze this IPO filing:\n\nCompany: ${filing.companyName}\nExchange: ${filing.exchange}\nStock Code: ${filing.stockCode}\n\nProspectus Content:\n${textContent}`,
        },
      ],
    });

    const raw = response.choices[0]?.message?.content?.trim();
    if (!raw) return null;

    // Parse JSON (handle potential markdown wrapping)
    const jsonStr = raw.replace(/^```json\s*/, "").replace(/```\s*$/, "").trim();
    const parsed = JSON.parse(jsonStr) as ProspectusAnalysis;
    console.log(`[IPO] Analysis complete for ${filing.companyName}: industry=${parsed.industry}`);
    return parsed;
  } catch (err: any) {
    console.error(`[IPO] Prospectus analysis failed for ${filing.companyName}:`, err.message);
    return null;
  }
}

/**
 * Enriches new filings with GPT-4o analysis and updates the database.
 */
async function enrichFilings(filings: IpoFiling[]): Promise<void> {
  for (const filing of filings) {
    try {
      const analysis = await analyzeProspectus(filing);
      if (!analysis) continue;

      await db
        .update(ipoFilings)
        .set({
          industry: analysis.industry,
          proposedValuation: analysis.proposedValuation,
          revenue: analysis.revenue,
          profit: analysis.profit,
          founders: analysis.founders,
          underwriters: analysis.underwriters,
          sponsors: analysis.sponsors,
          listingDate: analysis.listingDate || filing.listingDate,
          lockupExpiration: analysis.lockupExpiration,
          updatedAt: new Date(),
        })
        .where(eq(ipoFilings.id, filing.id));

      // Re-read the filing so alert uses enriched data
      const updated = await getIpoFilingById(filing.id);
      if (updated) {
        Object.assign(filing, updated);
      }

      // Rate-limit: wait 2s between analyses
      await new Promise((r) => setTimeout(r, 2000));
    } catch (err: any) {
      console.error(`[IPO] Enrichment failed for ${filing.companyName}:`, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Telegram Alerts (Enhanced)
// ---------------------------------------------------------------------------

/**
 * Send Telegram alert for new IPO filings with enriched data
 */
async function sendIpoAlert(filings: IpoFiling[]): Promise<void> {
  const settings = await storage.getSettings();
  if (!settings?.telegramEnabled || !settings?.telegramChatId) {
    console.log("[IPO] Telegram not configured, skipping alerts");
    return;
  }

  for (const filing of filings) {
    const exchangeLabel =
      filing.exchange === "hkex_main" ? "HKEX Main Board" :
      filing.exchange === "hkex_gem" ? "HKEX GEM" :
      filing.exchange === "idx" ? "IDX (Indonesia)" :
      filing.exchange === "pse" ? "PSE (Philippines)" : "SGX";

    const icon = "🆕";

    // Build enriched details
    const details: string[] = [];
    details.push(`📊 Exchange: ${exchangeLabel}`);
    details.push(`🔢 Stock Code: ${filing.stockCode}`);
    if (filing.industry) details.push(`🏭 Industry: ${filing.industry}`);
    if (filing.proposedValuation) details.push(`💰 Valuation: ${filing.proposedValuation}`);
    if (filing.revenue) details.push(`📈 Revenue: ${filing.revenue}`);
    if (filing.profit) details.push(`📊 Profit: ${filing.profit}`);
    if (filing.founders) details.push(`👤 Founders: ${filing.founders}`);
    if (filing.underwriters) details.push(`🏦 Underwriters: ${filing.underwriters}`);
    if (filing.sponsors) details.push(`📋 Sponsors: ${filing.sponsors}`);
    if (filing.listingDate) details.push(`📅 Listing Date: ${filing.listingDate}`);
    if (filing.lockupExpiration) details.push(`🔒 Lock-up Expires: ${filing.lockupExpiration}`);

    const prospectusLink = filing.prospectusUrl
      ? `\n📄 <a href="${filing.prospectusUrl.startsWith("http") ? filing.prospectusUrl : "https://www1.hkexnews.hk" + filing.prospectusUrl}">View Prospectus</a>`
      : "";

    const message = `${icon} <b>New IPO Filing Detected</b>

<b>${filing.companyName}</b>
${details.join("\n")}${prospectusLink}

<i>Detected by IPO Scanner</i>`;

    try {
      await sendTelegramMessage(settings.telegramChatId, message);
      // Mark alert as sent
      await db
        .update(ipoFilings)
        .set({ alertSent: true })
        .where(eq(ipoFilings.id, filing.id));
    } catch (err) {
      console.error(`[IPO] Failed to send Telegram alert for ${filing.companyName}:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Main Scan Function
// ---------------------------------------------------------------------------

/**
 * Main IPO scan function - scrapes all exchanges, enriches with GPT-4o, and stores new filings
 */
export async function scanForIpoFilings(): Promise<{
  newFilings: number;
  totalScanned: number;
  errors: string[];
}> {
  console.log("[IPO] Starting IPO filings scan...");
  const startTime = Date.now();
  const errors: string[] = [];
  let totalScanned = 0;
  const newFilingsList: IpoFiling[] = [];

  // Scrape all sources
  const sources: { name: string; fn: () => Promise<InsertIpoFiling[]> }[] = [
    { name: "HKEX Main Board", fn: () => scrapeHkex("Main-Board") },
    { name: "HKEX GEM", fn: () => scrapeHkex("GEM") },
    { name: "SGX", fn: scrapeSgx },
    { name: "IDX", fn: scrapeIdx },
    { name: "PSE", fn: scrapePse },
  ];

  for (const source of sources) {
    try {
      const filings = await source.fn();
      totalScanned += filings.length;

      for (const filing of filings) {
        const exists = await filingExists(filing.exchange! as IpoExchange, filing.stockCode!, filing.companyName!);
        if (!exists) {
          const [inserted] = await db.insert(ipoFilings).values({ ...filing, exchange: filing.exchange as IpoExchange }).returning();
          newFilingsList.push(inserted);
          console.log(`[IPO] New filing: ${filing.companyName} (${filing.exchange})`);
        }
      }
    } catch (err: any) {
      const errMsg = `${source.name}: ${err.message}`;
      console.error(`[IPO] Error scanning ${source.name}:`, err);
      errors.push(errMsg);
    }
  }

  // Enrich new filings with GPT-4o analysis before sending alerts
  if (newFilingsList.length > 0) {
    console.log(`[IPO] Enriching ${newFilingsList.length} new filings with GPT-4o...`);
    await enrichFilings(newFilingsList);
    await sendIpoAlert(newFilingsList);
  }

  const duration = Date.now() - startTime;
  console.log(
    `[IPO] Scan complete in ${duration}ms: ${totalScanned} scanned, ${newFilingsList.length} new, ${errors.length} errors`
  );

  return {
    newFilings: newFilingsList.length,
    totalScanned,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Query Functions
// ---------------------------------------------------------------------------

/**
 * Get all IPO filings from the database
 */
export async function getAllIpoFilings(exchangeFilter?: IpoExchange): Promise<IpoFiling[]> {
  if (exchangeFilter) {
    return db
      .select()
      .from(ipoFilings)
      .where(eq(ipoFilings.exchange, exchangeFilter))
      .orderBy(desc(ipoFilings.createdAt));
  }
  return db.select().from(ipoFilings).orderBy(desc(ipoFilings.createdAt));
}

/**
 * Get IPO filing by ID
 */
export async function getIpoFilingById(id: string): Promise<IpoFiling | undefined> {
  const [filing] = await db.select().from(ipoFilings).where(eq(ipoFilings.id, id)).limit(1);
  return filing;
}

/**
 * Re-analyze un-enriched filings (backfill). Useful for filings that were
 * inserted before the GPT-4o analysis was added.
 */
export async function backfillIpoAnalysis(limit = 10): Promise<number> {
  const unenriched = await db
    .select()
    .from(ipoFilings)
    .where(isNull(ipoFilings.industry))
    .orderBy(desc(ipoFilings.createdAt))
    .limit(limit);

  if (unenriched.length === 0) return 0;

  console.log(`[IPO] Backfilling ${unenriched.length} un-enriched filings...`);
  await enrichFilings(unenriched);
  return unenriched.length;
}
